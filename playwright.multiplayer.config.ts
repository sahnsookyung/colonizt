import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "packages/web/tests",
  testMatch: "deployed-multiplayer.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "DATABASE_URL= REDIS_URL= SERVER_HOST=127.0.0.1 SERVER_PORT=8787 npm run dev:server",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "VITE_API_BASE_URL=http://127.0.0.1:8787 npm --workspace @colonizt/web run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
  projects: [{ name: "local-multiplayer-chromium", use: { ...devices["Desktop Chrome"] } }],
});
