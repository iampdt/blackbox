// What the parts say to each other: the page-side interceptor, the bridge beside it, the
// background worker that owns the recordings, and the panel.

import type { Config, DriftEvent, Exchange, Mode, Recording, ReplayEvent, ReplayOptions } from "../core/types";

/** What Blackbox is doing on one site. A site is an origin: scheme, host and port. */
export interface SiteState {
  origin: string;
  /** Whether Blackbox's scripts are injected into this site's pages at all. */
  enabled: boolean;
  mode: Mode;
  /** The recording being written (record) or read (replay, compare). */
  recordingId: string | null;
  options: ReplayOptions;
  /** Names the current run through the recording; a new one starts the recording from its beginning. */
  session: string;
}

/** Where the background worker leaves each site's instructions for the scripts in its pages. */
export const configKey = (origin: string) => `config:${origin}`;

export interface RecordingMeta {
  id: string;
  name: string;
  origin: string;
  createdAt: number;
  count: number;
  bytes: number;
}

/** Pushed to an open panel as things happen. */
export type LiveEvent =
  | { type: "exchange"; recordingId: string; exchange: Exchange }
  | { type: "replay"; event: ReplayEvent }
  | { type: "drift"; event: DriftEvent }
  | { type: "state"; state: SiteState }
  | { type: "recordings" }
  /** The link to the backend was lost and is back: anything may have been missed, so read everything again. */
  | { type: "resync" };

/** Between the interceptor in the page and the bridge next to it, over window.postMessage. */
export type PageMessage =
  | { source: "blackbox-page"; type: "hello" }
  | { source: "blackbox-page"; type: "exchange"; exchange: Omit<Exchange, "seq"> }
  | { source: "blackbox-page"; type: "replay"; event: ReplayEvent }
  | { source: "blackbox-page"; type: "drift"; event: DriftEvent }
  | { source: "blackbox-bridge"; type: "config"; config: Config };

/** To the background worker. */
export type WorkerRequest =
  | { type: "site.get"; origin: string }
  | { type: "site.enable"; origin: string }
  | { type: "site.disable"; origin: string }
  | { type: "site.mode"; origin: string; mode: Mode; recordingId?: string | null; name?: string }
  | { type: "site.options"; origin: string; options: ReplayOptions }
  | { type: "rec.list"; origin?: string }
  | { type: "rec.get"; id: string }
  | { type: "rec.rename"; id: string; name: string }
  | { type: "rec.delete"; id: string }
  | { type: "rec.import"; recording: Recording }
  | { type: "page.exchange"; exchange: Omit<Exchange, "seq"> }
  | { type: "page.replay"; event: ReplayEvent }
  | { type: "page.drift"; event: DriftEvent };

/**
 * Everything the panel needs from whatever is hosting it. In the extension that is the
 * background worker; on the demo site it is a small in-page implementation.
 */
export interface Backend {
  origin: string;
  state(): Promise<SiteState>;
  enable(): Promise<SiteState>;
  disable(): Promise<SiteState>;
  /** Switching to "record" with no recordingId starts a new recording. */
  setMode(mode: Mode, recordingId?: string | null, name?: string): Promise<SiteState>;
  setOptions(options: ReplayOptions): Promise<SiteState>;
  recordings(): Promise<RecordingMeta[]>;
  recording(id: string): Promise<Recording | null>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  importRecording(recording: Recording): Promise<RecordingMeta>;
  subscribe(listener: (event: LiveEvent) => void): () => void;
  /** Reload the page being recorded, where the host can. */
  reload?(): void;
}

export function metaOf(recording: Recording): RecordingMeta {
  let bytes = 0;
  for (const exchange of recording.exchanges) bytes += exchangeBytes(exchange);
  return { id: recording.id, name: recording.name, origin: recording.origin, createdAt: recording.createdAt, count: recording.exchanges.length, bytes };
}

export function exchangeBytes(exchange: Pick<Exchange, "request" | "response">): number {
  return exchange.request.body.data.length + (exchange.response?.body.data.length ?? 0);
}
