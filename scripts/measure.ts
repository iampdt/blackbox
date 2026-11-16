// Measurements taken in a real Chromium with the built extension loaded, against the sample
// app served locally. Run with: npx tsx scripts/measure.ts
//
//   1. What recording and replaying cost per request.
//   2. What having Blackbox switched on costs at page start (it holds the first requests
//      until it knows what mode the site is in).
//   3. Whether a replayed session shows the visitor what the live one did, for several
//      different sessions, with ordered answers and with the simpler "always the first answer".

import type { Page } from "@playwright/test";
import { stat } from "node:fs/promises";
import { appReady, EXTENSION, launch, type Rig, seen, setMode, turnOn } from "../e2e/harness";

const REQUESTS = 300;
const RELOADS = 20;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;
const fmt = (ms: number) => `${ms.toFixed(2)} ms`;

/** N requests one after another from inside the page, each timed from call to complete body. */
function timeRequests(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (n) => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const started = performance.now();
      await (await fetch("/api/health")).text();
      times.push(performance.now() - started);
    }
    return times;
  }, count);
}

/** Reloads the app repeatedly; each time, how long after navigation started the task list appeared. */
async function timeStarts(rig: Rig, count: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    await rig.app.reload();
    await rig.app.locator("#tasks li").first().waitFor();
    times.push(await rig.app.evaluate(() => (window as unknown as { __listAt: number }).__listAt));
  }
  return times;
}

const markList = (page: Page) =>
  page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (document.querySelector("#tasks li")) {
        (window as unknown as { __listAt: number }).__listAt = performance.now();
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });

async function costs(): Promise<void> {
  const row = (label: string, times: number[]) => console.log(`   ${label.padEnd(44)} median ${fmt(median(times)).padStart(9)}   p95 ${fmt(p95(times)).padStart(9)}`);

  const plain = await launch({ extension: false });
  await markList(plain.app);
  await appReady(plain.app);
  await timeRequests(plain.app, 30); // warm up
  const baseRequests = await timeRequests(plain.app, REQUESTS);
  const baseStarts = await timeStarts(plain, RELOADS);
  await plain.close();

  const rig = await launch();
  await markList(rig.app);
  await turnOn(rig);
  await timeRequests(rig.app, 30);
  const offRequests = await timeRequests(rig.app, REQUESTS);
  const offStarts = await timeStarts(rig, RELOADS);

  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  await rig.app.evaluate(() => fetch("/api/health").then((r) => r.text()));
  await setMode(rig, "Off");
  await setMode(rig, "Record");
  const recordRequests = await timeRequests(rig.app, REQUESTS);
  const recordStarts = await timeStarts(rig, RELOADS);
  await setMode(rig, "Off");

  // Replay from the first recording made above: the page's two start-up requests and one health check.
  const select = rig.panel.getByRole("combobox");
  const first = await select.locator("option").last().getAttribute("value");
  await select.selectOption(first);
  rig.server.down = true;
  await setMode(rig, "Replay", { reload: true });
  await appReady(rig.app);
  const replayRequests = await timeRequests(rig.app, REQUESTS);
  const replayStarts = await timeStarts(rig, RELOADS);
  await rig.close();

  console.log(`1. One request from the page, start to complete body (${REQUESTS} in a row, local server)`);
  row("no extension", baseRequests);
  row("Blackbox on, mode off", offRequests);
  row("recording", recordRequests);
  row("replaying (no network)", replayRequests);
  console.log(`   recording adds ${fmt(median(recordRequests) - median(baseRequests))} per request at the median`);

  console.log(`\n2. Page start: navigation to the task list on screen (${RELOADS} reloads)`);
  row("no extension", baseStarts);
  row("Blackbox on, mode off", offStarts);
  row("recording", recordStarts);
  row("replaying, backend switched off", replayStarts);
  console.log(`   being switched on adds ${fmt(median(offStarts) - median(baseStarts))} to page start at the median`);
}

// ── Sessions ──

type Step = (app: Page) => Promise<void>;
const add = (title: string): Step => async (app) => {
  await app.getByPlaceholder("Add a task").fill(title);
  await app.getByRole("button", { name: "Add", exact: true }).click();
  await app.locator("#tasks li", { hasText: title }).or(app.locator("#error:not([hidden])")).first().waitFor();
};
const toggle = (title: string): Step => async (app) => {
  const box = app.getByLabel(`Done: ${title}`);
  const was = await box.isChecked();
  await box.click();
  await app.locator("#tasks li", { hasText: title }).locator(was ? "span:not(.done)" : "span.done").or(app.locator("#error:not([hidden])")).first().waitFor();
};
const remove = (title: string): Step => async (app) => {
  await app.getByLabel(`Delete: ${title}`).click();
  await app.locator("#tasks li", { hasText: title }).waitFor({ state: "detached" });
};
const summarise: Step = async (app) => {
  await app.locator("#answer").evaluate((node) => node.removeAttribute("data-complete"));
  await app.getByRole("button", { name: "Summarise my day" }).click();
  await app.locator("#answer[data-complete=true]").or(app.locator("#error:not([hidden])")).first().waitFor();
};
const health: Step = async (app) => {
  await app.getByRole("button", { name: "Check backend" }).click();
  await app.locator("#status").filter({ hasText: /Backend/ }).waitFor();
};
const reload: Step = async (app) => {
  await app.reload();
  await appReady(app);
};

const SESSIONS: [name: string, steps: Step[]][] = [
  ["look, then leave", [health]],
  ["add one task", [add("Buy milk"), summarise]],
  ["add, tick, delete, summarise", [add("Buy milk"), toggle("Renew passport"), remove("Call the electrician"), summarise, health]],
  ["tick and untick the same task", [toggle("Renew passport"), toggle("Renew passport"), toggle("Renew passport"), summarise]],
  ["three adds, summarise between each", [add("One"), summarise, add("Two"), summarise, add("Three"), summarise]],
  ["empty the list", [remove("Book train tickets"), remove("Renew passport"), remove("Call the electrician"), summarise, health]],
  ["change, reload the page, change again", [add("Before reload"), reload, toggle("Before reload"), summarise]],
  ["same change twice", [add("Twin"), add("Twin"), remove("Book train tickets"), summarise]],
];

async function play(rig: Rig, steps: Step[]): Promise<string> {
  // A step that cannot finish (a replay gone wrong leaves the page waiting for something
  // that will not come) should be given up on quickly; what the visitor sees is compared anyway.
  rig.app.setDefaultTimeout(4000);
  const views: unknown[] = [];
  for (const step of steps) {
    await step(rig.app).catch(() => undefined);
    views.push(await seen(rig.app));
  }
  return JSON.stringify(views);
}

async function sequenceSetting(rig: Rig, label: RegExp): Promise<void> {
  await rig.panel.getByRole("button", { name: "Settings" }).click();
  await rig.panel.getByLabel(label).check();
  await rig.panel.getByRole("button", { name: "Save settings" }).click();
  await rig.panel.getByRole("button", { name: /^Requests/ }).click();
}

async function sessions(): Promise<void> {
  console.log(`\n3. Does a replay show the visitor what the live session did? (${SESSIONS.length} sessions; compared after every step)`);
  console.log(`   ${"session".padEnd(40)} requests   ordered answers   always the first answer`);
  let ordered = 0;
  let first = 0;
  for (const [name, steps] of SESSIONS) {
    const rig = await launch();
    await turnOn(rig);
    await setMode(rig, "Record", { reload: true });
    await appReady(rig.app);
    const live = await play(rig, steps);
    const count = await rig.panel.locator("tbody tr").count();
    rig.server.down = true;

    await setMode(rig, "Replay", { reload: true });
    await appReady(rig.app);
    const sameOrdered = (await play(rig, steps)) === live;

    await setMode(rig, "Off");
    await sequenceSetting(rig, /Always give the first answer/);
    await setMode(rig, "Replay", { reload: true });
    await rig.app.locator("#tasks li").first().waitFor();
    const sameFirst = (await play(rig, steps)) === live;
    const reached = rig.server.dropped;
    await rig.close();

    ordered += Number(sameOrdered);
    first += Number(sameFirst);
    console.log(`   ${name.padEnd(40)} ${String(count).padStart(8)}   ${(sameOrdered ? "same" : "DIFFERENT").padEnd(17)} ${sameFirst ? "same" : "different"}${reached ? `   (${reached} requests reached the dead server)` : ""}`);
  }
  console.log(`   identical to the live session: ${ordered} of ${SESSIONS.length} with ordered answers, ${first} of ${SESSIONS.length} with always-the-first`);
}

async function offScript(): Promise<void> {
  console.log("\n4. Replaying a different session from the one recorded (ordered answers)");
  const rig = await launch();
  await turnOn(rig);
  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  await play(rig, [add("Buy milk"), toggle("Renew passport"), summarise]);
  rig.server.down = true;
  await setMode(rig, "Replay", { reload: true });
  await appReady(rig.app);
  // The same two changes in the other order, then something never recorded.
  rig.app.setDefaultTimeout(4000);
  await toggle("Renew passport")(rig.app).catch(() => undefined);
  const afterToggle = await seen(rig.app);
  await add("Buy milk")(rig.app).catch(() => undefined);
  const afterAdd = await seen(rig.app);
  await add("Never recorded")(rig.app).catch(() => undefined);
  const afterNew = await seen(rig.app);
  console.log(`   recorded: add "Buy milk", then tick "Renew passport". Replayed: tick first, then add.`);
  console.log(`   a real backend would show, after the tick:  [x] Book train tickets | [x] Renew passport | [ ] Call the electrician`);
  console.log(`   after the tick, the list shows:  ${afterToggle.tasks.join(" | ")}`);
  console.log(`   after the add, the list shows:   ${afterAdd.tasks.join(" | ")}`);
  console.log(`   then a task that was never recorded: ${afterNew.error ? `the app shows an error ("${afterNew.error}")` : "no error"}`);
  console.log(`   requests that reached the dead server: ${rig.server.dropped}`);
  await rig.close();
}

const only = process.env.ONLY;
if (!only) console.log(`Chromium with the built extension, sample app on a local server. ${new Date().toISOString().slice(0, 10)}\n`);
if (!only || only === "1") await costs();
if (!only || only === "3") await sessions();
if (!only || only === "4") await offScript();
if (only) process.exit(0);
const size = async (file: string) => (await stat(`${EXTENSION}/${file}`)).size;
console.log(`\n5. Size: the script injected into a page is ${((await size("page.js")) / 1024).toFixed(1)} KB; its bridge is ${((await size("bridge.js")) / 1024).toFixed(1)} KB; the background worker ${((await size("background.js")) / 1024).toFixed(1)} KB.`);
