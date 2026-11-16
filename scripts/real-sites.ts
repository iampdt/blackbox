// Records and replays real, deployed web apps (my own), to see how the interceptor copes
// with code it was not written alongside.
//
// The extension asks for permission the first time it is used on a site, with a browser
// prompt that automation cannot click. So here the same interceptor is injected by the test
// harness instead, before the page's scripts, exactly where the extension puts it.
//
// For each site: record a visit; then repeat the visit in a fresh browser with every fetch
// and XMLHttpRequest blocked at the network, answering from the recording; then compare what
// the visitor could read.
//
//   npx tsx scripts/real-sites.ts

import { chromium, type Page } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import type { Exchange, Recording, ReplayEvent } from "../src/core/types";

const bundle = (
  await build({
    stdin: {
      contents: `
        import { install } from "./src/core/intercept";
        import { DEFAULT_OPTIONS, MAX_BODY_BYTES } from "./src/core/types";
        const log = { exchanges: [], replays: [] };
        const interceptor = install(window, { onExchange: (e) => log.exchanges.push(e), onReplay: (e) => log.replays.push(e), onDrift: () => {} });
        window.__bb = { log, start: (mode, recording) => interceptor.configure({ mode, recording, options: DEFAULT_OPTIONS, maxBodyBytes: MAX_BODY_BYTES, session: "real-sites" }) };
      `,
      resolveDir: resolve(import.meta.dirname, ".."),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
  })
).outputFiles[0]?.text as string;

interface Site {
  name: string;
  url: string;
  /** What a visitor does. */
  visit(page: Page): Promise<void>;
  /** What they can read at the end, with anything that legitimately differs between two visits left out. */
  read(page: Page): Promise<string>;
}

const text = (page: Page, selector: string) => page.locator(selector).first().innerText();

const SITES: Site[] = [
  {
    name: "Tollgate dashboard (React, fetch, streamed POST)",
    url: "https://tollgate.iampdt.workers.dev/",
    async visit(page) {
      await page.getByText(/tokens today/).waitFor();
      await page.getByLabel("Model or route").selectOption("mock/echo");
      await page.locator("textarea").fill("recorded and replayed by blackbox");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("recorded and replayed by blackbox", { exact: true }).nth(1).waitFor();
      await page.getByRole("link", { name: "Routes" }).click();
      await page.getByRole("heading", { name: "demo-outage" }).waitFor();
    },
    // The route cards: every route, its upstreams and whether each is in use.
    read: (page) => text(page, "main"),
  },
  {
    name: "CodePilot demo (React, static JSON runs)",
    url: "https://codepilot.iampdt.workers.dev/",
    async visit(page) {
      await page.getByRole("link").filter({ hasText: /FastAPI|rate limiter|Rate limiter/i }).first().waitFor();
    },
    read: (page) => text(page, "main"),
  },
  {
    name: "Portfolio (Next.js, client-side navigation)",
    url: "https://pdt001.vercel.app/",
    async visit(page) {
      await page.getByRole("heading", { name: /Five systems/ }).waitFor();
      await page.getByRole("link", { name: /Case study/ }).last().click();
      await page.getByRole("heading", { name: "Tollgate", level: 1 }).waitFor();
    },
    read: (page) => text(page, "article"),
  },
  {
    name: "Lineless (React, live queue over WebSocket)",
    url: "https://lineless.iampdt.workers.dev/",
    async visit(page) {
      await page.getByRole("button", { name: /demo/i }).first().click();
      await page.waitForURL(/\/(q|s|staff|demo)\//, { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
    },
    read: (page) => text(page, "body"),
  },
];

const browser = await chromium.launch();
console.log(`Real sites, recorded then replayed with fetch and XMLHttpRequest blocked at the network. ${new Date().toISOString().slice(0, 10)}\n`);

for (const site of SITES) {
  console.log(site.name);
  try {
    // ── Record ──
    const recordContext = await browser.newContext();
    await recordContext.addInitScript({ content: `${bundle}; window.__bb.start("record");` });
    const recordPage = await recordContext.newPage();
    let sockets = 0;
    recordPage.on("websocket", () => (sockets += 1));
    await recordPage.goto(site.url);
    await site.visit(recordPage);
    await recordPage.waitForTimeout(800); // let bodies finish being captured
    const live = await site.read(recordPage);
    const exchanges = await recordPage.evaluate(() => (window as unknown as { __bb: { log: { exchanges: Omit<Exchange, "seq">[] } } }).__bb.log.exchanges);
    const origin = new URL(site.url).origin;
    const recording: Recording = { version: 1, id: "r", name: site.name, origin, createdAt: Date.now(), exchanges: exchanges.map((exchange, seq) => ({ ...exchange, seq })) };
    const streamed = recording.exchanges.filter((e) => e.response?.chunks).length;
    const viaXhr = recording.exchanges.filter((e) => e.via === "xhr").length;
    await recordContext.close();

    // ── Replay, with the network closed to fetch and XMLHttpRequest ──
    const replayContext = await browser.newContext();
    let blocked = 0;
    await replayContext.route("**/*", (route) => {
      if (["fetch", "xhr"].includes(route.request().resourceType())) {
        blocked += 1;
        return route.abort();
      }
      return route.continue();
    });
    await replayContext.addInitScript({ content: `${bundle}; window.__bb.start("replay", ${JSON.stringify(recording)});` });
    const replayPage = await replayContext.newPage();
    await replayPage.goto(site.url);
    let completed = true;
    await site.visit(replayPage).catch(() => (completed = false));
    await replayPage.waitForTimeout(500);
    const replayed = await site.read(replayPage).catch(() => "");
    const events = await replayPage.evaluate(() => (window as unknown as { __bb: { log: { replays: ReplayEvent[] } } }).__bb.log.replays);
    await replayContext.close();

    const hits = events.filter((e) => e.seq !== null).length;
    const misses = events.filter((e) => e.seq === null);
    console.log(`   recorded ${recording.exchanges.length} API calls (${viaXhr} by XMLHttpRequest, ${streamed} streamed)${sockets ? `; the page also opened ${sockets} WebSocket${sockets > 1 ? "s" : ""}, which are not intercepted` : ""}`);
    console.log(`   replay: ${hits} answered from the recording, ${misses.length} with no recorded answer, ${blocked} reached the network and were blocked`);
    console.log(`   the visit ${completed ? "completed" : "DID NOT complete"}; what the visitor could read was ${replayed === live ? "identical" : "DIFFERENT"} (${live.length} characters)`);
    for (const miss of [...new Set(misses.map((m) => `${m.method} ${new URL(m.url).pathname}${new URL(m.url).search}`))].slice(0, 4)) console.log(`     no answer for: ${miss}`);
    if (process.env.DEBUG) for (const e of recording.exchanges) console.log(`     recorded: ${e.request.method} ${new URL(e.request.url).pathname}${new URL(e.request.url).search} [${e.request.headers.map(([k, v]) => `${k}=${v.slice(0, 24)}`).join(", ")}]`);
  } catch (error) {
    console.log(`   could not be measured: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
  console.log();
}
await browser.close();
