import { createHash } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// Each checkout of this repo gets its own web server port so that concurrent
// suites on one machine never reuse another worktree's server and test its
// build. PLAYWRIGHT_WEB_PORT pins the port; otherwise it is a stable hash of
// the checkout path into 3200-3999, clear of next dev (3100) and the API (3102).
function webServerPort(): number {
  const pinned = process.env.PLAYWRIGHT_WEB_PORT;
  if (pinned) {
    const port = Number(pinned);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(
        `PLAYWRIGHT_WEB_PORT must be a TCP port, got "${pinned}"`,
      );
    return port;
  }
  const digest = createHash("sha256").update(__dirname).digest();
  return 3200 + (digest.readUInt32BE(0) % 800);
}

const port = webServerPort();
const baseURL = `http://127.0.0.1:${port}`;
// Workers evaluate this file too; only the runner announces the port.
if (!process.env.TEST_WORKER_INDEX)
  console.log(
    `Playwright web server: ${baseURL} (set PLAYWRIGHT_WEB_PORT to pin it)`,
  );

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: "**/broad-explore.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `pnpm --filter @pools/web start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: { CHAIN_REFRESH_DISABLED: "1", PORT: String(port) },
  },
});
