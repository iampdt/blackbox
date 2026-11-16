import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, type TestServer } from "./server";

export const EXTENSION = resolve(import.meta.dirname, "../dist/extension");
export const SITE = resolve(import.meta.dirname, "../dist/site");

export interface Rig {
  context: BrowserContext;
  server: TestServer;
  extensionId: string;
  /** The sample app, opened on its own as a visitor would. */
  app: Page;
  /** The Blackbox panel for the app's site, opened as an extension page. */
  panel: Page;
  close(): Promise<void>;
}

/** A browser with the extension loaded (or not), the sample site served locally, and the app open. */
export async function launch(options: { extension?: boolean } = {}): Promise<Rig> {
  const withExtension = options.extension !== false;
  const server = await startServer(SITE);
  const profile = await mkdtemp(join(tmpdir(), "blackbox-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: withExtension ? [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] : [],
  });
  let extensionId = "";
  if (withExtension) {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
  }
  const app = context.pages()[0] ?? (await context.newPage());
  await app.goto(`${server.origin}/app/`);
  const panel = withExtension ? await context.newPage() : app;
  if (withExtension) await panel.goto(`chrome-extension://${extensionId}/panel.html?origin=${encodeURIComponent(server.origin)}`);
  return {
    context,
    server,
    extensionId,
    app,
    panel,
    async close() {
      await context.close();
      await server.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** Turns Blackbox on for the app's site, which reloads the app with the scripts injected. */
export async function turnOn(rig: Rig): Promise<void> {
  await Promise.all([rig.app.waitForEvent("load"), rig.panel.getByRole("button", { name: "Turn on for this site" }).click()]);
  await rig.panel.getByRole("group", { name: "Mode" }).waitFor();
  await appReady(rig.app);
}

export async function appReady(app: Page): Promise<void> {
  await app.locator("#tasks li").first().waitFor();
  await app.locator("#profile").filter({ hasNotText: "Loading" }).waitFor();
}

export async function setMode(rig: Rig, mode: "Off" | "Record" | "Replay" | "Compare", options: { reload?: boolean } = {}): Promise<void> {
  await rig.panel.getByRole("group", { name: "Mode" }).getByRole("button", { name: mode, exact: true }).click();
  await rig.panel.getByRole("group", { name: "Mode" }).getByRole("button", { name: mode, exact: true, pressed: true }).waitFor();
  if (options.reload) {
    await Promise.all([rig.app.waitForEvent("load"), rig.panel.getByRole("button", { name: "Reload page" }).click()]);
    await rig.app.locator("#tasks li, #error:not([hidden])").first().waitFor();
  }
}

/** What a visitor does in the app: the same steps every time, so two runs can be compared. */
export async function useApp(app: Page): Promise<void> {
  await app.getByPlaceholder("Add a task").fill("Buy milk");
  await app.getByRole("button", { name: "Add", exact: true }).click();
  await app.locator("#tasks li", { hasText: "Buy milk" }).waitFor();
  await app.getByLabel("Done: Renew passport").check();
  await app.locator("#tasks .done", { hasText: "Renew passport" }).waitFor();
  await app.getByLabel("Delete: Call the electrician").click();
  await app.locator("#tasks li", { hasText: "Call the electrician" }).waitFor({ state: "detached" });
  await app.getByRole("button", { name: "Summarise my day" }).click();
  await app.locator("#answer[data-complete=true]").waitFor();
  await app.getByRole("button", { name: "Check backend" }).click();
  await app.locator("#status").filter({ hasText: /Backend/ }).waitFor();
}

/** Everything the visitor can see in the app, for comparing a live run with a replayed one. */
export async function seen(app: Page): Promise<{ profile: string; tasks: string[]; answer: string; status: string; error: string | null }> {
  return app.evaluate(() => ({
    profile: document.getElementById("profile")?.textContent ?? "",
    tasks: [...document.querySelectorAll("#tasks li")].map((item) => `${item.querySelector("input")?.checked ? "[x]" : "[ ]"} ${item.querySelector("span")?.textContent ?? item.textContent}`),
    answer: document.getElementById("answer")?.textContent ?? "",
    status: document.getElementById("status")?.textContent ?? "",
    error: document.getElementById("error")?.hidden ? null : (document.getElementById("error")?.textContent ?? ""),
  }));
}
