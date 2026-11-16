// The part that runs inside the page: fetch and XMLHttpRequest are replaced with versions
// that can record what passes through them, answer from a recording instead of the network,
// or compare the network's answer with a recording.
//
// It is plain code with no dependency on browser extension APIs. The extension injects it
// into the page's own JavaScript world; the demo site loads it as an ordinary script; the
// tests run it in Node against stand-in fetch and XMLHttpRequest implementations.

import { bodyBytes, bodyFromBytes, bodyFromText, bodyText, header, isTextType, NO_BODY } from "./body";
import { differences } from "./drift";
import { Replayer } from "./match";
import type { Body, Chunk, Config, DriftEvent, Exchange, HeaderList, RecordedRequest, RecordedResponse, ReplayEvent } from "./types";

export interface Hooks {
  /** A finished request, in record mode. `seq` is assigned by whoever stores it. */
  onExchange(exchange: Omit<Exchange, "seq">): void;
  onReplay(event: ReplayEvent): void;
  onDrift(event: DriftEvent): void;
}

export interface Interceptor {
  /** Until this is first called, requests are held rather than sent: see `install`. */
  configure(config: Config): void;
  uninstall(): void;
}

/** The parts of a window this needs. A real window satisfies it; so does Node's global scope. */
export interface Host {
  fetch: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  Request: typeof Request;
  Response: typeof Response;
  Headers: typeof Headers;
  ReadableStream: typeof ReadableStream;
  Blob: typeof Blob;
  setTimeout: (handler: () => void, ms?: number) => unknown;
  performance: { now(): number };
  DOMParser?: typeof DOMParser;
  /** Where the position in a recording is kept across page reloads. Without it every page starts from the beginning. */
  sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** The one key Blackbox keeps in the page's session storage while replaying. */
export const POSITION_KEY = "blackbox:position";

/** Statuses a Response may not carry a body with. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
/** A stream is recorded piece by piece only when its pieces were spread over at least this long. */
const STREAM_SPAN_MS = 50;
/** If no configuration has arrived by now, stop holding requests and behave as if switched off. */
export const CONFIG_TIMEOUT_MS = 3000;

const headerList = (headers: Headers): HeaderList => [...headers.entries()];
const isHttp = (url: string) => /^https?:/i.test(url);
// The body of a replayed response is already decoded, so these two would be lies.
const replayHeaders = (headers: HeaderList): HeaderList => headers.filter(([name]) => !/^content-(encoding|length)$/i.test(name));

export function install(host: Host, hooks: Hooks): Interceptor {
  const nativeFetch = host.fetch;
  const NativeXHR = host.XMLHttpRequest;
  const now = () => host.performance.now();
  const sleep = (ms: number) => new Promise<void>((resolve) => (ms > 0 ? host.setTimeout(resolve, ms) : resolve()));

  // The page may start making requests before the extension has been able to say what mode
  // this site is in: that answer arrives by message, a few milliseconds after the page's
  // scripts start. Sending those first requests to the network would make replay miss
  // exactly the requests a page makes on load. So until the first configure(), requests wait.
  let config: Config | null = null;
  let replayer: Replayer | null = null;
  let release!: () => void;
  const configured = new Promise<void>((resolve) => (release = resolve));

  // A recording is a sequence: the third time the page asks for the list, it gets the third
  // list that was recorded. A reload must not send it back to the first, any more than
  // reloading a real page would undo what was done before it. So how far each kind of
  // request has got is kept where a reload does not reach, and picked up by the next page of
  // the same session.
  function resumePosition(session: string | undefined): Record<string, number> {
    try {
      const stored = JSON.parse(host.sessionStorage?.getItem(POSITION_KEY) ?? "null") as { session?: string; cursors?: Record<string, number> } | null;
      if (session && stored?.session === session && stored.cursors) return stored.cursors;
      host.sessionStorage?.removeItem(POSITION_KEY);
    } catch {
      // Storage is blocked or holds something else: start from the beginning.
    }
    return {};
  }
  function savePosition(): void {
    if (!config?.session || !replayer) return;
    try {
      host.sessionStorage?.setItem(POSITION_KEY, JSON.stringify({ session: config.session, cursors: replayer.position() }));
    } catch {
      // Losing the position costs a restart from the beginning after a reload, nothing worse.
    }
  }

  function configure(next: Config): void {
    const sameRun = config?.session !== undefined && config.session === next.session && config.mode === next.mode && replayer !== null;
    config = next;
    // Settings changing mid-run (a new speed, say) must not rewind the run.
    const resume = sameRun && replayer ? replayer.position() : resumePosition(next.session);
    replayer = next.recording && (next.mode === "replay" || next.mode === "compare") ? new Replayer(next.recording.exchanges, next.options, resume) : null;
    release();
  }
  host.setTimeout(() => {
    if (!config) configure({ mode: "off", options: { ignoreQuery: [], ignoreBodyFields: [], loose: false, sequence: "ordered", unmatched: "network", speed: 0 }, maxBodyBytes: 0 });
  }, CONFIG_TIMEOUT_MS);

  const report = <T>(send: (value: T) => void, value: T) => {
    try {
      send(value);
    } catch {
      // A failing listener must never break the page's own request.
    }
  };

  /** Reads a response body to the end, noting when each piece arrived. */
  async function capture(response: Response, maxBytes: number, startedAfterHeaders: number): Promise<{ body: Body; chunks?: Chunk[]; error?: string }> {
    const type = response.headers.get("content-type") ?? undefined;
    if (!response.body) return { body: NO_BODY };
    const reader = response.body.getReader();
    const pieces: { at: number; bytes: Uint8Array }[] = [];
    let size = 0;
    let kept = 0;
    let error: string | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        // Past the limit the stream is still drained, so the page's own copy is not held back.
        if (kept < maxBytes) {
          pieces.push({ at: now() - startedAfterHeaders, bytes: value });
          kept += value.length;
        }
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "the response body could not be read";
    }
    const all = new Uint8Array(kept);
    let offset = 0;
    for (const piece of pieces) {
      all.set(piece.bytes, offset);
      offset += piece.bytes.length;
    }
    const body = bodyFromBytes(all, type, maxBytes);
    if (size > body.size) body.size = size;
    if (size > maxBytes) body.truncated = true;
    const span = pieces.length > 1 ? (pieces.at(-1)?.at ?? 0) - (pieces[0]?.at ?? 0) : 0;
    if (body.kind !== "text" || span < STREAM_SPAN_MS || body.truncated) return { body, error };
    const decoder = new TextDecoder();
    const chunks = pieces.map((piece) => ({ atMs: Math.round(piece.at), data: decoder.decode(piece.bytes, { stream: true }) })).filter((chunk) => chunk.data.length > 0);
    return { body, chunks, error };
  }

  async function describe(request: Request, maxBytes: number): Promise<RecordedRequest> {
    let body: Body = NO_BODY;
    try {
      if (request.body) body = bodyFromBytes(new Uint8Array(await request.clone().arrayBuffer()), request.headers.get("content-type") ?? undefined, maxBytes);
    } catch {
      // A body that is itself a stream being written cannot be read ahead of time.
    }
    return { method: request.method.toUpperCase(), url: request.url, headers: headerList(request.headers), body };
  }

  function replayEvent(request: RecordedRequest, match: ReturnType<Replayer["next"]>): ReplayEvent {
    return { at: Date.now(), method: request.method, url: request.url, seq: match?.exchange.seq ?? null, level: match?.level ?? null, repeated: match?.repeated ?? false };
  }

  function buildResponse(exchange: Exchange, speed: number): Response {
    const recorded = exchange.response as RecordedResponse;
    const status = recorded.status >= 200 && recorded.status <= 599 ? recorded.status : 200;
    const headers = new host.Headers(replayHeaders(recorded.headers));
    let body: BodyInit | null = null;
    if (!NULL_BODY.has(status) && recorded.body.kind !== "none") {
      const chunks = recorded.chunks;
      if (chunks && chunks.length > 1 && speed > 0) {
        const encoder = new TextEncoder();
        let index = 0;
        let elapsed = 0;
        body = new host.ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = chunks[index++];
            if (!chunk) return controller.close();
            await sleep((chunk.atMs - elapsed) * speed);
            elapsed = chunk.atMs;
            controller.enqueue(encoder.encode(chunk.data));
          },
        });
      } else {
        body = bodyBytes(recorded.body);
      }
    }
    const response = new host.Response(body, { status, statusText: recorded.statusText, headers });
    // A constructed Response has an empty URL; code that reads response.url expects the real one.
    Object.defineProperty(response, "url", { value: exchange.request.url });
    return response;
  }

  // ── fetch ────────────────────────────────────────────────────────────────

  async function handleFetch(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
    const current = config as Config;
    if (current.mode === "off") return nativeFetch.call(host, input, init);
    let request: Request;
    try {
      request = new host.Request(input, init);
    } catch {
      // Whatever is wrong with the arguments, let the real fetch be the one to say so.
      return nativeFetch.call(host, input, init);
    }
    if (!isHttp(request.url)) return nativeFetch.call(host, request);

    const startedAt = Date.now();
    const t0 = now();
    const described = describe(request, current.maxBodyBytes);

    if (current.mode === "replay" && replayer) {
      const recorded = await described;
      const match = replayer.next(recorded);
        savePosition();
      report(hooks.onReplay, replayEvent(recorded, match));
      if (!match) {
        if (current.options.unmatched === "network") return nativeFetch.call(host, request);
        throw new TypeError(`Failed to fetch (Blackbox is replaying and has no recorded answer for ${recorded.method} ${recorded.url})`);
      }
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      await sleep(match.exchange.waitMs * current.options.speed);
      return buildResponse(match.exchange, current.options.speed);
    }

    let response: Response;
    try {
      response = await nativeFetch.call(host, request);
    } catch (failure) {
      if (current.mode === "record") {
        const error = failure instanceof Error ? failure.message : String(failure);
        void described.then((recorded) => report(hooks.onExchange, { via: "fetch", startedAt, waitMs: Math.round(now() - t0), totalMs: Math.round(now() - t0), request: recorded, error }));
      }
      throw failure;
    }

    const waitMs = Math.round(now() - t0);
    // An opaque response (a no-cors request to another site) shows the page nothing, so there is nothing to record.
    if (response.type === "opaque" || response.type === "opaqueredirect") {
      if (current.mode === "record") void described.then((recorded) => report(hooks.onExchange, { via: "fetch", startedAt, waitMs, totalMs: waitMs, request: recorded, error: "opaque response: the page itself cannot read it" }));
      return response;
    }

    let copy: Response;
    try {
      copy = response.clone();
    } catch {
      return response;
    }
    const afterHeaders = now();
    void Promise.all([described, capture(copy, current.maxBodyBytes, afterHeaders)]).then(([recorded, captured]) => {
      const live: RecordedResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: headerList(response.headers),
        body: captured.body,
        ...(captured.chunks && { chunks: captured.chunks }),
      };
      if (current.mode === "record") {
        report(hooks.onExchange, { via: "fetch", startedAt, waitMs, totalMs: Math.round(now() - t0), request: recorded, response: live, ...(captured.error && { error: captured.error }) });
      } else if (current.mode === "compare" && replayer) {
        const match = replayer.next(recorded);
        savePosition();
        report(hooks.onDrift, {
          at: Date.now(),
          method: recorded.method,
          url: recorded.url,
          seq: match?.exchange.seq ?? null,
          differences: match?.exchange.response ? differences(match.exchange.response, live) : [],
        });
      }
    });
    return response;
  }

  host.fetch = function blackboxFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (config) return handleFetch(input, init);
    return configured.then(() => handleFetch(input, init));
  };

  // ── XMLHttpRequest ───────────────────────────────────────────────────────

  let PatchedXHR: typeof XMLHttpRequest | undefined;
  if (NativeXHR) {
    type SendBody = Document | XMLHttpRequestBodyInit | null | undefined;

    async function bodyOf(body: SendBody, headers: HeaderList, maxBytes: number): Promise<Body> {
      if (body === null || body === undefined) return NO_BODY;
      if (typeof body === "string") return bodyFromText(body, maxBytes);
      if (body instanceof URLSearchParams) return bodyFromText(body.toString(), maxBytes);
      if (body instanceof ArrayBuffer) return bodyFromBytes(new Uint8Array(body), header(headers, "content-type"), maxBytes);
      if (ArrayBuffer.isView(body)) return bodyFromBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), header(headers, "content-type"), maxBytes);
      try {
        // Blobs and form data: let Response do the encoding the browser would do.
        const encoded = new host.Response(body as BodyInit);
        const type = header(headers, "content-type") ?? encoded.headers.get("content-type") ?? undefined;
        if (type && !header(headers, "content-type")) headers.push(["content-type", type]);
        return bodyFromBytes(new Uint8Array(await encoded.arrayBuffer()), type, maxBytes);
      } catch {
        return NO_BODY;
      }
    }

    function parseHeaders(raw: string): HeaderList {
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line): [string, string] => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
        });
    }

    interface Faked {
      readyState: number;
      status: number;
      statusText: string;
      headers: HeaderList;
      body: Body;
      url: string;
      /** How much of the body the page may see yet (replaying a stream). */
      visible: number;
    }

    class Patched extends NativeXHR {
      #method = "GET";
      #url = "";
      #async = true;
      #headers: HeaderList = [];
      #fake: Faked | null = null;
      #cancelled = false;

      override open(method: string, url: string | URL, async = true, user?: string | null, password?: string | null): void {
        this.#method = method.toUpperCase();
        this.#async = async !== false;
        this.#headers = [];
        this.#fake = null;
        this.#cancelled = false;
        try {
          this.#url = new URL(String(url), (host as unknown as { location?: { href: string } }).location?.href).href;
        } catch {
          this.#url = String(url);
        }
        super.open(method, url, async, user, password);
      }

      override setRequestHeader(name: string, value: string): void {
        this.#headers.push([name, value]);
        super.setRequestHeader(name, value);
      }

      override send(body?: SendBody): void {
        // A synchronous request cannot wait for anything, so it always goes to the network.
        if (!this.#async || !isHttp(this.#url)) return super.send(body);
        if (!config) {
          void configured.then(() => !this.#cancelled && this.#send(body));
          return;
        }
        this.#send(body);
      }

      #send(body: SendBody): void {
        const current = config as Config;
        if (current.mode === "off") return super.send(body);
        const headers = [...this.#headers];
        const request = bodyOf(body, headers, current.maxBodyBytes).then((recorded): RecordedRequest => ({ method: this.#method, url: this.#url, headers, body: recorded }));

        if (current.mode === "replay" && replayer) {
          const answering = replayer;
          void request.then((recorded) => {
            if (this.#cancelled) return;
            const match = answering.next(recorded);
            savePosition();
            report(hooks.onReplay, replayEvent(recorded, match));
            if (match) return void this.#play(match.exchange, current.options.speed);
            if (current.options.unmatched === "network") return super.send(body);
            this.#fake = { readyState: 4, status: 0, statusText: "", headers: [], body: NO_BODY, url: "", visible: 0 };
            this.#emit("readystatechange");
            this.#emit("error");
            this.#emit("loadend");
          });
          return;
        }

        const startedAt = Date.now();
        const t0 = now();
        let waitMs = 0;
        this.addEventListener("readystatechange", () => {
          if (super.readyState === 2 && !waitMs) waitMs = Math.round(now() - t0);
        });
        this.addEventListener("loadend", () => {
          void Promise.all([request, this.#recordedResponse(current.maxBodyBytes)]).then(([recorded, live]) => {
            const totalMs = Math.round(now() - t0);
            if (current.mode === "record") {
              report(hooks.onExchange, live ? { via: "xhr", startedAt, waitMs: waitMs || totalMs, totalMs, request: recorded, response: live } : { via: "xhr", startedAt, waitMs: totalMs, totalMs, request: recorded, error: "the request failed or was aborted" });
            } else if (current.mode === "compare" && replayer && live) {
              const match = replayer.next(recorded);
        savePosition();
              report(hooks.onDrift, { at: Date.now(), method: recorded.method, url: recorded.url, seq: match?.exchange.seq ?? null, differences: match?.exchange.response ? differences(match.exchange.response, live) : [] });
            }
          });
        });
        super.send(body);
      }

      /** What the real request returned, read out of this object after it finished. */
      async #recordedResponse(maxBytes: number): Promise<RecordedResponse | null> {
        if (super.status === 0) return null;
        const headers = parseHeaders(super.getAllResponseHeaders());
        const type = header(headers, "content-type");
        let body: Body = NO_BODY;
        try {
          const kind = super.responseType;
          if (kind === "" || kind === "text") body = bodyFromText(super.responseText, maxBytes);
          else if (kind === "json") body = super.response === null ? NO_BODY : bodyFromText(JSON.stringify(super.response), maxBytes);
          else if (kind === "arraybuffer") body = bodyFromBytes(new Uint8Array(super.response as ArrayBuffer), type, maxBytes);
          else if (kind === "blob") body = bodyFromBytes(new Uint8Array(await (super.response as Blob).arrayBuffer()), type, maxBytes);
          else if (kind === "document") body = bodyFromText((super.response as Document | null)?.documentElement?.outerHTML ?? "", maxBytes);
        } catch {
          // Leave the body empty rather than lose the whole exchange.
        }
        return { status: super.status, statusText: super.statusText, headers, body };
      }

      #emit(type: string): void {
        const Progress = (globalThis as { ProgressEvent?: typeof ProgressEvent }).ProgressEvent;
        const total = this.#fake?.body.size ?? 0;
        // `visible` is Infinity once the whole body is out, and a progress event refuses that.
        const loaded = Math.min(this.#fake?.visible ?? 0, total);
        const event = type === "readystatechange" || !Progress ? new Event(type) : new Progress(type, { lengthComputable: true, loaded, total });
        this.dispatchEvent(event);
      }

      /** Walks this object through the states a real request goes through, with the recorded answer. */
      async #play(exchange: Exchange, speed: number): Promise<void> {
        const recorded = exchange.response as RecordedResponse;
        this.#emit("loadstart");
        await sleep(exchange.waitMs * speed);
        if (this.#cancelled) return;
        const fake: Faked = { readyState: 2, status: recorded.status, statusText: recorded.statusText, headers: replayHeaders(recorded.headers), body: recorded.body, url: exchange.request.url, visible: 0 };
        this.#fake = fake;
        this.#emit("readystatechange");
        fake.readyState = 3;
        const chunks = recorded.chunks;
        if (chunks && chunks.length > 1 && speed > 0 && recorded.body.kind === "text") {
          let elapsed = 0;
          for (const chunk of chunks) {
            await sleep((chunk.atMs - elapsed) * speed);
            if (this.#cancelled) return;
            elapsed = chunk.atMs;
            fake.visible += chunk.data.length;
            this.#emit("readystatechange");
            this.#emit("progress");
          }
        } else {
          await sleep((exchange.totalMs - exchange.waitMs) * speed);
          if (this.#cancelled) return;
        }
        fake.visible = Infinity;
        this.#emit("readystatechange");
        this.#emit("progress");
        fake.readyState = 4;
        this.#emit("readystatechange");
        this.#emit("load");
        this.#emit("loadend");
      }

      override abort(): void {
        const wasFaking = this.#fake !== null && this.#fake.readyState < 4;
        this.#cancelled = true;
        if (wasFaking) {
          this.#fake = { readyState: 0, status: 0, statusText: "", headers: [], body: NO_BODY, url: "", visible: 0 };
          this.#emit("abort");
          this.#emit("loadend");
          return;
        }
        super.abort();
      }

      override get readyState(): number {
        return this.#fake ? this.#fake.readyState : super.readyState;
      }
      override get status(): number {
        return this.#fake ? (this.#fake.readyState >= 2 ? this.#fake.status : 0) : super.status;
      }
      override get statusText(): string {
        return this.#fake ? this.#fake.statusText : super.statusText;
      }
      override get responseURL(): string {
        return this.#fake ? this.#fake.url : super.responseURL;
      }
      override get responseText(): string {
        if (!this.#fake) return super.responseText;
        const text = bodyText(this.#fake.body);
        return this.#fake.readyState < 3 ? "" : text.slice(0, this.#fake.visible);
      }
      override get response(): unknown {
        if (!this.#fake) return super.response;
        const fake = this.#fake;
        const kind = super.responseType;
        if (kind === "" || kind === "text") return this.responseText;
        if (fake.readyState < 4) return null;
        if (kind === "json") {
          try {
            return JSON.parse(bodyText(fake.body)) as unknown;
          } catch {
            return null;
          }
        }
        const bytes = bodyBytes(fake.body);
        if (kind === "arraybuffer") return bytes.buffer;
        if (kind === "blob") return new host.Blob([bytes], { type: header(fake.headers, "content-type") ?? "" });
        if (kind === "document" && host.DOMParser) return new host.DOMParser().parseFromString(bodyText(fake.body), isTextType(header(fake.headers, "content-type")) && /xml/i.test(header(fake.headers, "content-type") ?? "") ? "application/xml" : "text/html");
        return null;
      }
      override get responseXML(): Document | null {
        if (!this.#fake) return super.responseXML;
        return super.responseType === "document" ? (this.response as Document | null) : null;
      }
      override getResponseHeader(name: string): string | null {
        if (!this.#fake) return super.getResponseHeader(name);
        const values = this.#fake.headers.filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
        return values.length ? values.join(", ") : null;
      }
      override getAllResponseHeaders(): string {
        if (!this.#fake) return super.getAllResponseHeaders();
        return this.#fake.headers.map(([name, value]) => `${name.toLowerCase()}: ${value}\r\n`).join("");
      }
    }
    PatchedXHR = Patched;
    host.XMLHttpRequest = Patched;
  }

  return {
    configure,
    uninstall() {
      host.fetch = nativeFetch;
      if (NativeXHR && host.XMLHttpRequest === PatchedXHR) host.XMLHttpRequest = NativeXHR;
      if (!config) configure({ mode: "off", options: { ignoreQuery: [], ignoreBodyFields: [], loose: false, sequence: "ordered", unmatched: "network", speed: 0 }, maxBodyBytes: 0 });
    },
  };
}
