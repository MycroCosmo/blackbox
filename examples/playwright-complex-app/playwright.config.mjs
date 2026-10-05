import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.mjs",
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "dev-blackbox collect --port 4319",
      url: "http://127.0.0.1:4319/health",
      reuseExistingServer: false,
    },
    {
      command: "node src/server.mjs",
      url: "http://127.0.0.1:4173/health",
      reuseExistingServer: false,
    },
  ],
});
