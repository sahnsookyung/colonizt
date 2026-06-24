import { defineConfig, devices } from "@playwright/test";

const publicWebUrl = process.env.PUBLIC_WEB_URL ?? "https://example.invalid";

export default defineConfig({
  testDir: "packages/web/tests",
  testMatch: "deployed-multiplayer.spec.ts",
  timeout: Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000),
  use: {
    baseURL: publicWebUrl,
    trace: "on-first-retry",
  },
  projects: [
    { name: "deployed-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "deployed-mobile", use: { ...devices["Pixel 7"] } },
  ],
});
