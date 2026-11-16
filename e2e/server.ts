// A local stand-in for the demo site, for the browser tests and measurements: the built
// site's static files, and the sample app's API with one task list per session.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { type AppState, freshState, handleApi } from "../site/api";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

export interface TestServer {
  origin: string;
  /** API requests that reached the server, as "METHOD /path". */
  calls: string[];
  /** While true the server drops every API connection, as a machine that is switched off would. */
  down: boolean;
  /** API requests that arrived while it was down. */
  dropped: number;
  /** Extra milliseconds before each API answer. */
  delayMs: number;
  close(): Promise<void>;
}

export async function startServer(root: string, port = 0): Promise<TestServer> {
  const sessions = new Map<string, AppState>();
  const control = { calls: [] as string[], down: false, dropped: 0, delayMs: 0 };

  const server: Server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        if (control.down) {
          control.dropped += 1;
          return void incoming.socket.destroy();
        }
        control.calls.push(`${incoming.method} ${url.pathname}`);
        if (control.delayMs) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
        const session = String(incoming.headers["x-demo-session"] ?? "shared");
        if (!sessions.has(session)) sessions.set(session, freshState());
        const hasBody = !["GET", "HEAD"].includes(incoming.method ?? "GET");
        const request = new Request(url, { method: incoming.method, headers: incoming.headers as Record<string, string>, body: hasBody ? (Readable.toWeb(incoming) as ReadableStream) : undefined, duplex: "half" } as RequestInit);
        const response = (await handleApi(request, sessions.get(session) as AppState, { wordDelayMs: 25 })) ?? new Response("Not found", { status: 404 });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) return void outgoing.end();
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          outgoing.write(value);
        }
        return void outgoing.end();
      }
      const path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
      const body = await readFile(file);
      outgoing.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      outgoing.end(body);
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(404);
      outgoing.end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return Object.assign(control, {
    origin: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  });
}
