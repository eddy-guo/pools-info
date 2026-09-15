import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  ...config,
  testMatch: "broad-explore.spec.ts",
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  outputDir: "test-results-market",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-market" }],
  ],
  use: { ...config.use, baseURL: "http://127.0.0.1:3117" },
  webServer: {
    command: "pnpm --filter @pools/web start --hostname 127.0.0.1 --port 3117",
    url: "http://127.0.0.1:3117",
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      CHAIN_REFRESH_DISABLED: "0",
      INDEXER_API_URL: "http://127.0.0.1:43119",
    },
  },
});
