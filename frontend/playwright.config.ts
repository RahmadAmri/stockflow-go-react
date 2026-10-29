import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    ...(process.env.PLAYWRIGHT_CHROME_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL }
      : {}),
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: "go run ./cmd/api",
          cwd: "../backend",
          url: "http://127.0.0.1:8080/api/health",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ],
});
