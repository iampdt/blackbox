// Takes the screenshots used in the README: the public demo page mid-replay with the
// backend "down", and the extension's own panel after recording the sample app.
//
//   npx tsx scripts/screenshots.ts [demo-url]

import { chromium } from "@playwright/test";
import { appReady, launch, setMode, turnOn, useApp } from "../e2e/harness";

const demoUrl = process.argv[2] ?? "https://blackbox.iampdt.workers.dev/";
const out = (name: string) => new URL(`../docs/images/${name}`, import.meta.url).pathname;

// ── The demo page ──
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", deviceScaleFactor: 2 });
await page.goto(demoUrl);
const app = page.frameLocator('iframe[title="Sample task app"]');
const mode = (name: string) => page.getByRole("group", { name: "Mode" }).getByRole("button", { name, exact: true });
await app.locator("#tasks li").first().waitFor();
const status = (text: string) => page.getByTestId("status").filter({ hasText: text }).waitFor();
const useIt = async () => {
  await app.getByPlaceholder("Add a task").fill("Buy milk");
  await app.getByRole("button", { name: "Add", exact: true }).click();
  await app.locator("#tasks li", { hasText: "Buy milk" }).waitFor();
  await app.getByLabel("Done: Renew passport").check();
  await app.locator("#tasks .done", { hasText: "Renew passport" }).waitFor();
  await app.getByRole("button", { name: "Summarise my day" }).click();
  await app.locator("#answer[data-complete=true]").waitFor();
};
await mode("Record").click();
await status("2 requests so far");
await useIt();
await status("7 requests so far");
await mode("Off").click();
await app.getByLabel("Simulate a backend outage").check();
await app.locator("#error:not([hidden])").waitFor();
await mode("Replay").click();
await status("2 answered from the recording");
await useIt();
await status("7 answered from the recording");
await page.locator("#app-title").scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: out("demo.png") });
console.log("demo:", await page.getByTestId("status").innerText());
await browser.close();

// ── The extension's panel ──
const rig = await launch();
await turnOn(rig);
await setMode(rig, "Record", { reload: true });
await appReady(rig.app);
await useApp(rig.app);
await rig.panel.setViewportSize({ width: 1440, height: 820 });
await rig.panel.emulateMedia({ colorScheme: "dark" });
await rig.panel.locator("tbody tr").filter({ hasText: "/api/assistant" }).click();
await rig.panel.getByText(/Arrived as a stream/).waitFor();
await rig.panel.screenshot({ path: out("panel.png") });
console.log("panel:", await rig.panel.getByTestId("status").innerText());
await rig.close();
