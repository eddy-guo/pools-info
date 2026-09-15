import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import captures from "../../data/pools/index.json";
import { poolHref } from "@pools/core";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const savedPool = Object.values(captures.snapshots).find(
  (snapshot) =>
    !chain.markets.some((market) => market.id === snapshot.markets[0].id),
)!.markets[0];
const unknownPool = `0x${"f".repeat(64)}`;
const routes = [
  { name: "screener", url: "/", sentinel: ".explore-page .workspace-grid" },
  {
    name: "pool",
    url: poolHref(chain.markets[0]),
    sentinel: ".page .workspace-grid",
  },
  {
    name: "traders",
    url: "/traders/?window=All",
    sentinel: ".leaderboard-panel",
  },
  {
    name: "wallet",
    url: `/wallet/${wallet}/?window=All`,
    sentinel: ".page .workspace-grid",
  },
  {
    name: "on-demand-pool",
    url: `/pool/${savedPool.id}/`,
    sentinel: ".nullable-pool-page .workspace-grid",
  },
  {
    name: "unknown-pool",
    url: `/pool/${unknownPool}/`,
    sentinel: ".nullable-pool-page .workspace-grid",
  },
];

for (const entry of routes) {
  test(`${entry.name} retains first-paint geometry as real saved data resolves`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      const state = { cls: 0, shifts: [] as unknown[] };
      Object.assign(window, { layoutMeasurement: state });
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const shift = raw as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
            sources?: unknown[];
          };
          if (!shift.hadRecentInput) {
            state.cls += shift.value;
            state.shifts.push({
              value: shift.value,
              startTime: shift.startTime,
              sources: shift.sources,
            });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responses: string[] = [];
    let releaseScripts!: () => void;
    const scripts = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    await page.route("**/_next/static/**/*.js", async (route) => {
      await scripts;
      await route.continue();
    });
    await page.route("**/api/product/**", async (route) => {
      if (entry.name === "unknown-pool") {
        await gate;
        responses.push(route.request().url());
        return route.fulfill({
          status: 503,
          json: { error: "Saved publication unavailable" },
        });
      }
      const response = await route.fetch();
      await gate;
      responses.push(route.request().url());
      await route.fulfill({ response });
    });
    try {
      await page.goto(entry.url, { waitUntil: "commit" });
      const sentinel = page.locator(entry.sentinel).first();
      await expect(sentinel).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const before = await sentinel.boundingBox();
      await page.evaluate(() =>
        Object.assign(window, {
          firstPendingRow: document.querySelector(".page tbody tr"),
          firstPendingNumber: document.querySelector(".page tbody tr .number"),
          poolPendingPrice: document.querySelector(
            ".nullable-pool-page .live-price-heading > .price",
          ),
        }),
      );
      await page.screenshot({
        path: testInfo.outputPath(`${entry.name}-pending.png`),
        fullPage: false,
      });
      releaseScripts();
      await expect
        .poll(() => page.locator('[data-pending="true"]:visible').count())
        .toBeGreaterThan(0);
      if (entry.name === "screener") {
        const pending = page
          .locator('[data-pending="true"]')
          .filter({ visible: true })
          .first();
        await expect(pending).toHaveCSS("animation-duration", "1.8s");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(pending).toHaveCSS("animation-name", "none");
      }
      release();
      await page.waitForLoadState("networkidle");
      await expect.poll(() => responses.length).toBeGreaterThan(0);
      await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
      const after = await sentinel.boundingBox();
      if (entry.name === "screener") {
        const controls = page.locator(".explore-controls");
        const input = await controls.locator("input").boundingBox();
        const direction = await controls.locator("button").nth(0).boundingBox();
        const refresh = await controls.locator("button").nth(1).boundingBox();
        expect(
          input!.width,
          "the full filter placeholder has room",
        ).toBeGreaterThan(300);
        expect(
          direction!.y,
          "both actions occupy the deliberate second action row",
        ).toBe(refresh!.y);
        expect(refresh!.y).toBeGreaterThan(input!.y);
        expect(
          await controls.evaluate(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
          "controls fit their panel",
        ).toBe(true);
      }
      if (!entry.name.includes("pool"))
        expect(
          await page.evaluate(
            () =>
              document.querySelector(".page tbody tr") ===
              (window as unknown as { firstPendingRow: Element | null })
                .firstPendingRow,
          ),
          "the first real table row survives hydration and data resolution",
        ).toBe(true);
      if (!entry.name.includes("pool"))
        expect(
          await page.evaluate(() => {
            const saved = (
              window as unknown as { firstPendingNumber: Element | null }
            ).firstPendingNumber;
            return (
              saved !== null &&
              saved === document.querySelector(".page tbody tr .number")
            );
          }),
          "the first formatted numeric node survives hydration and data resolution",
        ).toBe(true);
      if (entry.name === "on-demand-pool" || entry.name === "unknown-pool") {
        expect(
          await page.evaluate(
            () =>
              document.querySelector(
                ".nullable-pool-page .live-price-heading > .price",
              ) ===
              (window as unknown as { poolPendingPrice: Element | null })
                .poolPendingPrice,
          ),
          "the real pool price node survives publication or error",
        ).toBe(true);
        if (entry.name === "on-demand-pool")
          await expect(
            page.getByRole("heading", { name: savedPool.name, exact: true }),
          ).toBeVisible();
        else
          await expect(
            page
              .getByRole("status")
              .filter({ hasText: "Saved pool is temporarily unavailable" }),
          ).toBeVisible();
      }
      await page.screenshot({
        path: testInfo.outputPath(`${entry.name}-resolved.png`),
        fullPage: false,
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const measurement = await page.evaluate(
        () =>
          (
            window as unknown as {
              layoutMeasurement: { cls: number; shifts: unknown[] };
            }
          ).layoutMeasurement,
      );
      console.log(
        JSON.stringify({
          route: entry.name,
          viewport: testInfo.project.name,
          before,
          after,
          ...measurement,
        }),
      );
      await testInfo.attach("layout-measurement", {
        body: JSON.stringify(
          {
            route: entry.name,
            viewport: testInfo.project.name,
            before,
            after,
            ...measurement,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(
        after,
        "sentinel retains its complete first-paint geometry",
      ).toEqual(before);
      expect(
        measurement.cls,
        "every non-input layout shift since navigation",
      ).toBe(0);
    } finally {
      releaseScripts();
      release();
    }
  });
}
