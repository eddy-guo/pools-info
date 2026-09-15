import config from "./playwright.config";
import { defineConfig } from "@playwright/test";

// The market suite starts its own web server against a canonical Postgres
// fixture API, so both ports derive from the base config's per-worktree port:
// the web server on base+3000 (6200-6999) and the fixture API on base+4000
// (7200-7999), clear of the dev, API, Postgres and review ports on a shared
// machine. PLAYWRIGHT_MARKET_PORT and MARKET_API_PORT pin them.
const basePort = Number(new URL(config.use!.baseURL!).port);
const port = Number(process.env.PLAYWRIGHT_MARKET_PORT ?? basePort + 3000);
const apiPort = Number(process.env.MARKET_API_PORT ?? basePort + 4000);
// The spec spawns tests/support/market-server.ts, which listens on this port.
process.env.MARKET_API_PORT = String(apiPort);
const baseURL = `http://127.0.0.1:${port}`;
if (!process.env.TEST_WORKER_INDEX)
  console.log(
    `Market web server: ${baseURL}, fixture API: http://127.0.0.1:${apiPort} (set PLAYWRIGHT_MARKET_PORT and MARKET_API_PORT to pin them)`,
  );

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
  use: { ...config.use, baseURL },
  webServer: {
    command: `pnpm --filter @pools/web start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      CHAIN_REFRESH_DISABLED: "0",
      INDEXER_API_URL: `http://127.0.0.1:${apiPort}`,
      PORT: String(port),
    },
  },
});
