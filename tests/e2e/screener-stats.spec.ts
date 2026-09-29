import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const webRoot = join(process.cwd(), "apps/web");
const next = join(webRoot, "node_modules/next/dist/bin/next");
const sample = (window = "24h") => ({
  window,
  asOf: 1790000000,
  cutoff: { block: 12345678, hash: `0x${"a".repeat(64)}`, asOf: 1790000000 },
  windowStart: window === "All" ? null : 1789910400,
  volumeWei: "123456789012345678901",
  trades: 1234,
  liquidityWei: null,
  poolsLaunched: 42,
  activeTraders: 123,
  completeWindow: true,
  coverage: {
    catalogPools: 63000,
    processedPools: 62000,
    asOf: 1790000000,
    oldestAsOf: 1790000000,
    generatedAt: "2026-09-28T00:00:00.000Z",
    complete: false,
    registryExhaustive: false,
    pnlScope: "attributed_positions_all_pools",
    measuredPools: 62000,
    activeTraderScope: "attributed_wallets_in_measured_pools",
  },
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(Error("No port"));
      else resolve(address.port);
    });
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test.describe("contract-backed screener stats", () => {
  test.describe.configure({ mode: "serial" });
  let api: Server;
  let app: ChildProcess;
  let origin: string;
  let status = 200;
  let body: ReturnType<typeof sample> = sample();

  test.beforeAll(async () => {
    api = createServer((request, response) => {
      if (!request.url?.startsWith("/v1/stats?")) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          status === 200
            ? body
            : {
                error:
                  status === 404 ? "not_found" : "stats_coverage_unavailable",
              },
        ),
      );
    });
    const apiPort = await listen(api);
    const appPort = await freePort();
    origin = `http://127.0.0.1:${appPort}`;
    app = spawn(
      process.execPath,
      [next, "start", "--hostname", "127.0.0.1", "--port", String(appPort)],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          INDEXER_API_URL: `http://127.0.0.1:${apiPort}`,
          CHAIN_REFRESH_DISABLED: "0",
          PRODUCT_FIXTURES: "1",
        },
        stdio: "ignore",
      },
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      if (app.exitCode !== null)
        throw Error(`Stats test server exited: ${app.exitCode}`);
      try {
        const response = await fetch(origin);
        if (response.ok) return;
      } catch {
        // The child is still starting.
      }
      await delay(250);
    }
    throw Error("Stats test server did not start");
  });

  test.afterAll(async () => {
    if (app && app.exitCode === null) {
      const stopped = new Promise<void>((resolve) =>
        app.once("exit", () => resolve()),
      );
      app.kill("SIGTERM");
      await stopped;
    }
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  test("present, incomplete, and absent stats preserve the screener geometry", async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === "mobile")
      await page.setViewportSize({ width: 390, height: 844 });
    const fixtureOrigin = String(testInfo.project.use.baseURL);
    await page.route("**/api/product/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/product/stats/") return route.continue();
      const fixture = await route.fetch({
        url: `${fixtureOrigin}${url.pathname}${url.search}`,
      });
      return route.fulfill({ response: fixture });
    });
    await page.addInitScript(() => {
      const measurement = { cls: 0, shifts: [] as unknown[] };
      Object.assign(window, { screenerStatsMeasurement: measurement });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
            sources?: {
              node?: Node;
              previousRect?: DOMRectReadOnly;
              currentRect?: DOMRectReadOnly;
            }[];
          };
          if (!shift.hadRecentInput) {
            measurement.cls += shift.value;
            measurement.shifts.push({
              value: shift.value,
              sources: shift.sources?.map((source) => ({
                node: source.node instanceof Element ? source.node.className : source.node?.nodeName,
                html: source.node instanceof Element ? source.node.outerHTML.slice(0, 300) : null,
                parent: source.node instanceof Element ? source.node.parentElement?.outerHTML.slice(0, 300) : null,
                previous: source.previousRect?.toJSON(),
                current: source.currentRect?.toJSON(),
              })),
            });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    status = 200;
    body = sample();
    await page.goto(origin, { waitUntil: "commit" });
    const stats = page.locator(".explore-page .screener-stats");
    await expect(stats).toBeVisible();
    await expect(stats.locator(".stat")).toHaveCount(3);
    await expect(stats).toContainText("Volume");
    await expect(stats).toContainText("Pools launched");
    await expect(stats).toContainText("Traders");
    await expect(stats.getByTitle("Wallets that traded the launches shown")).toBeVisible();
    await expect(stats).not.toContainText("Covered launches");
    await expect(stats).not.toContainText("Liquidity");
    await expect(stats).toContainText("123");
    await expect(
      page.locator(".explore-page [data-row='resolved']").first(),
    ).toBeAttached();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              screenerStatsMeasurement: { cls: number };
            }
          ).screenerStatsMeasurement.cls,
      ),
    ).toBe(0);
    const launchTop = await page
      .locator(".launch-section")
      .evaluate((node) => node.getBoundingClientRect().top);
    await page.evaluate(() => {
      (
        window as typeof window & { screenerStatsMeasurement: { cls: number } }
      ).screenerStatsMeasurement.cls = 0;
    });

    body = sample("7d");
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await expect(stats).toHaveAttribute("aria-busy", "false");
    expect(
      await page
        .locator(".launch-section")
        .evaluate((node) => node.getBoundingClientRect().top),
    ).toBe(launchTop);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              screenerStatsMeasurement: { cls: number };
            }
          ).screenerStatsMeasurement.cls,
      ),
    ).toBe(0);

    body = {
      ...sample("1h"),
      volumeWei: null,
      trades: null,
      activeTraders: null,
      completeWindow: false,
    };
    await page.getByRole("button", { name: "1h", exact: true }).click();
    await expect(stats.locator(".stat")).toHaveCount(2);
    await expect(stats.locator(".stat").first().locator("strong")).toHaveText(
      "",
    );
    await expect(stats).toContainText("Window incomplete");
    await expect(stats).not.toContainText("Traders");
    const compactGap = await page.evaluate(() => {
      const row = document.querySelector(".screener-stats")!;
      const launches = document.querySelector(".launch-section")!;
      return (
        launches.getBoundingClientRect().top -
        row.getBoundingClientRect().bottom
      );
    });
    expect(compactGap).toBeLessThanOrEqual(20);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const cls = await page.evaluate(
      () =>
        (
          window as typeof window & {
            screenerStatsMeasurement: { cls: number };
          }
        ).screenerStatsMeasurement.cls,
    );
    expect(
      cls,
      JSON.stringify(
        await page.evaluate(
          () =>
            (
              window as typeof window & {
                screenerStatsMeasurement: { shifts: unknown[] };
              }
            ).screenerStatsMeasurement.shifts,
        ),
      ),
    ).toBe(0);

    status = 503;
    await page.getByRole("button", { name: "30d", exact: true }).click();
    await expect(stats).toHaveCount(0);
    const headingBottom = await page
      .locator(".page-heading")
      .evaluate((node) => node.getBoundingClientRect().bottom);
    const noStatsTop = await page
      .locator(".launch-section")
      .evaluate((node) => node.getBoundingClientRect().top);
    expect(noStatsTop - headingBottom).toBeLessThanOrEqual(25);
    await expect(
      page.locator(".explore-page [data-row='resolved']").first(),
    ).toBeAttached();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              screenerStatsMeasurement: { cls: number };
            }
          ).screenerStatsMeasurement.cls,
      ),
    ).toBe(0);
    status = 404;
    await page.reload();
    await expect(stats).toHaveCount(0);
  });

  test("All shows the three cards without moving the screener", async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === "mobile")
      await page.setViewportSize({ width: 390, height: 844 });
    const fixtureOrigin = String(testInfo.project.use.baseURL);
    await page.route("**/api/product/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/product/stats/") return route.continue();
      const fixture = await route.fetch({
        url: `${fixtureOrigin}${url.pathname}${url.search}`,
      });
      return route.fulfill({ response: fixture });
    });
    await page.addInitScript(() => {
      const measurement = { cls: 0 };
      Object.assign(window, { screenerStatsMeasurement: measurement });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
          };
          if (!shift.hadRecentInput) measurement.cls += shift.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    status = 200;
    body = {
      ...sample("All"),
      volumeWei: "459760618088033142127280",
      poolsLaunched: 64820,
      activeTraders: 402620,
    };
    await page.goto(`${origin}/?window=All`, { waitUntil: "commit" });
    const stats = page.locator(".explore-page .screener-stats");
    await expect(stats.locator(".stat")).toHaveCount(3);
    await expect(stats).toContainText("Volume");
    await expect(stats).toContainText("Pools launched");
    await expect(stats).toContainText("64,820");
    await expect(stats).toContainText("Traders");
    await expect(stats).toContainText("402,620");
    await expect(
      page.locator(".explore-page [data-row='resolved']").first(),
    ).toBeAttached();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              screenerStatsMeasurement: { cls: number };
            }
          ).screenerStatsMeasurement.cls,
      ),
    ).toBe(0);
  });
});
