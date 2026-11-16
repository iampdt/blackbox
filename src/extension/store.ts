// Recordings, kept in IndexedDB inside the extension. Nothing here is sent anywhere.
//
// A recording's requests are stored one row each rather than as one big value, so adding the
// thousandth request to a recording does not rewrite the 999 before it.

import type { Exchange, Recording } from "../core/types";
import { exchangeBytes, type RecordingMeta } from "../shared/protocol";

const DB = "blackbox";
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "id" });
      request.result.createObjectStore("exchanges", { keyPath: ["recordingId", "seq"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

const done = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((request.onsuccess = () => resolve(request.result)), (request.onerror = () => reject(request.error))));
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => ((tx.oncomplete = () => resolve()), (tx.onerror = () => reject(tx.error)), (tx.onabort = () => reject(tx.error))));
const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

export async function list(origin?: string): Promise<RecordingMeta[]> {
  const db = await open();
  const all = await done(db.transaction("recordings").objectStore("recordings").getAll() as IDBRequest<RecordingMeta[]>);
  return all.filter((meta) => !origin || meta.origin === origin).sort((a, b) => b.createdAt - a.createdAt);
}

export async function create(origin: string, name: string): Promise<RecordingMeta> {
  const meta: RecordingMeta = { id: crypto.randomUUID(), name, origin, createdAt: Date.now(), count: 0, bytes: 0 };
  const tx = (await open()).transaction("recordings", "readwrite");
  tx.objectStore("recordings").put(meta);
  await finished(tx);
  return meta;
}

/** Adds one request to a recording and returns it with its position. One transaction, so positions never collide. */
export async function append(recordingId: string, exchange: Omit<Exchange, "seq">): Promise<Exchange | null> {
  const tx = (await open()).transaction(["recordings", "exchanges"], "readwrite");
  const recordings = tx.objectStore("recordings");
  const meta = await done(recordings.get(recordingId) as IDBRequest<RecordingMeta | undefined>);
  if (!meta) return null;
  const stored: Exchange = { ...exchange, seq: meta.count };
  tx.objectStore("exchanges").put({ recordingId, ...stored });
  recordings.put({ ...meta, count: meta.count + 1, bytes: meta.bytes + exchangeBytes(stored) });
  await finished(tx);
  return stored;
}

export async function get(id: string): Promise<Recording | null> {
  const tx = (await open()).transaction(["recordings", "exchanges"]);
  const meta = await done(tx.objectStore("recordings").get(id) as IDBRequest<RecordingMeta | undefined>);
  if (!meta) return null;
  const rows = await done(tx.objectStore("exchanges").getAll(range(id)) as IDBRequest<(Exchange & { recordingId?: string })[]>);
  const exchanges = rows.map(({ recordingId: _, ...exchange }) => exchange as Exchange);
  return { version: 1, id: meta.id, name: meta.name, origin: meta.origin, createdAt: meta.createdAt, exchanges };
}

export async function rename(id: string, name: string): Promise<void> {
  const tx = (await open()).transaction("recordings", "readwrite");
  const store = tx.objectStore("recordings");
  const meta = await done(store.get(id) as IDBRequest<RecordingMeta | undefined>);
  if (meta) store.put({ ...meta, name });
  await finished(tx);
}

export async function remove(id: string): Promise<void> {
  const tx = (await open()).transaction(["recordings", "exchanges"], "readwrite");
  tx.objectStore("recordings").delete(id);
  tx.objectStore("exchanges").delete(range(id));
  await finished(tx);
}

export async function save(recording: Recording): Promise<RecordingMeta> {
  const tx = (await open()).transaction(["recordings", "exchanges"], "readwrite");
  let bytes = 0;
  recording.exchanges.forEach((exchange, seq) => {
    bytes += exchangeBytes(exchange);
    tx.objectStore("exchanges").put({ recordingId: recording.id, ...exchange, seq });
  });
  const meta: RecordingMeta = { id: recording.id, name: recording.name, origin: recording.origin, createdAt: recording.createdAt, count: recording.exchanges.length, bytes };
  tx.objectStore("recordings").put(meta);
  await finished(tx);
  return meta;
}
