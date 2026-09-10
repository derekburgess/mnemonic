import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser", workers: 1, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5199", headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } },
  webServer: { command: "npm run dev:web -- --host 127.0.0.1 --port 5199 --strictPort", url: "http://127.0.0.1:5199", reuseExistingServer: false },
});
