import { chromium, expect, test } from "@playwright/test";
import { SITE } from "./harness";
import { startServer } from "./server";

// The public demo page: the sample app in a frame, with Blackbox's interceptor loaded by the
// page itself. No extension is involved, so this runs in an ordinary browser.
test("the demo page records and replays the framed app without the extension", async () => {
  const server = await startServer(SITE);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(server.origin);
    const app = page.frameLocator('iframe[title="Sample task app"]');
    const mode = (name: string) => page.getByRole("group", { name: "Mode" }).getByRole("button", { name, exact: true });
    await app.locator("#tasks li").first().waitFor();

    const useIt = async () => {
      await app.getByPlaceholder("Add a task").fill("Water the plants");
      await app.getByRole("button", { name: "Add", exact: true }).click();
      await app.locator("#tasks li", { hasText: "Water the plants" }).waitFor();
      await app.getByLabel("Done: Renew passport").check();
      await app.locator("#tasks .done", { hasText: "Renew passport" }).waitFor();
      await app.getByRole("button", { name: "Summarise my day" }).click();
      await app.locator("#answer[data-complete=true]").waitFor();
    };
    const view = () => app.locator("#app").innerText();

    // Record reloads the framed app, so its start-up requests (the list, the profile) are captured.
    await mode("Record").click();
    await expect(page.getByTestId("status")).toContainText("2 requests so far");
    await useIt();
    await expect(page.getByTestId("status")).toContainText("7 requests so far");
    const live = await view();
    expect(live).toContain("Water the plants");

    await mode("Off").click();
    await app.getByLabel("Simulate a backend outage").check();
    await expect(app.locator("#error")).toBeVisible();

    // Replay reloads the app again. The outage is still on, and the app starts and works.
    server.calls.length = 0;
    await mode("Replay").click();
    await expect(page.getByTestId("status")).toContainText("2 answered from the recording");
    await expect(app.locator("#error")).toBeHidden();
    await expect(app.locator("#tasks li")).toHaveCount(3);
    await useIt();
    expect(await view()).toBe(live);
    expect(server.calls).toEqual([]);
    await expect(page.getByTestId("status")).toContainText("7 answered from the recording, 0 with no recorded answer");

    // The panel on this page is styled: its mode switch is a row of real buttons, not bare text.
    const pressed = mode("Replay");
    expect(await pressed.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  } finally {
    await browser.close();
    await server.close();
  }
});
