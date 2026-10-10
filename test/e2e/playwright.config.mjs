import { defineConfig, devices } from "@playwright/test";

const webUrl = process.env.KLETIA_E2E_WEB_URL ?? "http://127.0.0.1:5174";
const apiUrl = process.env.KLETIA_E2E_API_URL ?? "http://127.0.0.1:3001";
const executablePath = process.env.KLETIA_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  outputDir: "../../test-results",
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1365, height: 900 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npm run dev:api",
      url: `${apiUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { PORT: "3001", NODE_ENV: "development" },
    },
    {
      command: "npm run dev:web",
      url: webUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_BACKEND_URL: apiUrl },
    },
  ],
});
