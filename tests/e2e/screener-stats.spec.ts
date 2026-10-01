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
  let body: ReturnType<typeof sample> | Record<string, unknown> = sample();

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
    await expect(stats.locator(".stat > span")).toHaveText([
      "Volume · 24h",
      "Launches · 24h",
      "Traders · 24h",
    ]);
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
    // Page coordinates: the window buttons sit below a phone's first screen
    // under the stacked cards, so clicking one scrolls.
    const launchTop = await page
      .locator(".launch-section")
      .evaluate((node) => node.getBoundingClientRect().top + scrollY);
    await page.evaluate(() => {
      (
        window as typeof window & { screenerStatsMeasurement: { cls: number } }
      ).screenerStatsMeasurement.cls = 0;
    });

    body = sample("7d");
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await expect(stats).toHaveAttribute("aria-busy", "false");
    await expect(stats.locator(".stat > span")).toHaveText([
      "Volume · 7d",
      "Launches · 7d",
      "Traders · 7d",
    ]);
    expect(
      await page
        .locator(".launch-section")
        .evaluate((node) => node.getBoundingClientRect().top + scrollY),
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

    // A same-document window change fires framenavigated too; only a real
    // reload clears this marker.
    await page.evaluate(() => {
      (window as typeof window & { statsDocument?: boolean }).statsDocument =
        true;
    });
    const sameDocument = () =>
      page.evaluate(
        () =>
          (window as typeof window & { statsDocument?: boolean })
            .statsDocument === true,
      );
    body = {
      ...sample("1h"),
      volumeWei: null,
      trades: null,
      activeTraders: null,
      completeWindow: false,
    };
    await page.getByRole("button", { name: "1h", exact: true }).click();
    await expect(stats.locator(".stat > span")).toHaveText([
      "Volume · 1h",
      "Launches · 1h",
      "Traders · 1h",
    ]);
    await expect(stats.locator(".stat").first().locator("strong")).toHaveText(
      "",
    );
    await expect(stats.locator(".stat").nth(2).locator("strong")).toHaveText(
      "",
    );
    await expect(stats).not.toContainText("Window incomplete");
    expect(await sameDocument()).toBe(true);
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
    const stripTop = await stats.evaluate(
      (node) => node.getBoundingClientRect().top,
    );
    const launchTopBeforeFailure = await page
      .locator(".launch-section")
      .evaluate((node) => node.getBoundingClientRect().top);
    await page.getByRole("button", { name: "30d", exact: true }).click();
    await expect(stats).toHaveAttribute("aria-busy", "true");
    await expect(stats).toContainText("Volume · 1h");
    await expect(stats.getByRole("alert")).toContainText(
      "Screener stats unavailable",
    );
    expect(await sameDocument()).toBe(true);
    expect(
      await stats.evaluate((node) => node.getBoundingClientRect().top),
    ).toBe(stripTop);
    expect(
      await page
        .locator(".launch-section")
        .evaluate((node) => node.getBoundingClientRect().top),
    ).toBe(launchTopBeforeFailure);
    if (process.env.QA_STATS_EVIDENCE) {
      await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({
        path: join(
          process.cwd(),
          "docs/evidence/qa-2026-09-30/pools-qa-g-stats-reload",
          `${testInfo.project.name === "mobile" ? "390" : "1440"}-after.png`,
        ),
      });
    }
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
    status = 200;
    body = sample("30d");
    await stats.getByRole("button", { name: "Try again" }).click();
    await expect(stats).toHaveAttribute("aria-busy", "false");
    await expect(stats.locator(".stat")).toHaveCount(3);
    await expect(stats.getByRole("alert")).toHaveCount(0);
    expect(await sameDocument()).toBe(true);

    body = { window: "7d" };
    await page.getByRole("button", { name: "7d", exact: true }).click();
    await expect(stats.getByRole("alert")).toContainText(
      "Screener stats unavailable",
    );
    await expect(stats).toContainText("Volume · 30d");
    expect(await sameDocument()).toBe(true);
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
    await expect(stats.locator(".stat > span")).toHaveText([
      "Volume · All",
      "Launches · All",
      "Traders · All",
    ]);
    await expect(stats).toContainText("64,820");
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
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const labels = await stats.locator(".stat > span").evaluateAll((nodes) =>
        nodes.map((node) => {
          const element = node as HTMLElement;
          return {
            height: element.getBoundingClientRect().height,
            fontSize: parseFloat(getComputedStyle(element).fontSize),
            overflow: element.scrollWidth - element.clientWidth,
          };
        }),
      );
      expect(
        labels.every(
          ({ height, fontSize, overflow }) =>
            height <= fontSize * 1.6 && overflow <= 1,
        ),
      ).toBe(true);
      // A half-width card ellipsised the volume at 320px; under 400px the
      // cards stack full width, as the export draws them, and every figure
      // is shown whole.
      const cards = await stats.locator(".stat").evaluateAll((nodes) =>
        nodes.map((node) => {
          const value = node.querySelector("strong")!;
          return {
            left: Math.round(node.getBoundingClientRect().left),
            clipped: value.scrollWidth > value.clientWidth,
          };
        }),
      );
      expect(cards.map(({ clipped }) => clipped)).toEqual([
        false,
        false,
        false,
      ]);
      expect(new Set(cards.map(({ left }) => left)).size).toBe(1);
    }
  });
});
