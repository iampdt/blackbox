import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { bodyBytes, bodyFromBytes, bodyText } from "../src/core/body";
import { differences } from "../src/core/drift";
import { fromHar, fromJson, toHar, toMsw } from "../src/core/export";
import { canonicalJson, Replayer, requestKey } from "../src/core/match";
import { REDACTED, redactExchange, redactRecording, redactUrl } from "../src/core/redact";
import { DEFAULT_OPTIONS, type Exchange, type Recording, type RecordedResponse } from "../src/core/types";
import { exchange } from "./helpers";

const key = (e: Exchange, level: "exact" | "relaxed" | "loose" = "exact") => requestKey(e.request, DEFAULT_OPTIONS, level);

describe("bodies", () => {
  it("keeps text as text and anything else as base64, and gives the same bytes back", () => {
    const json = bodyFromBytes(new TextEncoder().encode('{"a":"é"}'), "application/json; charset=utf-8", 1000);
    expect(json).toEqual({ kind: "text", data: '{"a":"é"}', size: 10 });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 254]);
    const image = bodyFromBytes(png, "image/png", 1000);
    expect(image.kind).toBe("base64");
    expect([...bodyBytes(image)]).toEqual([...png]);
  });

  it("guesses from the bytes when there is no content type", () => {
    expect(bodyFromBytes(new TextEncoder().encode("plain words"), undefined, 100).kind).toBe("text");
    expect(bodyFromBytes(new Uint8Array([0, 1, 2, 3]), undefined, 100).kind).toBe("base64");
  });

  it("keeps a prefix of a body over the limit and says so", () => {
    const body = bodyFromBytes(new TextEncoder().encode("x".repeat(100)), "text/plain", 10);
    expect(body).toMatchObject({ size: 100, truncated: true });
    expect(bodyText(body)).toBe("x".repeat(10));
  });
});

describe("request keys", () => {
  it("ignore the order of query parameters and of JSON keys", () => {
    expect(key(exchange({ url: "https://a.test/x?b=2&a=1" }))).toBe(key(exchange({ url: "https://a.test/x?a=1&b=2" })));
    expect(key(exchange({ method: "POST", url: "https://a.test/x", body: '{"a":1,"b":{"d":2,"c":3}}' }))).toBe(
      key(exchange({ method: "POST", url: "https://a.test/x", body: '{ "b": {"c":3,"d":2}, "a": 1 }' })),
    );
  });

  it("tell apart different methods, paths, query values and bodies", () => {
    const base = key(exchange({ method: "POST", url: "https://a.test/x?a=1", body: '{"n":1}' }));
    for (const other of [
      exchange({ method: "PUT", url: "https://a.test/x?a=1", body: '{"n":1}' }),
      exchange({ method: "POST", url: "https://a.test/y?a=1", body: '{"n":1}' }),
      exchange({ method: "POST", url: "https://a.test/x?a=2", body: '{"n":1}' }),
      exchange({ method: "POST", url: "https://a.test/x?a=1", body: '{"n":2}' }),
      exchange({ method: "POST", url: "https://b.test/x?a=1", body: '{"n":1}' }),
    ]) {
      expect(key(other)).not.toBe(base);
    }
  });

  it("drop volatile query parameters and body fields only at the relaxed level", () => {
    const a = exchange({ method: "POST", url: "https://a.test/x?id=7&_=1700000000001", body: '{"q":"hi","timestamp":1,"meta":{"nonce":"a"}}' });
    const b = exchange({ method: "POST", url: "https://a.test/x?_=1700000009999&id=7", body: '{"q":"hi","timestamp":2,"meta":{"nonce":"b"}}' });
    expect(key(a)).not.toBe(key(b));
    expect(key(a, "relaxed")).toBe(key(b, "relaxed"));
    expect(key(a, "relaxed")).not.toBe(key(exchange({ method: "POST", url: "https://a.test/x?id=8", body: '{"q":"hi"}' }), "relaxed"));
  });

  it("at the loose level see only the method and the path", () => {
    expect(key(exchange({ url: "https://a.test/x?page=1" }), "loose")).toBe(key(exchange({ url: "https://a.test/x?page=2" }), "loose"));
  });

  it("compare form posts by their fields and uploads without their random boundary", () => {
    const form = "application/x-www-form-urlencoded";
    expect(key(exchange({ method: "POST", url: "https://a.test/f", body: "b=2&a=1", type: form }))).toBe(key(exchange({ method: "POST", url: "https://a.test/f", body: "a=1&b=2", type: form })));
    const upload = (boundary: string) =>
      exchange({ method: "POST", url: "https://a.test/u", type: `multipart/form-data; boundary=${boundary}`, body: `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--${boundary}--\r\n` });
    expect(key(upload("----X1"))).toBe(key(upload("----Y2")));
  });

  it("sort keys at every depth and leave arrays in order", () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: null }, new Set())).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
  });
});

describe("the replayer", () => {
  const list = (items: string, seq: number) => exchange({ url: "https://a.test/todos", response: items, seq });
  const add = (title: string, seq: number) => exchange({ method: "POST", url: "https://a.test/todos", body: JSON.stringify({ title }), response: "{}", seq });
  const session = [list("[]", 0), add("milk", 1), list('["milk"]', 2), add("eggs", 3), list('["milk","eggs"]', 4)];
  const answer = (replayer: Replayer, e: Exchange) => {
    const match = replayer.next(e.request);
    return match ? bodyText((match.exchange.response as RecordedResponse).body) : null;
  };

  it("gives the same request its recorded answers in order, then repeats the last", () => {
    const replayer = new Replayer(session, DEFAULT_OPTIONS);
    expect(answer(replayer, list("", 0))).toBe("[]");
    expect(answer(replayer, add("milk", 0))).toBe("{}");
    expect(answer(replayer, list("", 0))).toBe('["milk"]');
    expect(answer(replayer, list("", 0))).toBe('["milk","eggs"]');
    const again = replayer.next(list("", 0).request);
    expect(again?.repeated).toBe(true);
    expect(bodyText((again?.exchange.response as RecordedResponse).body)).toBe('["milk","eggs"]');
    expect(replayer.stats).toEqual({ hits: 5, misses: 0 });
  });

  it("in 'first' mode always gives the first answer, which is stale after a change", () => {
    const replayer = new Replayer(session, { ...DEFAULT_OPTIONS, sequence: "first" });
    answer(replayer, list("", 0));
    answer(replayer, add("milk", 0));
    expect(answer(replayer, list("", 0))).toBe("[]");
  });

  it("misses a request that was never recorded, unless loose matching is on", () => {
    const strict = new Replayer(session, DEFAULT_OPTIONS);
    expect(strict.next(exchange({ url: "https://a.test/todos?page=2" }).request)).toBeNull();
    expect(strict.stats.misses).toBe(1);
    const loose = new Replayer(session, { ...DEFAULT_OPTIONS, loose: true });
    expect(loose.next(exchange({ url: "https://a.test/todos?page=2" }).request)?.level).toBe("loose");
  });

  it("prefers an exact match and says when it had to relax", () => {
    const recorded = [exchange({ url: "https://a.test/x?id=1&_=111", response: "one", seq: 0 }), exchange({ url: "https://a.test/x?id=1&_=222", response: "two", seq: 1 })];
    const replayer = new Replayer(recorded, DEFAULT_OPTIONS);
    expect(replayer.next(exchange({ url: "https://a.test/x?id=1&_=222" }).request)).toMatchObject({ level: "exact", exchange: { seq: 1 } });
    expect(replayer.next(exchange({ url: "https://a.test/x?id=1&_=999" }).request)).toMatchObject({ level: "relaxed", exchange: { seq: 0 } });
  });

  it("never answers with a request that failed when it was recorded", () => {
    const replayer = new Replayer([exchange({ url: "https://a.test/down", failed: true })], DEFAULT_OPTIONS);
    expect(replayer.next(exchange({ url: "https://a.test/down" }).request)).toBeNull();
  });

  it("starts again from the first answers after a rewind", () => {
    const replayer = new Replayer(session, DEFAULT_OPTIONS);
    answer(replayer, list("", 0));
    answer(replayer, list("", 0));
    replayer.rewind();
    expect(answer(replayer, list("", 0))).toBe("[]");
  });
});

describe("redaction", () => {
  const login: Exchange = {
    ...exchange({ method: "POST", url: "https://a.test/login?api_key=abc123&page=2", body: '{"email":"p@x.test","password":"hunter2"}', response: '{"user":{"name":"P"},"access_token":"tok_live_123","refreshToken":"r_456","note":"keep"}' }),
  };
  login.request.headers.push(["Authorization", "Bearer abcdef123456"], ["X-Trace", "t-1"]);
  (login.response as RecordedResponse).headers.push(["Set-Cookie", "sid=xyz; HttpOnly"]);

  it("removes credentials from headers, the URL and JSON bodies, and leaves the rest", () => {
    const safe = redactExchange(login);
    expect(safe.request.url).toBe(`https://a.test/login?api_key=${REDACTED}&page=2`);
    expect(Object.fromEntries(safe.request.headers)).toMatchObject({ Authorization: REDACTED, "X-Trace": "t-1" });
    expect(JSON.parse(safe.request.body.data)).toEqual({ email: "p@x.test", password: REDACTED });
    expect(JSON.parse((safe.response as RecordedResponse).body.data)).toEqual({ user: { name: "P" }, access_token: REDACTED, refreshToken: REDACTED, note: "keep" });
    expect(Object.fromEntries((safe.response as RecordedResponse).headers)["Set-Cookie"]).toBe(REDACTED);
    const serialized = JSON.stringify(safe);
    for (const secret of ["hunter2", "abc123", "abcdef123456", "tok_live_123", "r_456", "sid=xyz"]) expect(serialized).not.toContain(secret);
  });

  it("finds tokens that are not under a telling name", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const safe = redactExchange(exchange({ url: "https://a.test/x", response: JSON.stringify({ message: `use ${jwt} please`, items: [jwt] }) }));
    expect((safe.response as RecordedResponse).body.data).not.toContain("eyJ");
    const text = redactExchange(exchange({ url: "https://a.test/x", response: `Authorization: Bearer sk-abcdef1234567890`, responseType: "text/plain" }));
    expect((text.response as RecordedResponse).body.data).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("leaves a body with nothing secret in it exactly as it was", () => {
    const plain = exchange({ url: "https://a.test/x", response: '{\n  "a": 1\n}' });
    expect((redactExchange(plain).response as RecordedResponse).body).toBe((plain.response as RecordedResponse).body);
  });

  it("redacts form posts and credentials inside a URL", () => {
    const form = redactExchange(exchange({ method: "POST", url: "https://a.test/f", body: "user=p&password=hunter2", type: "application/x-www-form-urlencoded" }));
    expect(form.request.body.data).toBe(`user=p&password=${REDACTED}`);
    expect(redactUrl("https://user:pw@a.test/x")).toBe("https://a.test/x");
    expect(redactUrl("not a url")).toBe("not a url");
  });

  it("drops the pieces of a stream whose text it changed", () => {
    const streamed = exchange({ url: "https://a.test/s", response: '{"token":"abc"}' });
    (streamed.response as RecordedResponse).chunks = [{ atMs: 0, data: '{"token":' }, { atMs: 80, data: '"abc"}' }];
    const recording: Recording = { version: 1, id: "r", name: "n", origin: "https://a.test", createdAt: 0, exchanges: [streamed] };
    expect((redactRecording(recording).exchanges[0]?.response as RecordedResponse).chunks).toBeUndefined();
  });
});

describe("drift", () => {
  const response = (body: unknown, status = 200, type = "application/json"): RecordedResponse => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, statusText: "", headers: [["Content-Type", type]], body: { kind: "text", data: text, size: text.length } };
  };

  it("is silent when only values changed", () => {
    expect(differences(response({ id: 1, name: "a", tags: ["x"], owner: { id: 9 } }), response({ id: 2, name: "b", tags: ["y", "z"], owner: { id: 10 } }))).toEqual([]);
  });

  it("reports fields added, removed and changed in type, with their paths", () => {
    const found = differences(response({ id: 1, price: 10, owner: { name: "a", email: "e" }, items: [{ sku: "a", qty: 1 }] }), response({ id: "1", owner: { name: "a" }, items: [{ sku: "a", qty: "1", note: "n" }], total: 5 }));
    expect(found).toEqual(
      expect.arrayContaining([
        { path: "id", kind: "type", recorded: "number", live: "string" },
        { path: "price", kind: "removed", recorded: "number" },
        { path: "owner.email", kind: "removed", recorded: "string" },
        { path: "items[].qty", kind: "type", recorded: "number", live: "string" },
        { path: "items[].note", kind: "added", live: "string" },
        { path: "total", kind: "added", live: "number" },
      ]),
    );
    expect(found).toHaveLength(6);
  });

  it("reports a changed status and content type, and treats null as an optional field", () => {
    expect(differences(response({ a: 1 }), response("<html>", 502, "text/html"))).toEqual([
      { path: "status", kind: "status", recorded: "200", live: "502" },
      { path: "content-type", kind: "content-type", recorded: "application/json", live: "text/html" },
    ]);
    expect(differences(response({ a: null, b: 1 }), response({ a: "now set", b: null }))).toEqual([]);
    expect(differences(response({ a: 1 }, 200, "application/json; charset=utf-8"), response({ a: 2 }))).toEqual([]);
  });
});

describe("exports", () => {
  const png = "iVBORw0KGgo=";
  const recording: Recording = {
    version: 1,
    id: "r1",
    name: "Checkout",
    origin: "https://a.test",
    createdAt: 5,
    exchanges: [
      exchange({ url: "https://a.test/api/todos?page=1", response: '[{"id":1}]', seq: 0 }),
      exchange({ method: "POST", url: "https://a.test/api/todos", body: '{"title":"milk"}', response: '{"id":2}', status: 201, seq: 1 }),
      exchange({ url: "https://a.test/api/todos?page=1", response: '[{"id":1},{"id":2}]', seq: 2 }),
      { ...exchange({ url: "https://a.test/logo.png", seq: 3 }), response: { status: 200, statusText: "OK", headers: [["content-type", "image/png"]], body: { kind: "base64", data: png, size: 8 } } },
      exchange({ method: "DELETE", url: "https://a.test/api/todos/2", status: 204, seq: 4 }),
      exchange({ url: "https://a.test/api/down", failed: true, seq: 5 }),
    ],
  };

  it("writes a HAR that reads back to the same recording", () => {
    const har = toHar(recording, "0.1.0");
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries).toHaveLength(6);
    expect(har.log.entries[0]?.request.queryString).toEqual([{ name: "page", value: "1" }]);
    expect(har.log.entries[1]?.request.postData).toEqual({ mimeType: "application/json", text: '{"title":"milk"}' });
    expect(har.log.entries[3]?.response.content).toMatchObject({ encoding: "base64", text: png });
    expect(har.log.entries[5]?.response.status).toBe(0);
    const back = fromHar(JSON.parse(JSON.stringify(har)), recording.origin, recording.name, "r1");
    expect(back.exchanges.map((e) => [e.request.method, e.request.url, e.response?.status, e.response?.body.data, e.error])).toEqual(
      recording.exchanges.map((e) => [e.request.method, e.request.url, e.response?.status, e.response?.body.data, e.error]),
    );
  });

  it("reads a HAR from browser dev tools, keeping only the API calls", () => {
    const entry = (type: string, url: string) => ({
      _resourceType: type,
      startedDateTime: "2026-11-16T10:00:00.000Z",
      time: 42.4,
      request: { method: "GET", url, headers: [{ name: ":authority", value: "a.test" }, { name: "Accept", value: "*/*" }], bodySize: 0 },
      response: { status: 200, statusText: "OK", headers: [{ name: "content-encoding", value: "br" }, { name: "content-type", value: "application/json" }], content: { size: 2, mimeType: "application/json", text: "{}" } },
      timings: { wait: 30.2 },
    });
    const har = { log: { entries: [entry("document", "https://a.test/"), entry("fetch", "https://a.test/api/a"), entry("script", "https://a.test/app.js"), entry("xhr", "https://a.test/api/b"), entry("fetch", "data:text/plain,hi")] } };
    const read = fromHar(har, "https://a.test", "From dev tools", "id");
    expect(read.exchanges.map((e) => [e.seq, e.via, e.request.url])).toEqual([
      [0, "fetch", "https://a.test/api/a"],
      [1, "xhr", "https://a.test/api/b"],
    ]);
    expect(read.exchanges[0]?.request.headers).toEqual([["Accept", "*/*"]]);
    expect(read.exchanges[0]?.response?.headers).toEqual([["content-type", "application/json"]]);
    expect(read.exchanges[0]).toMatchObject({ waitMs: 30, totalMs: 42 });
    expect(() => fromHar({ nope: true }, "o", "n", "i")).toThrow(/not a HAR/);
  });

  it("reads back its own JSON and refuses anything else", () => {
    const back = fromJson(JSON.parse(JSON.stringify(recording)), "new-id");
    expect(back).toMatchObject({ id: "new-id", name: "Checkout", origin: "https://a.test" });
    expect(back.exchanges).toHaveLength(6);
    expect(() => fromJson({ version: 2, exchanges: [] }, "x")).toThrow(/not a Blackbox recording/);
    expect(() => fromJson(null, "x")).toThrow();
  });

  it("writes Mock Service Worker handlers that compile and answer in recorded order", async () => {
    const source = toMsw(recording);
    expect(source).toContain('http.get("https://a.test/api/todos", inOrder([');
    expect(source).toContain('http.delete("https://a.test/api/todos/2"');
    expect(source).not.toContain("/api/down");
    // Run the generated file with a tiny stand-in for the msw package and call its handlers.
    const js = transformSync(source.replace('import { http, HttpResponse } from "msw";', ""), { loader: "ts" }).code.replace("export const handlers", "const handlers");
    const calls: [string, string, () => Response][] = [];
    const http = Object.fromEntries(["get", "post", "put", "patch", "delete", "head", "options", "all"].map((verb) => [verb, (url: string, resolver: () => Response) => calls.push([verb, url, resolver])]));
    new Function("http", "HttpResponse", `${js}; return handlers;`)(http, Response);
    const todos = calls.find(([verb, url]) => verb === "get" && url.endsWith("/api/todos"))?.[2] as () => Response;
    expect(await todos().text()).toBe('[{"id":1}]');
    expect(await todos().text()).toBe('[{"id":1},{"id":2}]');
    expect(await todos().text()).toBe('[{"id":1},{"id":2}]');
    const created = (calls.find(([verb]) => verb === "post")?.[2] as () => Response)();
    expect(created.status).toBe(201);
    expect((calls.find(([verb]) => verb === "delete")?.[2] as () => Response)().status).toBe(204);
    const logo = (calls.find(([, url]) => url.endsWith("logo.png"))?.[2] as () => Response)();
    expect(new Uint8Array(await logo.arrayBuffer())).toHaveLength(8);
  });
});
