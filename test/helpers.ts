import type { Host, Hooks } from "../src/core/intercept";
import type { Config, DriftEvent, Exchange, Recording, ReplayEvent, ReplayOptions } from "../src/core/types";
import { DEFAULT_OPTIONS, MAX_BODY_BYTES } from "../src/core/types";

export type Server = (request: Request) => Response | Promise<Response>;

/** A stand-in for the browser's own XMLHttpRequest that "sends" to a function instead of a network. */
export function fakeNativeXhr(server: () => Server) {
  return class FakeXHR extends EventTarget {
    static calls = 0;
    // Like the real thing, state is read through getters on the prototype, not instance fields.
    #readyState = 0;
    #status = 0;
    #statusText = "";
    #responseType = "";
    #responseURL = "";
    timeout = 0;
    withCredentials = false;
    #method = "GET";
    #url = "";
    #async = true;
    #headers = new Headers();
    #responseHeaders = new Headers();
    #bytes = new Uint8Array(0);
    #aborted = false;

    get readyState(): number {
      return this.#readyState;
    }
    get status(): number {
      return this.#status;
    }
    get statusText(): string {
      return this.#statusText;
    }
    get responseURL(): string {
      return this.#responseURL;
    }
    get responseType(): string {
      return this.#responseType;
    }
    set responseType(value: string) {
      this.#responseType = value;
    }

    open(method: string, url: string | URL, async = true): void {
      this.#method = method;
      this.#url = new URL(String(url), "https://app.test/page").href;
      this.#async = async;
      this.#readyState = 1;
    }
    setRequestHeader(name: string, value: string): void {
      this.#headers.append(name, value);
    }
    send(body?: BodyInit | null): void {
      FakeXHR.calls += 1;
      void this.#run(body ?? null);
    }
    async #run(body: BodyInit | null): Promise<void> {
      try {
        const response = await server()(new Request(this.#url, { method: this.#method, headers: this.#headers, body: ["GET", "HEAD"].includes(this.#method.toUpperCase()) ? null : body }));
        if (this.#aborted) return;
        this.#status = response.status;
        this.#statusText = response.statusText;
        this.#responseURL = this.#url;
        this.#responseHeaders = response.headers;
        this.#set(2);
        this.#bytes = new Uint8Array(await response.arrayBuffer());
        this.#set(3);
        this.#set(4);
        this.dispatchEvent(new Event("load"));
      } catch {
        this.#status = 0;
        this.#set(4);
        this.dispatchEvent(new Event("error"));
      }
      this.dispatchEvent(new Event("loadend"));
    }
    #set(state: number): void {
      this.#readyState = state;
      this.dispatchEvent(new Event("readystatechange"));
    }
    abort(): void {
      this.#aborted = true;
      this.#readyState = 0;
      this.#status = 0;
      this.dispatchEvent(new Event("abort"));
      this.dispatchEvent(new Event("loadend"));
    }
    get responseText(): string {
      return new TextDecoder().decode(this.#bytes);
    }
    get response(): unknown {
      if (this.responseType === "json") return this.#bytes.length ? (JSON.parse(this.responseText) as unknown) : null;
      if (this.responseType === "arraybuffer") return this.#bytes.buffer;
      if (this.responseType === "blob") return new Blob([this.#bytes]);
      return this.responseText;
    }
    get responseXML(): null {
      return null;
    }
    getResponseHeader(name: string): string | null {
      return this.#responseHeaders.get(name);
    }
    getAllResponseHeaders(): string {
      return [...this.#responseHeaders].map(([name, value]) => `${name}: ${value}\r\n`).join("");
    }
    get isAsync(): boolean {
      return this.#async;
    }
  };
}

export interface World {
  host: Host & { XMLHttpRequest: typeof XMLHttpRequest; location: { href: string } };
  exchanges: Exchange[];
  replays: ReplayEvent[];
  drifts: DriftEvent[];
  hooks: Hooks;
  /** Requests that reached the "network". */
  network: Request[];
  setServer(server: Server): void;
  recording(): Recording;
  /** Runs the 3-second "no configuration arrived" fallback now. */
  expireConfigWait(): void;
}

export function world(server: Server = () => new Response("ok")): World {
  let current = server;
  const network: Request[] = [];
  const serve: Server = (request) => {
    network.push(request.clone());
    return current(request);
  };
  const exchanges: Exchange[] = [];
  const replays: ReplayEvent[] = [];
  const drifts: DriftEvent[] = [];
  let first: (() => void) | null = null;
  const host = {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve().then(() => serve(new Request(input, init)))) as typeof fetch,
    XMLHttpRequest: fakeNativeXhr(() => serve) as unknown as typeof XMLHttpRequest,
    Request,
    Response,
    Headers,
    ReadableStream,
    Blob,
    // The first timer the interceptor sets is its configuration deadline; tests fire it by hand.
    setTimeout: (handler: () => void, ms?: number) => (first === null ? ((first = handler), 0) : setTimeout(handler, ms)),
    performance,
    location: { href: "https://app.test/page" },
  };
  return {
    host,
    exchanges,
    replays,
    drifts,
    network,
    hooks: {
      onExchange: (exchange) => exchanges.push({ ...exchange, seq: exchanges.length }),
      onReplay: (event) => replays.push(event),
      onDrift: (event) => drifts.push(event),
    },
    setServer: (next) => (current = next),
    recording: () => ({ version: 1, id: "r1", name: "test", origin: "https://app.test", createdAt: 0, exchanges: structuredClone(exchanges) }),
    expireConfigWait: () => first?.(),
  };
}

export function config(mode: Config["mode"], recording?: Recording, options: Partial<ReplayOptions> = {}, maxBodyBytes = MAX_BODY_BYTES): Config {
  return { mode, recording, options: { ...DEFAULT_OPTIONS, ...options }, maxBodyBytes };
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `count` exchanges have been recorded (bodies are captured after the response is returned). */
export async function recorded(w: World, count: number): Promise<void> {
  for (let i = 0; i < 200 && w.exchanges.length < count; i++) await tick(5);
  if (w.exchanges.length < count) throw new Error(`only ${w.exchanges.length} of ${count} exchanges were recorded`);
}

export function exchange(partial: { method?: string; url: string; body?: string; type?: string; status?: number; response?: string; responseType?: string; seq?: number; failed?: boolean }): Exchange {
  return {
    seq: partial.seq ?? 0,
    via: "fetch",
    startedAt: 1_700_000_000_000,
    waitMs: 20,
    totalMs: 30,
    request: {
      method: partial.method ?? "GET",
      url: partial.url,
      headers: partial.type ? [["content-type", partial.type]] : partial.body ? [["content-type", "application/json"]] : [],
      body: partial.body ? { kind: "text", data: partial.body, size: partial.body.length } : { kind: "none", data: "", size: 0 },
    },
    ...(partial.failed
      ? { error: "Failed to fetch" }
      : {
          response: {
            status: partial.status ?? 200,
            statusText: "OK",
            headers: [["content-type", partial.responseType ?? "application/json"]],
            body: partial.response === undefined ? { kind: "none", data: "", size: 0 } : { kind: "text", data: partial.response, size: partial.response.length },
          },
        }),
  };
}
