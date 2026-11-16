import { describe, expect, it } from "vitest";
import { install } from "../src/core/intercept";
import type { RecordedResponse } from "../src/core/types";
import { config, recorded, tick, world, type Server } from "./helpers";

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init.headers } });

/** A to-do API with real state, so the same request gets different answers over time. */
function todoServer(): Server {
  const todos: { id: number; title: string }[] = [];
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/todos" && request.method === "GET") return json(todos);
    if (url.pathname === "/api/todos" && request.method === "POST") {
      const todo = { id: todos.length + 1, title: ((await request.json()) as { title: string }).title };
      todos.push(todo);
      return json(todo, { status: 201 });
    }
    const id = /^\/api\/todos\/(\d+)$/.exec(url.pathname)?.[1];
    if (id && request.method === "DELETE") {
      todos.splice(todos.findIndex((t) => t.id === Number(id)), 1);
      return new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, { status: 404 });
  };
}

/** What a page does with the to-do API, and what it sees. */
async function session(fetcher: typeof fetch): Promise<string[]> {
  const seen: string[] = [];
  const list = async () => seen.push(await (await fetcher("https://app.test/api/todos")).text());
  const add = (title: string) => fetcher("https://app.test/api/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }).then((r) => r.text());
  await list();
  seen.push(await add("milk"));
  await list();
  seen.push(await add("eggs"));
  await list();
  seen.push(String((await fetcher("https://app.test/api/todos/1", { method: "DELETE" })).status));
  await list();
  return seen;
}

describe("before it is configured", () => {
  it("holds requests instead of sending them, then sends them in order", async () => {
    const w = world();
    const interceptor = install(w.host, w.hooks);
    const first = w.host.fetch("https://app.test/a");
    const second = w.host.fetch("https://app.test/b");
    await tick(20);
    expect(w.network).toHaveLength(0);
    interceptor.configure(config("off"));
    await Promise.all([first, second]);
    expect(w.network.map((r) => r.url)).toEqual(["https://app.test/a", "https://app.test/b"]);
  });

  it("answers held requests from the recording once it arrives", async () => {
    const w = world(() => json({ from: "network" }));
    const recorder = install(w.host, w.hooks);
    recorder.configure(config("record"));
    await w.host.fetch("https://app.test/boot");
    await recorded(w, 1);
    const recording = w.recording();
    recorder.uninstall();

    const later = world(() => {
      throw new Error("the network must not be reached");
    });
    const replay = install(later.host, later.hooks);
    const early = later.host.fetch("https://app.test/boot");
    await tick(10);
    replay.configure(config("replay", recording));
    expect(await (await early).json()).toEqual({ from: "network" });
    expect(later.network).toHaveLength(0);
  });

  it("gives up waiting after its deadline and lets requests through", async () => {
    const w = world();
    install(w.host, w.hooks);
    const held = w.host.fetch("https://app.test/a");
    await tick(10);
    expect(w.network).toHaveLength(0);
    w.expireConfigWait();
    expect((await held).status).toBe(200);
    expect(w.exchanges).toHaveLength(0);
  });

  it("holds an XMLHttpRequest too", async () => {
    const w = world(() => new Response("late"));
    const interceptor = install(w.host, w.hooks);
    const xhr = new w.host.XMLHttpRequest();
    xhr.open("GET", "https://app.test/x");
    const done = new Promise((resolve) => xhr.addEventListener("loadend", resolve));
    xhr.send();
    await tick(10);
    expect(w.network).toHaveLength(0);
    interceptor.configure(config("off"));
    await done;
    expect(xhr.responseText).toBe("late");
  });
});

describe("switched off", () => {
  it("passes requests through and records nothing", async () => {
    const w = world(() => new Response("hello"));
    install(w.host, w.hooks).configure(config("off"));
    expect(await (await w.host.fetch("https://app.test/a")).text()).toBe("hello");
    await tick(10);
    expect(w.exchanges).toHaveLength(0);
  });

  it("gives the page back its original fetch and XMLHttpRequest when uninstalled", () => {
    const w = world();
    const original = { fetch: w.host.fetch, xhr: w.host.XMLHttpRequest };
    const interceptor = install(w.host, w.hooks);
    expect(w.host.fetch).not.toBe(original.fetch);
    expect(new w.host.XMLHttpRequest()).toBeInstanceOf(original.xhr);
    interceptor.uninstall();
    expect(w.host.fetch).toBe(original.fetch);
    expect(w.host.XMLHttpRequest).toBe(original.xhr);
  });
});

describe("recording fetch", () => {
  it("captures the request and the response without changing what the page gets", async () => {
    const w = world(async (request) => json({ echo: await request.json() }, { status: 201, statusText: "Created", headers: { "x-request-id": "abc" } }));
    install(w.host, w.hooks).configure(config("record"));
    const response = await w.host.fetch("https://app.test/api/items?b=2&a=1", { method: "post", headers: { "Content-Type": "application/json", "X-Client": "web" }, body: '{"name":"pen"}' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ echo: { name: "pen" } });
    await recorded(w, 1);
    const [exchange] = w.exchanges;
    expect(exchange).toMatchObject({ via: "fetch", seq: 0, request: { method: "POST", url: "https://app.test/api/items?b=2&a=1", body: { kind: "text", data: '{"name":"pen"}' } } });
    expect(Object.fromEntries(exchange?.request.headers ?? [])).toMatchObject({ "content-type": "application/json", "x-client": "web" });
    expect(exchange?.response).toMatchObject({ status: 201, statusText: "Created", body: { kind: "text", data: '{"echo":{"name":"pen"}}' } });
    expect(Object.fromEntries(exchange?.response?.headers ?? [])["x-request-id"]).toBe("abc");
    expect(exchange?.totalMs).toBeGreaterThanOrEqual(exchange?.waitMs ?? Infinity);
    expect(exchange?.startedAt).toBeGreaterThan(1_700_000_000_000);
  });

  it("resolves relative URLs and accepts a Request object", async () => {
    const w = world();
    install(w.host, w.hooks).configure(config("record"));
    await w.host.fetch(new Request("https://app.test/api/ping", { method: "PUT", body: "x" }));
    await recorded(w, 1);
    expect(w.exchanges[0]?.request).toMatchObject({ method: "PUT", url: "https://app.test/api/ping", body: { data: "x" } });
  });

  it("records binary bodies as base64", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const w = world(() => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    install(w.host, w.hooks).configure(config("record"));
    const got = new Uint8Array(await (await w.host.fetch("https://app.test/file")).arrayBuffer());
    expect([...got]).toEqual([...bytes]);
    await recorded(w, 1);
    expect(w.exchanges[0]?.response?.body).toEqual({ kind: "base64", data: btoa(String.fromCharCode(...bytes)), size: 6 });
  });

  it("records a request that failed, and still fails it for the page", async () => {
    const w = world(() => {
      throw new TypeError("Failed to fetch");
    });
    install(w.host, w.hooks).configure(config("record"));
    await expect(w.host.fetch("https://app.test/down")).rejects.toThrow("Failed to fetch");
    await recorded(w, 1);
    expect(w.exchanges[0]).toMatchObject({ error: "Failed to fetch", request: { url: "https://app.test/down" } });
    expect(w.exchanges[0]?.response).toBeUndefined();
  });

  it("keeps a prefix of a body over the limit and marks it", async () => {
    const w = world(() => new Response("y".repeat(5000), { headers: { "content-type": "text/plain" } }));
    install(w.host, w.hooks).configure(config("record", undefined, {}, 1000));
    expect(await (await w.host.fetch("https://app.test/big")).text()).toHaveLength(5000);
    await recorded(w, 1);
    expect(w.exchanges[0]?.response?.body).toMatchObject({ size: 5000, truncated: true });
    expect(w.exchanges[0]?.response?.body.data).toHaveLength(1000);
  });

  it("leaves requests that are not http alone", async () => {
    const w = world();
    install(w.host, w.hooks).configure(config("record"));
    await w.host.fetch("data:text/plain,hi").catch(() => undefined);
    await tick(20);
    expect(w.exchanges).toHaveLength(0);
  });

  it("records a streamed response piece by piece, with when each piece arrived", async () => {
    const pieces = ["data: one\n\n", "data: two\n\n", "data: three\n\n"];
    const w = world(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (const piece of pieces) {
                controller.enqueue(new TextEncoder().encode(piece));
                await tick(40);
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    install(w.host, w.hooks).configure(config("record"));
    const response = await w.host.fetch("https://app.test/stream");
    expect(await response.text()).toBe(pieces.join(""));
    await recorded(w, 1);
    const stream = w.exchanges[0]?.response as RecordedResponse;
    expect(stream.body.data).toBe(pieces.join(""));
    expect(stream.chunks?.map((c) => c.data)).toEqual(pieces);
    const times = stream.chunks?.map((c) => c.atMs) ?? [];
    expect(times[2]).toBeGreaterThan((times[0] ?? 0) + 60);
  });

  it("does not let a failing listener break the page's request", async () => {
    const w = world(() => new Response("fine"));
    install(w.host, { ...w.hooks, onExchange: () => { throw new Error("listener bug"); } }).configure(config("record"));
    expect(await (await w.host.fetch("https://app.test/a")).text()).toBe("fine");
    await tick(20);
  });
});

describe("replaying fetch", () => {
  async function record(server: Server, act: (fetcher: typeof fetch) => Promise<unknown>, count: number) {
    const w = world(server);
    const interceptor = install(w.host, w.hooks);
    interceptor.configure(config("record"));
    await act(w.host.fetch);
    await recorded(w, count);
    interceptor.uninstall();
    return w.recording();
  }
  const offline = () =>
    world(() => {
      throw new Error("the network must not be reached");
    });

  it("replays a whole session with the network gone, each request getting the answer it got", async () => {
    const live = world(todoServer());
    const recorder = install(live.host, live.hooks);
    recorder.configure(config("record"));
    const seenLive = await session(live.host.fetch);
    await recorded(live, 7);

    const w = offline();
    install(w.host, w.hooks).configure(config("replay", live.recording()));
    expect(await session(w.host.fetch)).toEqual(seenLive);
    expect(w.network).toHaveLength(0);
    expect(w.replays.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(w.replays.every((r) => r.level === "exact" && !r.repeated)).toBe(true);
    expect(seenLive[2]).toBe('[{"id":1,"title":"milk"}]');
    expect(seenLive.at(-1)).toBe('[{"id":2,"title":"eggs"}]');
  });

  it("shows a stale list after a change when every request gets its first answer", async () => {
    const live = world(todoServer());
    const recorder = install(live.host, live.hooks);
    recorder.configure(config("record"));
    const seenLive = await session(live.host.fetch);
    await recorded(live, 7);

    const w = offline();
    install(w.host, w.hooks).configure(config("replay", live.recording(), { sequence: "first" }));
    const seen = await session(w.host.fetch);
    expect(seen).not.toEqual(seenLive);
    expect(seen[2]).toBe("[]");
  });

  it("gives a response the page can use like a real one", async () => {
    const recording = await record(
      (request) => (request.method === "DELETE" ? new Response(null, { status: 204 }) : json({ ok: true }, { status: 202, statusText: "Accepted", headers: { "content-encoding": "gzip", "content-length": "999", "x-kept": "yes" } })),
      async (f) => {
        await f("https://app.test/api/a");
        await f("https://app.test/api/a", { method: "DELETE" });
      },
      2,
    );
    const w = offline();
    install(w.host, w.hooks).configure(config("replay", recording));
    const response = await w.host.fetch("https://app.test/api/a");
    expect(response).toMatchObject({ status: 202, statusText: "Accepted", ok: true, url: "https://app.test/api/a" });
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.clone().json()).toEqual({ ok: true });
    const empty = await w.host.fetch("https://app.test/api/a", { method: "DELETE" });
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });

  it("fails a request that was never recorded like a network error, naming it", async () => {
    const w = offline();
    install(w.host, w.hooks).configure(config("replay", { version: 1, id: "e", name: "empty", origin: "https://app.test", createdAt: 0, exchanges: [] }));
    await expect(w.host.fetch("https://app.test/api/unknown")).rejects.toThrow(/no recorded answer for GET https:\/\/app\.test\/api\/unknown/);
    await expect(w.host.fetch("https://app.test/api/unknown")).rejects.toBeInstanceOf(TypeError);
    expect(w.replays[0]).toMatchObject({ seq: null, level: null });
  });

  it("can send a request that was never recorded to the network instead", async () => {
    const w = world(() => new Response("live"));
    install(w.host, w.hooks).configure(config("replay", { version: 1, id: "e", name: "empty", origin: "https://app.test", createdAt: 0, exchanges: [] }, { unmatched: "network" }));
    expect(await (await w.host.fetch("https://app.test/api/unknown")).text()).toBe("live");
    expect(w.network).toHaveLength(1);
  });

  it("matches a request whose cache-buster changed, and says it relaxed", async () => {
    const recording = await record(() => json([1]), (f) => f("https://app.test/api/list?_=1700000000001"), 1);
    const w = offline();
    install(w.host, w.hooks).configure(config("replay", recording));
    expect(await (await w.host.fetch("https://app.test/api/list?_=1700000099999")).json()).toEqual([1]);
    expect(w.replays[0]?.level).toBe("relaxed");
  });

  it("respects an abort that happened before the request", async () => {
    const recording = await record(() => json(1), (f) => f("https://app.test/api/a"), 1);
    const w = offline();
    install(w.host, w.hooks).configure(config("replay", recording));
    await expect(w.host.fetch("https://app.test/api/a", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("replays a stream at its recorded pace, or all at once", async () => {
    const pieces = ["alpha ", "beta ", "gamma"];
    const recording = await record(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (const piece of pieces) {
                controller.enqueue(new TextEncoder().encode(piece));
                await tick(50);
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      (f) => f("https://app.test/stream").then((r) => r.text()),
      1,
    );

    const paced = offline();
    install(paced.host, paced.hooks).configure(config("replay", recording, { speed: 1 }));
    const started = performance.now();
    const reader = (await paced.host.fetch("https://app.test/stream")).body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const got: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(new TextDecoder().decode(value));
    }
    expect(got).toEqual(pieces);
    expect(performance.now() - started).toBeGreaterThan(80);

    const instant = offline();
    install(instant.host, instant.hooks).configure(config("replay", recording));
    const t0 = performance.now();
    expect(await (await instant.host.fetch("https://app.test/stream")).text()).toBe(pieces.join(""));
    expect(performance.now() - t0).toBeLessThan(40);
  });

  it("tells a request apart by its body", async () => {
    const recording = await record(
      async (request) => json({ answer: ((await request.json()) as { q: string }).q.toUpperCase() }),
      async (f) => {
        for (const q of ["a", "b"]) await f("https://app.test/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }) });
      },
      2,
    );
    const w = offline();
    install(w.host, w.hooks).configure(config("replay", recording));
    const ask = async (q: string) => (await (await w.host.fetch("https://app.test/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }) })).json()) as { answer: string };
    expect((await ask("b")).answer).toBe("B");
    expect((await ask("a")).answer).toBe("A");
  });
});

describe("a page reload during a replay", () => {
  /** A fake session storage that outlives the "page", the way the real one outlives a reload. */
  function storage() {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key), items };
  }
  async function recording() {
    const live = world(todoServer());
    const recorder = install(live.host, live.hooks);
    recorder.configure(config("record"));
    await session(live.host.fetch);
    await recorded(live, 7);
    return live.recording();
  }
  /** A fresh page: new window, new interceptor, same session storage. */
  function page(kept: ReturnType<typeof storage>) {
    const w = world(() => {
      throw new Error("the network must not be reached");
    });
    Object.assign(w.host, { sessionStorage: kept });
    return { w, interceptor: install(w.host, w.hooks) };
  }
  const list = async (w: ReturnType<typeof world>) => (await w.host.fetch("https://app.test/api/todos")).text();
  const add = (w: ReturnType<typeof world>, title: string) => w.host.fetch("https://app.test/api/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });

  it("carries on from where the recording had got to", async () => {
    const tape = await recording();
    const kept = storage();
    const first = page(kept);
    first.interceptor.configure({ ...config("replay", tape), session: "run-1" });
    expect(await list(first.w)).toBe("[]");
    await add(first.w, "milk");
    expect(await list(first.w)).toBe('[{"id":1,"title":"milk"}]');

    // Reload: everything in the page is gone except session storage.
    const second = page(kept);
    second.interceptor.configure({ ...config("replay", tape), session: "run-1" });
    await add(second.w, "eggs");
    expect(await list(second.w)).toBe('[{"id":1,"title":"milk"},{"id":2,"title":"eggs"}]');
    expect(second.w.replays.map((r) => r.seq)).toEqual([3, 4]);
  });

  it("starts from the beginning when the session is a new one", async () => {
    const tape = await recording();
    const kept = storage();
    const first = page(kept);
    first.interceptor.configure({ ...config("replay", tape), session: "run-1" });
    await list(first.w);
    await add(first.w, "milk");

    const second = page(kept);
    second.interceptor.configure({ ...config("replay", tape), session: "run-2" });
    expect(await list(second.w)).toBe("[]");
  });

  it("starts from the beginning without a session, or without storage, or with storage that throws", async () => {
    const tape = await recording();
    const kept = storage();
    const first = page(kept);
    first.interceptor.configure(config("replay", tape));
    await list(first.w);
    expect(kept.items.size).toBe(0);

    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const w = world();
    Object.assign(w.host, { sessionStorage: broken });
    install(w.host, w.hooks).configure({ ...config("replay", tape), session: "run-1" });
    expect(await list(w)).toBe("[]");
    expect(await list(w)).toBe('[{"id":1,"title":"milk"}]');
  });

  it("does not rewind when only a setting changes mid-run", async () => {
    const tape = await recording();
    const { w, interceptor } = page(storage());
    interceptor.configure({ ...config("replay", tape), session: "run-1" });
    await list(w);
    await add(w, "milk");
    interceptor.configure({ ...config("replay", tape, { speed: 0.01 }), session: "run-1" });
    expect(await list(w)).toBe('[{"id":1,"title":"milk"}]');
  });
});

describe("comparing with a recording", () => {
  it("uses the network and reports where the answer's shape has changed", async () => {
    const before = world(() => json({ id: 1, name: "a", price: 10 }));
    const recorder = install(before.host, before.hooks);
    recorder.configure(config("record"));
    await before.host.fetch("https://app.test/api/item");
    await before.host.fetch("https://app.test/api/same");
    await recorded(before, 2);

    const w = world((request) => (request.url.endsWith("/item") ? json({ id: "1", name: "b", cost: 12 }) : json({ id: 2, name: "z", price: 11 })));
    install(w.host, w.hooks).configure(config("compare", before.recording()));
    expect(await (await w.host.fetch("https://app.test/api/item")).json()).toEqual({ id: "1", name: "b", cost: 12 });
    await w.host.fetch("https://app.test/api/same");
    await w.host.fetch("https://app.test/api/new");
    for (let i = 0; i < 100 && w.drifts.length < 3; i++) await tick(5);
    expect(w.network).toHaveLength(3);
    expect(w.exchanges).toHaveLength(0);
    const [item, same, fresh] = w.drifts;
    expect(item?.differences).toEqual(
      expect.arrayContaining([
        { path: "id", kind: "type", recorded: "number", live: "string" },
        { path: "price", kind: "removed", recorded: "number" },
        { path: "cost", kind: "added", live: "number" },
      ]),
    );
    expect(same).toMatchObject({ seq: 1, differences: [] });
    expect(fresh).toMatchObject({ seq: null, differences: [] });
  });
});

describe("XMLHttpRequest", () => {
  function send(w: ReturnType<typeof world>, method: string, url: string, body?: string, setup?: (xhr: XMLHttpRequest) => void): Promise<{ xhr: XMLHttpRequest; events: string[] }> {
    return new Promise((resolve) => {
      const xhr = new w.host.XMLHttpRequest();
      const events: string[] = [];
      for (const type of ["loadstart", "readystatechange", "progress", "load", "error", "abort", "loadend"]) {
        xhr.addEventListener(type, () => {
          events.push(type === "readystatechange" ? `state ${xhr.readyState}` : type);
          if (type === "loadend") resolve({ xhr, events });
        });
      }
      xhr.open(method, url);
      if (body) xhr.setRequestHeader("Content-Type", "application/json");
      setup?.(xhr);
      xhr.send(body);
    });
  }

  async function recordedSession() {
    const w = world(async (request) => (request.method === "POST" ? json({ got: await request.json() }, { status: 201, headers: { "x-id": "7" } }) : json({ items: [1, 2] })));
    const interceptor = install(w.host, w.hooks);
    interceptor.configure(config("record"));
    await send(w, "GET", "/api/items");
    await send(w, "POST", "https://app.test/api/items", '{"n":3}');
    await recorded(w, 2);
    interceptor.uninstall();
    return w;
  }

  it("is recorded, with relative URLs resolved against the page", async () => {
    const w = await recordedSession();
    expect(w.exchanges.map((e) => [e.via, e.request.method, e.request.url, e.response?.status])).toEqual([
      ["xhr", "GET", "https://app.test/api/items", 200],
      ["xhr", "POST", "https://app.test/api/items", 201],
    ]);
    expect(w.exchanges[1]?.request.body.data).toBe('{"n":3}');
    expect(w.exchanges[1]?.response?.body.data).toBe('{"got":{"n":3}}');
    expect(Object.fromEntries(w.exchanges[1]?.response?.headers ?? [])["x-id"]).toBe("7");
  });

  it("is replayed through the same states and events as a real request", async () => {
    const recording = (await recordedSession()).recording();
    const w = world(() => {
      throw new Error("the network must not be reached");
    });
    install(w.host, w.hooks).configure(config("replay", recording));
    const { xhr, events } = await send(w, "POST", "https://app.test/api/items", '{"n":3}');
    expect(w.network).toHaveLength(0);
    expect(events).toEqual(["loadstart", "state 2", "state 3", "progress", "state 4", "load", "loadend"]);
    expect(xhr).toMatchObject({ readyState: 4, status: 201, responseText: '{"got":{"n":3}}', responseURL: "https://app.test/api/items" });
    expect(xhr.getResponseHeader("X-Id")).toBe("7");
    expect(xhr.getAllResponseHeaders()).toContain("x-id: 7\r\n");
    expect(xhr.getResponseHeader("nope")).toBeNull();
  });

  it("reports progress with finite numbers, as a browser's ProgressEvent demands", async () => {
    const recording = (await recordedSession()).recording();
    class StrictProgressEvent extends Event {
      loaded: number;
      total: number;
      constructor(type: string, init: { loaded: number; total: number }) {
        super(type);
        if (!Number.isFinite(init.loaded) || !Number.isFinite(init.total)) throw new TypeError("Value is not of type 'unsigned long long'.");
        this.loaded = init.loaded;
        this.total = init.total;
      }
    }
    const globals = globalThis as { ProgressEvent?: unknown };
    const before = globals.ProgressEvent;
    globals.ProgressEvent = StrictProgressEvent;
    try {
      const w = world();
      install(w.host, w.hooks).configure(config("replay", recording));
      const progress: number[][] = [];
      const { xhr } = await send(w, "GET", "https://app.test/api/items", undefined, (request) => request.addEventListener("progress", (event) => progress.push([(event as ProgressEvent).loaded, (event as ProgressEvent).total])));
      expect(xhr.status).toBe(200);
      expect(progress).toEqual([[15, 15]]);
    } finally {
      globals.ProgressEvent = before;
    }
  });

  it("gives the response in the type the page asked for", async () => {
    const recording = (await recordedSession()).recording();
    const w = world();
    install(w.host, w.hooks).configure(config("replay", recording));
    const asJson = await send(w, "GET", "https://app.test/api/items", undefined, (xhr) => (xhr.responseType = "json"));
    expect(asJson.xhr.response).toEqual({ items: [1, 2] });
    const asBuffer = await send(w, "GET", "https://app.test/api/items", undefined, (xhr) => (xhr.responseType = "arraybuffer"));
    expect(new TextDecoder().decode(asBuffer.xhr.response as ArrayBuffer)).toBe('{"items":[1,2]}');
    const asBlob = await send(w, "GET", "https://app.test/api/items", undefined, (xhr) => (xhr.responseType = "blob"));
    expect(await (asBlob.xhr.response as Blob).text()).toBe('{"items":[1,2]}');
    expect((asBlob.xhr.response as Blob).type).toBe("application/json");
  });

  it("fails a request that was never recorded with an error event and status 0", async () => {
    const recording = (await recordedSession()).recording();
    const w = world();
    install(w.host, w.hooks).configure(config("replay", recording));
    const { xhr, events } = await send(w, "GET", "https://app.test/api/other");
    expect(events).toEqual(["state 4", "error", "loadend"]);
    expect(xhr.status).toBe(0);
    expect(w.network).toHaveLength(0);
    expect(w.replays.at(-1)).toMatchObject({ seq: null });
  });

  it("can be aborted while a slow replay is in progress", async () => {
    const recording = (await recordedSession()).recording();
    for (const exchange of recording.exchanges) exchange.waitMs = 200;
    const w = world();
    install(w.host, w.hooks).configure(config("replay", recording, { speed: 1 }));
    const xhr = new w.host.XMLHttpRequest();
    const events: string[] = [];
    for (const type of ["load", "abort", "loadend"]) xhr.addEventListener(type, () => events.push(type));
    xhr.open("GET", "https://app.test/api/items");
    xhr.send();
    await tick(30);
    xhr.abort();
    await tick(250);
    expect(events).not.toContain("load");
  });

  it("sends a synchronous request to the network, since it cannot wait for anything", async () => {
    const recording = (await recordedSession()).recording();
    const w = world(() => new Response("sync"));
    install(w.host, w.hooks).configure(config("replay", recording));
    const xhr = new w.host.XMLHttpRequest();
    const done = new Promise((resolve) => xhr.addEventListener("loadend", resolve));
    xhr.open("GET", "https://app.test/api/items", false);
    xhr.send();
    await done;
    expect(w.network).toHaveLength(1);
  });

  it("is compared with a recording in compare mode", async () => {
    const recording = (await recordedSession()).recording();
    const w = world(() => json({ items: "none" }));
    install(w.host, w.hooks).configure(config("compare", recording));
    await send(w, "GET", "https://app.test/api/items");
    for (let i = 0; i < 100 && w.drifts.length < 1; i++) await tick(5);
    expect(w.drifts[0]?.differences).toEqual([{ path: "items", kind: "type", recorded: "array", live: "string" }]);
  });
});
