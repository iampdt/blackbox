// Getting a recording out of the browser, and other people's recordings in.
//
//   HAR            the standard archive: opens in browser dev tools, and Playwright replays it
//                  with page.routeFromHAR
//   MSW handlers   a TypeScript file of Mock Service Worker handlers, for tests and local dev
//   JSON           this tool's own format, which is what Import reads back

import { bodyText, header, NO_BODY } from "./body";
import type { Body, Exchange, HeaderList, Recording } from "./types";

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; httpVersion: string; headers: HarHeader[]; queryString: HarHeader[]; cookies: []; headersSize: -1; bodySize: number; postData?: { mimeType: string; text: string } };
  response: { status: number; statusText: string; httpVersion: string; headers: HarHeader[]; cookies: []; content: { size: number; mimeType: string; text?: string; encoding?: "base64" }; redirectURL: string; headersSize: -1; bodySize: number };
  cache: Record<string, never>;
  timings: { send: 0; wait: number; receive: number };
}
export interface Har {
  log: { version: "1.2"; creator: { name: string; version: string }; pages?: unknown[]; entries: HarEntry[] };
}

const pairs = (headers: HeaderList): HarHeader[] => headers.map(([name, value]) => ({ name, value }));

function query(url: string): HarHeader[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function toHar(recording: Recording, version: string): Har {
  return {
    log: {
      version: "1.2",
      creator: { name: "Blackbox", version },
      entries: recording.exchanges.map((exchange): HarEntry => {
        const { request, response } = exchange;
        const type = response ? (header(response.headers, "content-type") ?? "") : "";
        return {
          startedDateTime: new Date(exchange.startedAt).toISOString(),
          time: exchange.totalMs,
          request: {
            method: request.method,
            url: request.url,
            httpVersion: "HTTP/1.1",
            headers: pairs(request.headers),
            queryString: query(request.url),
            cookies: [],
            headersSize: -1,
            bodySize: request.body.size,
            ...(request.body.kind !== "none" && { postData: { mimeType: header(request.headers, "content-type") ?? "application/octet-stream", text: bodyText(request.body) } }),
          },
          response: {
            // A request that never got a response is written the way browsers write it: status 0.
            status: response?.status ?? 0,
            statusText: response?.statusText ?? exchange.error ?? "",
            httpVersion: "HTTP/1.1",
            headers: pairs(response?.headers ?? []),
            cookies: [],
            content: {
              size: response?.body.size ?? 0,
              mimeType: type,
              ...(response && response.body.kind !== "none" && { text: response.body.data }),
              ...(response?.body.kind === "base64" && { encoding: "base64" as const }),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: response?.body.size ?? 0,
          },
          cache: {},
          timings: { send: 0, wait: exchange.waitMs, receive: Math.max(0, exchange.totalMs - exchange.waitMs) },
        };
      }),
    },
  };
}

function harBody(text: string | undefined, encoding: string | undefined, size: number): Body {
  if (!text) return NO_BODY;
  return encoding === "base64" ? { kind: "base64", data: text, size: size > 0 ? size : Math.floor((text.length * 3) / 4) } : { kind: "text", data: text, size: size > 0 ? size : text.length };
}

/** Reads a HAR saved from any browser's dev tools, keeping the fetch and XHR entries it can replay. */
export function fromHar(har: unknown, origin: string, name: string, id: string): Recording {
  const entries = (har as Partial<Har>)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("This is not a HAR file: it has no log.entries.");
  const exchanges: Exchange[] = [];
  for (const entry of entries as (HarEntry & { _resourceType?: string })[]) {
    if (!entry?.request?.url || !/^https?:/i.test(entry.request.url)) continue;
    // Dev tools record every resource; only API calls are of use here.
    if (entry._resourceType && !["fetch", "xhr"].includes(entry._resourceType)) continue;
    const headers = (list: HarHeader[] | undefined): HeaderList => (list ?? []).filter((h) => !h.name.startsWith(":")).map((h) => [h.name, h.value]);
    const wait = Math.max(0, Math.round(entry.timings?.wait ?? entry.time ?? 0));
    const total = Math.max(wait, Math.round(entry.time ?? wait));
    const failed = !entry.response || entry.response.status === 0;
    exchanges.push({
      seq: exchanges.length,
      via: entry._resourceType === "xhr" ? "xhr" : "fetch",
      startedAt: Date.parse(entry.startedDateTime) || 0,
      waitMs: wait,
      totalMs: total,
      request: {
        method: entry.request.method,
        url: entry.request.url,
        headers: headers(entry.request.headers),
        body: harBody(entry.request.postData?.text, undefined, entry.request.bodySize),
      },
      ...(failed
        ? { error: entry.response?.statusText || "failed" }
        : {
            response: {
              status: entry.response.status,
              statusText: entry.response.statusText,
              headers: headers(entry.response.headers).filter(([key]) => !/^content-(encoding|length)$/i.test(key)),
              body: harBody(entry.response.content?.text, entry.response.content?.encoding, entry.response.content?.size ?? 0),
            },
          }),
    });
  }
  return { version: 1, id, name, origin, createdAt: Date.now(), exchanges };
}

/** Reads this tool's own JSON export. */
export function fromJson(value: unknown, id: string): Recording {
  const recording = value as Partial<Recording>;
  if (recording?.version !== 1 || !Array.isArray(recording.exchanges) || typeof recording.origin !== "string") {
    throw new Error("This is not a Blackbox recording.");
  }
  return {
    version: 1,
    id,
    name: typeof recording.name === "string" ? recording.name : "Imported recording",
    origin: recording.origin,
    createdAt: typeof recording.createdAt === "number" ? recording.createdAt : Date.now(),
    exchanges: recording.exchanges.map((exchange, seq) => ({ ...exchange, seq })),
  };
}

const literal = (value: string) => JSON.stringify(value);

/**
 * Mock Service Worker handlers for a recording. A URL recorded more than once becomes one
 * handler that gives its answers in order and then repeats the last, the way replay does.
 */
export function toMsw(recording: Recording): string {
  const groups = new Map<string, Exchange[]>();
  for (const exchange of recording.exchanges) {
    if (!exchange.response) continue;
    let place = exchange.request.url;
    try {
      const url = new URL(exchange.request.url);
      place = `${url.origin}${url.pathname}`;
    } catch {
      // Keep the URL as recorded.
    }
    const key = `${exchange.request.method.toUpperCase()} ${place}`;
    groups.set(key, [...(groups.get(key) ?? []), exchange]);
  }
  const lines = [
    `// Generated by Blackbox from the recording ${literal(recording.name)} (${recording.exchanges.length} requests, ${recording.origin}).`,
    `// Each handler answers in recorded order and then repeats its last answer.`,
    `import { http, HttpResponse } from "msw";`,
    ``,
    `function inOrder(answers: (() => Response)[]): () => Response {`,
    `  let next = 0;`,
    `  return () => answers[Math.min(next++, answers.length - 1)]!();`,
    `}`,
    ``,
    `export const handlers = [`,
  ];
  for (const [key, exchanges] of groups) {
    const [method = "GET", place = ""] = key.split(" ");
    const verb = ["get", "post", "put", "patch", "delete", "head", "options"].includes(method.toLowerCase()) ? method.toLowerCase() : "all";
    lines.push(`  http.${verb}(${literal(place)}, inOrder([`);
    for (const exchange of exchanges) {
      const response = exchange.response;
      if (!response) continue;
      const headers = JSON.stringify(Object.fromEntries(response.headers.filter(([name]) => !/^content-(encoding|length)$/i.test(name))));
      const init = `{ status: ${response.status}, headers: ${headers} }`;
      const empty = response.body.kind === "none" || [204, 205, 304].includes(response.status);
      if (empty) lines.push(`    () => new HttpResponse(null, ${init}),`);
      else if (response.body.kind === "base64") lines.push(`    () => new HttpResponse(Uint8Array.from(atob(${literal(response.body.data)}), (c) => c.charCodeAt(0)), ${init}),`);
      else lines.push(`    () => new HttpResponse(${literal(response.body.data)}, ${init}),`);
    }
    lines.push(`  ])),`);
  }
  lines.push(`];`, ``);
  return lines.join("\n");
}
