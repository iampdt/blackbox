// Deciding which recorded answer a request gets.
//
// A request is reduced to a key at three levels of strictness. Recorded exchanges are filed
// under their keys; a new request takes the strictest level at which anything is filed.
//
//   exact    method, URL with its query sorted, and the whole body
//   relaxed  the same, minus the query parameters and JSON fields listed as volatile
//   loose    method and path only (off unless asked for)
//
// The same request is often recorded more than once with different answers: a list fetched,
// an item added, the list fetched again. So each key keeps its answers in recorded order and
// a cursor: the nth request gets the nth answer, and once they run out the last one repeats.

import { bodyText, header } from "./body";
import type { Exchange, MatchLevel, MatchOptions, RecordedRequest } from "./types";

/** A small, fast, synchronous hash (cyrb53). Keys only need to be unlikely to collide. */
export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** JSON with object keys sorted and the named fields removed at every depth. */
export function canonicalJson(value: unknown, drop: ReadonlySet<string>): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) if (!drop.has(key)) out[key] = walk((node as Record<string, unknown>)[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

function sortedParams(params: URLSearchParams, drop: ReadonlySet<string>): string {
  return [...params]
    .filter(([name]) => !drop.has(name))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
}

function bodyKey(request: RecordedRequest, dropFields: ReadonlySet<string>, dropParams: ReadonlySet<string>): string {
  if (request.body.kind === "none") return "";
  if (request.body.kind === "base64") return hash(request.body.data);
  const text = bodyText(request.body);
  const type = header(request.headers, "content-type") ?? "";
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return hash(canonicalJson(JSON.parse(text), dropFields));
    } catch {
      // Not JSON after all: compare it as it is.
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return hash(sortedParams(new URLSearchParams(text), dropParams));
  // A browser picks a new random boundary for every multipart upload, so two identical forms
  // never have identical bytes. Compare them with the boundary taken out.
  const boundary = /multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(type)?.[2];
  if (boundary) return hash(text.split(boundary).join("BOUNDARY"));
  return hash(text);
}

const NONE: ReadonlySet<string> = new Set();

export function requestKey(request: RecordedRequest, options: MatchOptions, level: MatchLevel): string {
  const method = request.method.toUpperCase();
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return `${method} ${request.url}`;
  }
  const place = `${url.origin}${url.pathname}`;
  if (level === "loose") return `${method} ${place}`;
  const dropQuery = level === "relaxed" ? new Set(options.ignoreQuery) : NONE;
  const dropFields = level === "relaxed" ? new Set(options.ignoreBodyFields) : NONE;
  return `${method} ${place}?${sortedParams(url.searchParams, dropQuery)}#${bodyKey(request, dropFields, dropQuery)}`;
}

export interface Match {
  exchange: Exchange;
  level: MatchLevel;
  /** True when this answer had already been given and is being repeated. */
  repeated: boolean;
}

const LEVELS: MatchLevel[] = ["exact", "relaxed", "loose"];

export class Replayer {
  private readonly filed = new Map<string, Exchange[]>();
  private readonly cursors = new Map<string, number>();
  private hits = 0;
  private misses = 0;

  constructor(
    exchanges: Exchange[],
    private readonly options: MatchOptions,
    /** How many requests of each kind an earlier page in the same session had already answered. */
    resume: Record<string, number> = {},
  ) {
    for (const [key, asked] of Object.entries(resume)) this.cursors.set(key, asked);
    // Only exchanges that got an answer can answer. Failed ones are kept in the recording
    // for the record, not for replay.
    for (const exchange of exchanges) {
      if (!exchange.response) continue;
      for (const level of this.levels()) {
        const key = `${level}:${requestKey(exchange.request, options, level)}`;
        const list = this.filed.get(key);
        if (list) list.push(exchange);
        else this.filed.set(key, [exchange]);
      }
    }
  }

  private levels(): MatchLevel[] {
    return this.options.loose ? LEVELS : LEVELS.slice(0, 2);
  }

  /** The answer for this request, moving that kind of request's cursor on. Null for a miss. */
  next(request: RecordedRequest): Match | null {
    for (const level of this.levels()) {
      const key = `${level}:${requestKey(request, this.options, level)}`;
      const list = this.filed.get(key);
      if (!list) continue;
      // How many requests of this kind have already been answered.
      const asked = this.cursors.get(key) ?? 0;
      const index = this.options.sequence === "first" ? 0 : Math.min(asked, list.length - 1);
      const exchange = list[index];
      if (!exchange) continue;
      this.cursors.set(key, asked + 1);
      this.hits += 1;
      return { exchange, level, repeated: asked > index };
    }
    this.misses += 1;
    return null;
  }

  /** Where every kind of request has got to, for a later page in the same session to resume from. */
  position(): Record<string, number> {
    return Object.fromEntries(this.cursors);
  }

  /** Start again from the first answer of every kind. */
  rewind(): void {
    this.cursors.clear();
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
