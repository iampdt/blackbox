import { defineConfig } from "@playwright/test";

// The tests drive a real Chromium with the built extension loaded, one at a time: each
// launches its own browser profile.
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
});
