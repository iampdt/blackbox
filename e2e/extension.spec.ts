import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { appReady, launch, type Rig, seen, setMode, turnOn, useApp } from "./harness";

let rig: Rig;
test.beforeEach(async () => {
  rig = await launch();
});
test.afterEach(async () => {
  await rig.close();
});

const nativeFetch = (rig: Rig) => rig.app.evaluate(() => /\[native code\]/.test(window.fetch.toString()));
const status = (rig: Rig) => rig.panel.getByTestId("status");

test("does nothing to a site until it is turned on", async () => {
  expect(await nativeFetch(rig)).toBe(true);
  await expect(status(rig)).toHaveText("Blackbox is not running on this site.");
  await turnOn(rig);
  expect(await nativeFetch(rig)).toBe(false);
  await expect(status(rig)).toHaveText("Idle. Requests go to the network untouched.");
  // Still a working app: with the mode off, requests pass straight through.
  expect((await seen(rig.app)).tasks).toHaveLength(3);
});

test("records a session, then replays it with the backend switched off", async () => {
  await turnOn(rig);
  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  await useApp(rig.app);
  const live = await seen(rig.app);
  expect(live.tasks).toEqual(["[x] Book train tickets", "[x] Renew passport", "[ ] Buy milk"]);
  expect(live.answer).toContain("You have 3 tasks");

  // The page's first requests are in the recording: the scripts were in place before the app's own.
  await expect(status(rig)).toContainText("10 requests so far");
  const rows = rig.panel.locator("tbody tr");
  await expect(rows).toHaveCount(10);
  const paths = await rows.evaluateAll((trs) => trs.map((tr) => `${tr.children[1]?.textContent} ${tr.children[2]?.textContent} ${tr.children[3]?.textContent}`));
  expect(paths.slice(0, 2).sort()).toEqual(["GET /api/profile 200", "GET /api/tasks 200"]);
  expect(paths).toEqual(expect.arrayContaining(["POST /api/tasks 201", "PATCH /api/tasks/2 200", "DELETE /api/tasks/3 204", "POST /api/assistant 200"]));
  expect(paths.filter((p) => p === "GET /api/tasks 200")).toHaveLength(4);

  // The streamed answer was recorded piece by piece.
  await rows.filter({ hasText: "/api/assistant" }).click();
  await expect(rig.panel.getByText(/Arrived as a stream, in \d+ pieces/)).toBeVisible();
  // The profile went out through XMLHttpRequest.
  await rows.filter({ hasText: "/api/profile" }).click();
  await expect(rig.panel.getByText(/sent by XMLHttpRequest/)).toBeVisible();

  // Switch the backend off for real, and replay.
  rig.server.down = true;
  rig.server.calls.length = 0;
  await setMode(rig, "Replay", { reload: true });
  await appReady(rig.app);
  await useApp(rig.app);
  expect(await seen(rig.app)).toEqual(live);
  expect(rig.server.calls).toEqual([]);
  await expect(status(rig)).toContainText("10 answered from the recording, 0 with no recorded answer");

  // Something that was never recorded fails the way a dead network does, and the panel says which.
  await rig.app.getByPlaceholder("Add a task").fill("Something new");
  await rig.app.getByRole("button", { name: "Add", exact: true }).click();
  await expect(rig.app.locator("#error")).toBeVisible();
  await expect(rig.panel.getByTestId("misses")).toContainText("POST /api/tasks");
  expect(rig.server.calls).toEqual([]);
});

test("a reload in the middle of a replay carries on, and \"Start over\" goes back to the beginning", async () => {
  await turnOn(rig);
  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  const addTask = async (title: string) => {
    await rig.app.getByPlaceholder("Add a task").fill(title);
    await rig.app.getByRole("button", { name: "Add", exact: true }).click();
    await rig.app.locator("#tasks li", { hasText: title }).waitFor();
  };
  await addTask("Before the reload");
  await rig.app.reload();
  await appReady(rig.app);
  await addTask("After the reload");
  const live = await seen(rig.app);
  expect(live.tasks).toHaveLength(5);

  rig.server.down = true;
  await setMode(rig, "Replay", { reload: true });
  await appReady(rig.app);
  expect((await seen(rig.app)).tasks).toHaveLength(3);
  await addTask("Before the reload");
  await rig.app.reload();
  await appReady(rig.app);
  // The reloaded page sees the list as it stood, not the list from the start of the recording.
  expect((await seen(rig.app)).tasks).toHaveLength(4);
  await addTask("After the reload");
  expect(await seen(rig.app)).toEqual(live);

  await Promise.all([rig.app.waitForEvent("load"), rig.panel.getByRole("button", { name: "Start over" }).click()]);
  await appReady(rig.app);
  expect((await seen(rig.app)).tasks).toHaveLength(3);
});

test("without Blackbox the same outage breaks the app", async () => {
  rig.server.down = true;
  await rig.app.reload();
  await expect(rig.app.locator("#error")).toBeVisible();
  expect((await seen(rig.app)).tasks).toEqual([]);
});

test("reports how the API's answers changed shape since the recording", async () => {
  await turnOn(rig);
  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  await setMode(rig, "Off");

  await rig.app.getByLabel(/Serve version 2/).check();
  await setMode(rig, "Compare", { reload: true });
  await appReady(rig.app);
  await rig.panel.getByRole("button", { name: /^Changes/ }).click();
  const changes = rig.panel.locator("li", { hasText: "/api/tasks" }).first();
  await expect(changes).toContainText("[].id: was number, now string");
  await expect(changes).toContainText("[].done: field is gone (was boolean)");
  await expect(changes).toContainText("[].completed: new field (boolean)");
  await expect(changes).toContainText("[].updatedAt: new field (string)");
  // The app itself was talking to the real backend throughout.
  expect(rig.server.calls).toContain("GET /api/tasks");
  await expect(rig.panel.getByText(/answers checked\. 1 changed shape/)).toBeVisible();
});

test("exports a recording as a HAR with credentials removed, and reads it back in", async () => {
  await turnOn(rig);
  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  // A request carrying a token, as a logged-in app would send.
  await rig.app.evaluate(() => fetch("/api/health?access_token=sk_live_12345", { headers: { Authorization: "Bearer secret-token-abcdef" } }).then((r) => r.text()));
  await expect(rig.panel.locator("tbody tr")).toHaveCount(3);
  await setMode(rig, "Off");

  await rig.panel.getByRole("button", { name: /^Recordings/ }).click();
  const [download] = await Promise.all([rig.panel.waitForEvent("download"), rig.panel.getByRole("button", { name: "HAR", exact: true }).click()]);
  const text = await readFile(await download.path(), "utf8");
  expect(text).not.toContain("sk_live_12345");
  expect(text).not.toContain("secret-token-abcdef");
  const har = JSON.parse(text) as { log: { version: string; entries: { request: { url: string } }[] } };
  expect(har.log.version).toBe("1.2");
  expect(har.log.entries).toHaveLength(3);
  expect(har.log.entries.map((e) => new URL(e.request.url).pathname).sort()).toEqual(["/api/health", "/api/profile", "/api/tasks"]);

  await rig.panel.getByLabel("Recording file to import").setInputFiles({ name: "from-devtools.har", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(rig.panel.locator("li", { hasText: "from-devtools" })).toContainText("3 requests");
});

test("keeps its recordings and its mode when the browser stops its background worker", async () => {
  await turnOn(rig);
  await setMode(rig, "Record", { reload: true });
  await appReady(rig.app);
  await expect(rig.panel.locator("tbody tr")).toHaveCount(2);

  // What Chrome does to an idle extension: stop the worker. The next message starts a fresh one.
  const client = await rig.context.newCDPSession(rig.panel);
  const statuses: string[] = [];
  client.on("ServiceWorker.workerVersionUpdated", (event) => statuses.push(...event.versions.map((version) => version.runningStatus)));
  await client.send("ServiceWorker.enable");
  await client.send("ServiceWorker.stopAllWorkers");
  await expect.poll(() => statuses).toContain("stopped");

  await rig.app.getByRole("button", { name: "Check backend" }).click();
  await rig.app.locator("#status").filter({ hasText: /Backend is up/ }).waitFor();
  await expect(rig.panel.locator("tbody tr")).toHaveCount(3);
  await rig.panel.reload();
  await expect(status(rig)).toContainText("3 requests so far");
});

test("stands down when turned off for the site", async () => {
  await turnOn(rig);
  await rig.panel.getByRole("button", { name: "Settings" }).click();
  await rig.panel.getByRole("button", { name: "Turn off for this site" }).click();
  await expect(status(rig)).toHaveText("Blackbox is not running on this site.");
  await rig.app.reload();
  await appReady(rig.app);
  expect(await nativeFetch(rig)).toBe(true);
});
