// Compare mode: has the API changed since the recording was made?
//
// Values are expected to differ between a recording and a live call (ids, timestamps, the
// data itself). What should not differ is the shape: which fields exist and what types they
// hold. So the comparison is structural.

import { bodyText, header } from "./body";
import type { Difference, RecordedResponse } from "./types";

type Shape = string | { [key: string]: Shape } | Shape[];

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const MAX_DIFFERENCES = 50;

function compare(recorded: unknown, live: unknown, path: string, out: Difference[]): void {
  if (out.length >= MAX_DIFFERENCES) return;
  const a = typeOf(recorded);
  const b = typeOf(live);
  if (a !== b) {
    // A field that was null in one and filled in the other is how optional fields look, not drift.
    if (a !== "null" && b !== "null") out.push({ path: path || "(body)", kind: "type", recorded: a, live: b });
    return;
  }
  if (a === "array") {
    // Arrays are compared by the shape of their first element: lists differ in length all the time.
    const [x] = recorded as unknown[];
    const [y] = live as unknown[];
    if (x !== undefined && y !== undefined) compare(x, y, `${path}[]`, out);
    return;
  }
  if (a === "object") {
    const x = recorded as Record<string, unknown>;
    const y = live as Record<string, unknown>;
    for (const key of Object.keys(x)) {
      const next = path ? `${path}.${key}` : key;
      if (!(key in y)) out.push({ path: next, kind: "removed", recorded: typeOf(x[key]) });
      else compare(x[key], y[key], next, out);
    }
    for (const key of Object.keys(y)) if (!(key in x)) out.push({ path: path ? `${path}.${key}` : key, kind: "added", live: typeOf(y[key]) });
  }
}

const mediaType = (value: string | undefined) => (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

export function differences(recorded: RecordedResponse, live: RecordedResponse): Difference[] {
  const out: Difference[] = [];
  if (recorded.status !== live.status) out.push({ path: "status", kind: "status", recorded: String(recorded.status), live: String(live.status) });
  const was = mediaType(header(recorded.headers, "content-type"));
  const now = mediaType(header(live.headers, "content-type"));
  if (was !== now) out.push({ path: "content-type", kind: "content-type", recorded: was || "(none)", live: now || "(none)" });
  if (!/json/.test(was) || !/json/.test(now)) return out;
  try {
    compare(JSON.parse(bodyText(recorded.body)), JSON.parse(bodyText(live.body)), "", out);
  } catch {
    // One of them is not the JSON it claims to be; the status and type lines are all there is to say.
  }
  return out;
}

export type { Shape };
