// The recording format. One Exchange is one request the page made and what came back.

export interface Body {
  /** "base64" for anything that is not text. */
  kind: "none" | "text" | "base64";
  data: string;
  /** Size in bytes before any truncation. */
  size: number;
  /** True when the body was larger than the recorder keeps; `data` is then a prefix. */
  truncated?: boolean;
}

/** A piece of a streamed response and when it arrived, so a stream can be replayed at its own pace. */
export interface Chunk {
  /** Milliseconds after the response headers. */
  atMs: number;
  /** Text, or base64 when the body is. */
  data: string;
}

export type HeaderList = [name: string, value: string][];

export interface RecordedRequest {
  method: string;
  /** Absolute URL. */
  url: string;
  headers: HeaderList;
  body: Body;
}

export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: HeaderList;
  body: Body;
  /** Present when the body arrived in more than one piece over a noticeable time. */
  chunks?: Chunk[];
}

export interface Exchange {
  /** Position in the recording, starting at 0. */
  seq: number;
  via: "fetch" | "xhr";
  /** Milliseconds since the epoch. */
  startedAt: number;
  /** Time until the response headers arrived. */
  waitMs: number;
  /** Time until the body was complete. */
  totalMs: number;
  request: RecordedRequest;
  /** Absent when the request failed before any response (network error, abort). */
  response?: RecordedResponse;
  error?: string;
}

export interface Recording {
  version: 1;
  id: string;
  name: string;
  /** The page origin it was recorded on. A recording is only ever replayed to that origin. */
  origin: string;
  createdAt: number;
  exchanges: Exchange[];
}

export type Mode = "off" | "record" | "replay" | "compare";

export interface MatchOptions {
  /** Query parameters left out when comparing requests (cache-busters, timestamps). */
  ignoreQuery: string[];
  /** JSON body fields left out when comparing requests, at any depth. */
  ignoreBodyFields: string[];
  /** Fall back to method and path alone when nothing closer matches. */
  loose: boolean;
  /**
   * "ordered": the nth request of a kind gets the nth recorded answer, then the last one
   * repeats. "first": every request of a kind gets the first recorded answer.
   */
  sequence: "ordered" | "first";
}

export interface ReplayOptions extends MatchOptions {
  /** What a request with no recorded answer gets: a network error, or the real network. */
  unmatched: "block" | "network";
  /** Multiplier on recorded timings: 0 answers at once, 1 at the recorded pace. */
  speed: number;
}

export const DEFAULT_OPTIONS: ReplayOptions = {
  ignoreQuery: ["_", "t", "ts", "_t", "cb", "cachebust", "cache_bust", "nocache", "timestamp", "nonce", "rand", "random"],
  ignoreBodyFields: ["timestamp", "nonce", "requestId", "request_id", "clientTime", "sentAt", "idempotencyKey", "idempotency_key"],
  loose: false,
  sequence: "ordered",
  unmatched: "block",
  speed: 0,
};

/** What the page-side interceptor is told to do. */
export interface Config {
  mode: Mode;
  /** The recording to answer from (replay) or compare against (compare). */
  recording?: Recording;
  options: ReplayOptions;
  /** Bodies larger than this are kept as a truncated prefix. */
  maxBodyBytes: number;
  /**
   * Names one run through a recording. A page that reloads under the same session carries on
   * from where it was in the recording; a new session starts from the beginning.
   */
  session?: string;
}

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const OFF: Config = { mode: "off", options: DEFAULT_OPTIONS, maxBodyBytes: MAX_BODY_BYTES };

export type MatchLevel = "exact" | "relaxed" | "loose";

/** What replay did with one request. */
export interface ReplayEvent {
  at: number;
  method: string;
  url: string;
  /** The recorded exchange that answered, or null for a miss. */
  seq: number | null;
  level: MatchLevel | null;
  /** True when the same recorded answer had already been given and is being repeated. */
  repeated: boolean;
}

export interface Difference {
  path: string;
  kind: "added" | "removed" | "type" | "status" | "content-type";
  recorded?: string;
  live?: string;
}

/** What compare mode found for one request. */
export interface DriftEvent {
  at: number;
  method: string;
  url: string;
  /** The recorded exchange it was compared with, or null when there was none. */
  seq: number | null;
  differences: Difference[];
}
