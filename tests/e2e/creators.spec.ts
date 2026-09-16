import { test, expect, type Page } from "@playwright/test";
import catalog from "../../data/catalog/chain.json";
import {
  buildAnalyticsModel,
  exploreAnalytics,
  type AnalyticsExploreOptions,
  type CatalogPool,
} from "@pools/core";

/** 2,500 launch-only pools across 1,750 senders: one automatic batch plus a Load more remainder. */
const template = catalog.pools[0] as CatalogPool;
const senders = Array.from(
  { length: 1750 },
  (_, i) => `0x${i.toString(16).padStart(40, "a")}`,
);
const pools: CatalogPool[] = Array.from({ length: 2500 }, (_, i) => ({
  ...template,
  id: `0x${i.toString(16).padStart(64, "0")}`,
  token: `0x${i.toString(16).padStart(40, "0")}`,
  launchTx: `0x${i.toString(16).padStart(64, "1")}`,
  symbol: `P${i}`,
  name: `Pool ${i}`,
  launchSender: senders[i % senders.length],
  launchBlock: template.launchBlock + i,
  launchedAt: template.launchedAt + i,
}));
const model = buildAnalyticsModel(pools, []);
const creators = (count: number) =>
  new Set(
    exploreAnalytics(model, { sort: "launch", limit: count }).items.map(
      (pool) => pool.launchSender,
    ),
  ).size;
const removedCopy = [
  "Launches grouped by transaction sender",
  "with saved analytics",
  "Coverage and methodology",
  "Loading the saved creator catalog",
  "Totals are partial",
  "Who launches pools, how often, and how their launches trade.",
  /Loading creators/,
  /of 2,500 pools/,
  /\d creators$/,
  /covered/,
];

/** Serves the synthetic catalog and counts the 100-row pages the creators page streams. */
async function serveCatalog(page: Page) {
  const pages: string[] = [];
  await page.route("**/api/product/explore**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") === "100") pages.push(route.request().url());
    await route.fulfill({
      json: {
        ...exploreAnalytics(model, {
          window: (params.get("window") ?? "24h") as "24h",
          sort: (params.get("sort") ??
            "launch") as AnalyticsExploreOptions["sort"],
          q: params.get("q") ?? "",
          limit: Number(params.get("limit") ?? 25),
          offset: Number(params.get("offset") ?? 0),
        }),
        delivery: { source: "indexer", notice: null },
      },
    });
  });
  return pages;
}

/** Twenty pages stream back to back; give them the same patience a real network gets. */
const streaming = { timeout: 30_000 };

/** Geometry relative to the document, so the test's own scrolling cannot masquerade as a shift. */
function documentBox(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return {
      x: rect.x + scrollX,
      y: rect.y + scrollY,
      width: rect.width,
      height: rect.height,
    };
  }, selector);
}

function observeLayoutShifts(page: Page) {
  return page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { layoutMeasurement: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

test("creators stream one bounded batch into a virtualised, layout-stable table", async ({
  page,
}) => {
  await observeLayoutShifts(page);
  const pages = await serveCatalog(page);
  await page.goto("/creators/", { waitUntil: "commit" });
  const panel = page.locator(".creators-panel");
  await expect(panel).toHaveCSS("border-top-left-radius", "16px");
  const before = await documentBox(page, ".creators-panel");
  // The progress bar alone shows the batch streaming; Load more marks its end.
  const loadMore = panel.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible(streaming);
  expect(pages).toHaveLength(20);
  await expect(
    panel.locator(".creators-progress").getByRole("status"),
  ).toHaveCount(0);
  for (const copy of removedCopy)
    await expect(page.getByText(copy)).toHaveCount(0);
  const rows = page.locator(".creators-page tbody tr[data-index]");
  expect(await rows.count()).toBeLessThanOrEqual(11 + 2 * 8 + 1);
  await expect(rows.first()).toHaveAttribute("data-row", "resolved");
  await expect(rows.first().getByRole("link").first()).toHaveAttribute(
    "href",
    /^\/creators\/0x[0-9a-f]{40}\/$/,
  );
  // Still trading is the export's bar over the counts the client grouped;
  // launch-only pools have no swaps, so none of these creators' pools trade.
  const cells = rows.first().locator("td");
  const survival = cells.nth(3).locator(".survival-cell");
  await expect(survival).toHaveText(
    `0 of ${await cells.nth(2).innerText()} · 0%`,
  );
  await expect(survival.locator(".survival-bar i")).toHaveAttribute(
    "style",
    "width: 0%;",
  );
  for (const column of [3, 5, 6])
    await expect(cells.nth(column - 1)).toHaveCSS("text-align", "right");
  const creatorColumn = (await cells.nth(1).boundingBox())!.width;
  expect(
    creatorColumn,
    "at least the export's 180px on a phone",
  ).toBeGreaterThanOrEqual(180);
  expect(
    await cells.nth(1).evaluate((td) => td.scrollWidth <= td.clientWidth),
    "the address chip fits the creator cell without an ellipsis",
  ).toBe(true);
  expect(
    creatorColumn,
    "no wider than the export's column at 1440",
  ).toBeLessThanOrEqual(602);
  expect(
    await page.evaluate(
      () => document.querySelector(".creators-scroll")!.scrollHeight,
    ),
    "the surface holds every creator while only visible rows are in the DOM",
  ).toBe(creators(2000) * 62 + 34);
  await loadMore.click();
  // The remainder streams behind the progress bar; the exhausted catalog ends it.
  await expect.poll(() => pages.length, streaming).toBe(25);
  await expect(panel.locator(".creators-progress-bar")).toHaveCount(
    0,
    streaming,
  );
  await expect(loadMore).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.querySelector(".creators-scroll")!.scrollHeight,
    ),
  ).toBe(creators(2500) * 62 + 34);
  expect(await rows.count()).toBeLessThanOrEqual(11 + 2 * 8 + 1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await documentBox(page, ".creators-panel")).toEqual(before);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { layoutMeasurement: { cls: number } })
          .layoutMeasurement.cls,
    ),
    "every non-input layout shift while the catalog streamed",
  ).toBe(0);
});

test("creators sort from the URL and restore their scroll position after a detour", async ({
  page,
}) => {
  await serveCatalog(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  await expect(panel.getByRole("button", { name: "Load more" })).toBeVisible(
    streaming,
  );
  await page.getByRole("button", { name: "Launches" }).click();
  await expect(page).toHaveURL(/\?sort=launches$/);
  await expect(page.getByRole("button", { name: "Launches" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const launches = page.locator(
    ".creators-page tbody tr[data-index] td:nth-child(3)",
  );
  await expect(launches.first()).toHaveText("2");
  await expect(launches.nth(1)).toHaveText("2");
  await page.getByRole("button", { name: "Volume" }).click();
  await expect(page).not.toHaveURL(/sort=/);
  const surface = page.locator(".creators-scroll");
  await surface.evaluate((node) => node.scrollTo({ top: 3100 }));
  await expect
    .poll(() =>
      page
        .locator(".creators-page tbody tr[data-index]")
        .first()
        .getAttribute("data-index"),
    )
    .not.toBe("0");
  // Row 52 sits fully inside the scrollport at this offset, so clicking it does not scroll.
  const link = page.locator(
    '.creators-page tbody tr[data-index="52"] .address-chip-link',
  );
  const href = (await link.getAttribute("href"))!;
  await link.click();
  await expect(page).toHaveURL(new RegExp(href));
  // The launches badge is the count itself.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(
    /^Launches \d+$/,
    streaming,
  );
  for (const copy of removedCopy)
    await expect(page.getByText(copy)).toHaveCount(0);
  await page.goBack();
  await expect(panel.getByRole("button", { name: "Load more" })).toBeVisible(
    streaming,
  );
  await expect
    .poll(() => surface.evaluate((node) => node.scrollTop))
    .toBe(3100);
});
