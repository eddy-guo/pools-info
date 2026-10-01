import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import captures from "../../data/pools/index.json";
import { poolHref } from "@pools/core";
import {
  creatorAddress,
  creatorLaunches,
  creatorLaunchesPage,
} from "../support/creator-launches";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const savedPool = Object.values(captures.snapshots).find(
  (snapshot) =>
    !chain.markets.some((market) => market.id === snapshot.markets[0].id),
)!.markets[0];
const unknownPool = `0x${"f".repeat(64)}`;
/* `releases`: the fixture answers fewer rows than the page this route
   reserves, so its sentinel keeps its place and may only grow shorter as the
   unfilled rows go. `empty`: that answer has no rows, so no formatted number
   is left to survive. */
const routes: {
  name: string;
  url: string;
  sentinel: string;
  releases?: boolean;
  empty?: boolean;
}[] = [
  {
    name: "screener",
    url: "/",
    sentinel: ".explore-page .workspace-grid",
    releases: true,
  },
  {
    name: "launches",
    url: "/?view=new",
    sentinel: ".explore-page .workspace-grid",
  },
  {
    name: "pool",
    url: poolHref(chain.markets[0]),
    sentinel: ".pool-page .live-six-stats",
  },
  {
    name: "traders",
    url: "/traders/?window=All",
    sentinel: ".leaderboard-panel",
  },
  {
    name: "wallet",
    releases: true,
    url: `/wallet/${wallet}/?window=All`,
    sentinel: ".page .workspace-grid",
  },
  { name: "creators", url: "/creators/", sentinel: ".creators-panel" },
  {
    name: "creator-detail",
    releases: true,
    url: `/creators/${chain.markets[0].launchSender}/`,
    sentinel: ".live-section",
  },
  /* A creator with more launches than a page: the list reserves its 25 rows
     from first paint and the footer under it never paints in view and then
     moves once the table lands (measured at 0.059 on production before). */
  {
    name: "creator-detail-many",
    url: `/creators/${creatorAddress}/`,
    sentinel: ".live-section",
  },
  /* A failed creators read keeps the rows it reserved and overlays its
     failed state on them: the foot and the footer under the board stay
     where they painted (0.1106 at 1440 when the reservation collapsed). */
  {
    name: "creators-failed",
    url: "/creators/",
    sentinel: ".creators-panel",
  },
  /* Answers shorter than the reservation release the rows they do not fill;
     the list above the cut holds still and the nodes under it remount at
     their new place rather than shift into view. */
  {
    name: "screener-no-match",
    releases: true,
    empty: true,
    url: "/?q=zzzzzzzzzz",
    sentinel: ".explore-page .workspace-grid",
  },
  {
    name: "creator-unknown",
    releases: true,
    empty: true,
    url: `/creators/0x${"1".repeat(40)}/`,
    sentinel: ".live-section",
  },
  {
    name: "on-demand-pool",
    url: `/pool/${savedPool.id}/`,
    sentinel: ".nullable-pool-page .live-six-stats",
  },
  {
    name: "unknown-pool",
    url: `/pool/${unknownPool}/`,
    sentinel: ".nullable-pool-page .live-six-stats",
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
    const manyLaunches = creatorLaunches(60, 3);
    await page.route("**/api/product/**", async (route) => {
      if (
        entry.name === "unknown-pool" ||
        (entry.name === "creators-failed" &&
          new URL(route.request().url()).pathname.includes("/creators"))
      ) {
        await gate;
        responses.push(route.request().url());
        return route.fulfill({
          status: 503,
          json: { error: "Saved publication unavailable" },
        });
      }
      const creatorRead =
        entry.name === "creator-detail-many"
          ? creatorLaunchesPage(manyLaunches, route.request().url())
          : null;
      if (creatorRead) {
        await gate;
        responses.push(route.request().url());
        return route.fulfill({ json: creatorRead.json });
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
      /* A preloaded pool paints whole from its snapshot, so it has no
         pending state to show while the saved read is held. */
      if (entry.name !== "pool")
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
      if (entry.name === "screener" || entry.name === "traders") {
        const rowSelector =
          entry.name === "screener"
            ? testInfo.project.name === "desktop"
              ? ".desktop-pools [data-row='resolved']"
              : ".mobile-pools [data-row='resolved']"
            : testInfo.project.name === "desktop"
              ? ".desktop-traders [data-row='resolved']"
              : ".mobile-traders .mobile-trader:has(.address-chip)";
        const row = page.locator(rowSelector).first();
        await expect(row).toBeVisible();
        expect(
          (await row.boundingBox())?.height,
          "address icon targets preserve the row height",
        ).toBe(
          entry.name === "screener"
            ? testInfo.project.name === "desktop"
              ? 62
              : 104
            : testInfo.project.name === "desktop"
              ? 60
              : 101,
        );
      }
      if (entry.name === "screener") {
        const toolbar = page.locator(".explore-toolbar");
        const rects = (selector: string) =>
          toolbar
            .locator(selector)
            .evaluateAll((nodes) =>
              nodes.map((node) => node.getBoundingClientRect().toJSON()),
            );
        const tabs = await rects(".table-tabs button");
        expect(tabs, "all, gainers, new, crowd and watchlist").toHaveLength(5);
        tabs.forEach((tab, index) => {
          expect(tab.y, "tabs share one row").toBe(tabs[0].y);
          if (index)
            expect(
              tab.x - tabs[index - 1].x - tabs[index - 1].width,
              "tabs sit tightly together",
            ).toBeLessThanOrEqual(4);
        });
        /* Sorting moved onto the column headers, so the select and the
           direction button no longer sit in this row. */
        const controls = await rects(".filter-input, .icon-button, .segmented");
        expect(controls, "filter, refresh, window").toHaveLength(3);
        for (const control of controls)
          if (testInfo.project.name === "desktop")
            expect(
              Math.abs(
                control.y + control.height / 2 - tabs[0].y - tabs[0].height / 2,
              ),
              "controls share the single toolbar row with the tabs",
            ).toBeLessThanOrEqual(1);
          else
            expect(control.height, "44px tap targets").toBeGreaterThanOrEqual(
              44,
            );
        if (testInfo.project.name !== "desktop")
          for (const tab of tabs)
            expect(tab.height, "44px tap targets").toBeGreaterThanOrEqual(44);
        expect(
          await toolbar.evaluate(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
          "the toolbar fits its panel",
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
      /* A page of nothing but launches resolves to launch lines, so it holds
         no formatted number to compare against the pending one. */
      if (
        !entry.name.includes("pool") &&
        entry.name !== "launches" &&
        !entry.empty
      )
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
            page.getByRole("heading", {
              name: "Pool name unavailable",
              exact: true,
            }),
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
      if (entry.releases) {
        expect(
          { x: after?.x, y: after?.y, width: after?.width },
          "sentinel keeps its first-paint place",
        ).toEqual({ x: before?.x, y: before?.y, width: before?.width });
        expect(
          after!.height,
          "sentinel only sheds the rows its answer does not fill",
        ).toBeLessThanOrEqual(before!.height);
      } else
        expect(
          after,
          "sentinel retains its complete first-paint geometry",
        ).toEqual(before);
      /* A runner under load can report a sub-pixel shift (observed:
         0.0001277 on this same case, on heads that never touched this page)
         without a real reflow; 0.001 is a sub-pixel of movement at 390px, so
         a score under it reads as measurement noise, not a shift. Anything
         at or above 0.001 still fails. */
      expect(
        measurement.cls,
        "every non-input layout shift since navigation, past 0.001 of sub-pixel measurement noise",
      ).toBeLessThan(0.001);
    } finally {
      releaseScripts();
      release();
    }
  });
}

/* `/traders/` is prerendered with the ranked board's podium and 22 reserved
   rows; a `view=following` URL swaps that for the browser-local Following
   list once hydration reads the URL and the store. With nothing followed the
   served board collapsed to the empty state and the footer moved into view
   (0.0396 at 1440, 0.0703 at 1024), so the served shell must already paint
   the list the store holds. */
const followingCases = [
  { store: "empty", count: 0 },
  { store: "populated", count: 3 },
] as const;
for (const { store, count } of followingCases)
  for (const width of [1440, 1024, 390])
    test(`following view with a ${store} store keeps its served geometry at ${width}`, async ({
      page,
      isMobile,
      request,
    }, testInfo) => {
      test.skip(isMobile !== (width === 390), "one width per project");
      const board = await request.get(
        "/api/product/leaderboard/?window=7d&metric=realized&offset=0&limit=25",
      );
      const followed = (
        (await board.json()) as { items: { address: string }[] }
      ).items
        .slice(0, count)
        .map((wallet) => wallet.address);
      expect(followed).toHaveLength(count);
      await page.setViewportSize({ width, height: isMobile ? 844 : 1000 });
      await page.addInitScript((addresses) => {
        localStorage.setItem(
          "poolsinfo.following.v1",
          JSON.stringify(addresses),
        );
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
              state.shifts.push({ value: shift.value, sources: shift.sources });
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      }, followed);
      /* Holding the client scripts fixes the order: the served shell paints
         alone first, then hydration swaps in the Following view. */
      let releaseScripts!: () => void;
      const scripts = new Promise<void>((resolve) => {
        releaseScripts = resolve;
      });
      await page.route("**/_next/static/**/*.js", async (route) => {
        await scripts;
        await route.continue();
      });
      const rects = () =>
        page.evaluate(() =>
          [".leaderboard-panel", ".footer"].map((selector) =>
            document.querySelector(selector)!.getBoundingClientRect().toJSON(),
          ),
        );
      try {
        await page.goto("/traders/?view=following", { waitUntil: "commit" });
        await expect(page.locator(".footer")).toBeAttached();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const before = await rects();
        await page.screenshot({
          path: testInfo.outputPath(`following-${store}-${width}-served.png`),
        });
        releaseScripts();
        await expect(
          page.getByRole("button", { name: "Following" }),
        ).toHaveAttribute("aria-pressed", "true");
        if (count)
          await expect(
            page
              .locator(".following-traders [data-row=resolved]")
              .filter({ visible: true }),
          ).toHaveCount(count);
        else
          await expect(
            page.getByRole("heading", {
              name: "You are not following anyone yet",
            }),
          ).toBeVisible();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const after = await rects();
        await page.screenshot({
          path: testInfo.outputPath(`following-${store}-${width}-resolved.png`),
        });
        const measurement = await page.evaluate(
          () =>
            (
              window as unknown as {
                layoutMeasurement: { cls: number; shifts: unknown[] };
              }
            ).layoutMeasurement,
        );
        console.log(
          JSON.stringify({ store, width, before, after, ...measurement }),
        );
        expect(after, "panel and footer keep their served geometry").toEqual(
          before,
        );
        expect(
          measurement.cls,
          "every non-input layout shift since navigation, past 0.001 of sub-pixel measurement noise",
        ).toBeLessThan(0.001);
      } finally {
        releaseScripts();
      }
    });
