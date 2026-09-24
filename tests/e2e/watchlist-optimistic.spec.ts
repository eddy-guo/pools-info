import { test, expect, type Page, type TestInfo } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";

/**
 * The star is a browser-local, optimistic mutation: toggling it never asks
 * the read API for the screener again, and unstarring a row already on the
 * Watchlist view removes exactly that row at once, with no skeleton, no
 * scroll jump and no lost keyboard focus. See `product-explore.tsx`: the
 * ids behind the current fetch freeze against a bare removal, so the query
 * that drives `useExploreRows` never moves and the row leaves through a
 * client-side filter instead of a refetch.
 */

const storageKey = "poolsinfo.watchlist.v1";
/* Uniquely-named fixture pools: the dataset repeats "MonkiiLabs" across two
   entries, which a name-text filter cannot tell apart. */
const first = chain.markets[1];
const second = chain.markets[4];
const third = chain.markets[7];

function layout(testInfo: TestInfo) {
  return testInfo.project.name === "desktop"
    ? {
        rows: ".explore-page .desktop-pools tbody tr[data-row]",
        skeleton: ".explore-page .desktop-pools [data-row='skeleton']",
      }
    : {
        rows: ".explore-page .mobile-pools .mobile-pool",
        skeleton: ".explore-page .mobile-pools [data-row='skeleton']",
      };
}
const rowFor = (page: Page, rows: string, name: string) =>
  page.locator(rows).filter({ hasText: name });
const watchButton = (row: ReturnType<Page["locator"]>) =>
  row.locator("button.watch");
const count = (page: Page) => page.locator(".pagination-count");

/** Every request this test session makes to the explore endpoint, whatever
    view or rail asked for it. */
function exploreRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/product/explore/") urls.push(url.href);
  });
  return urls;
}
async function seedWatchlist(page: Page, ids: readonly string[]) {
  await page.addInitScript(
    ({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)),
    { key: storageKey, ids },
  );
}
/** Installed before navigation, as the layout-shift API requires to see
    every frame; `resetCls` then drops the hydration-time noise so only what
    happens from that point on - the interaction under test - counts. */
async function installClsObserver(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { __cls: state });
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
const resetCls = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __cls: { cls: number } }).__cls.cls = 0;
  });
const cls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __cls: { cls: number } }).__cls.cls,
  );

test("starring and unstarring on the All view is instant and asks the read API nothing new", async ({
  page,
}, testInfo) => {
  const { rows } = layout(testInfo);
  const requests = exploreRequests(page);
  await page.goto("/");
  const row = rowFor(page, rows, first.name);
  const button = watchButton(row);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  requests.length = 0;

  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toHaveAttribute("aria-label", "Remove from watchlist");

  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toHaveAttribute("aria-label", "Add to watchlist");

  expect(requests, "neither star toggle asked the read API anything").toEqual(
    [],
  );
});

test("unstarring on the Watchlist view removes the row at once: no refetch, no skeleton, stable scroll and focus, CLS 0", async ({
  page,
}, testInfo) => {
  const { rows, skeleton } = layout(testInfo);
  await installClsObserver(page);
  await seedWatchlist(page, [first.id, second.id, third.id]);
  const requests = exploreRequests(page);
  await page.goto("/?view=watchlist");
  await expect(rowFor(page, rows, third.name)).toBeVisible();
  await expect(count(page)).toHaveText("Showing 3 of 3");
  const reservedRowCount = await page.locator(rows).count();
  requests.length = 0;

  await page.evaluate(() => window.scrollTo(0, 200));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  // Everything up to here is page load and test setup, not the interaction
  // under test: only shifts from this point on should count.
  await resetCls(page);

  // A row that will not move keeps keyboard focus through the removal below.
  const keptButton = watchButton(rowFor(page, rows, first.name));
  await keptButton.focus();
  await expect(keptButton).toBeFocused();

  // Removing the last row on show is unambiguous: nothing shifts into its
  // slot, so this is the row identity leaving, not merely its content.
  await watchButton(rowFor(page, rows, third.name)).click();

  await expect(rowFor(page, rows, third.name)).toHaveCount(0);
  await expect(rowFor(page, rows, first.name)).toBeVisible();
  await expect(rowFor(page, rows, second.name)).toBeVisible();
  await expect(count(page)).toHaveText("Showing 2 of 2");

  expect(requests, "unstarring never asks explore again").toEqual([]);
  await expect(page.locator(skeleton)).toHaveCount(0);
  expect(
    await page.locator(rows).count(),
    "the reserved row count never changes",
  ).toBe(reservedRowCount);
  expect(
    await page.evaluate(() => window.scrollY),
    "scroll position holds",
  ).toBe(scrollBefore);
  await expect(
    keptButton,
    "focus stays on the row that did not move",
  ).toBeFocused();

  // Removing the new last row (second, now that third is gone) compacts the
  // list again with the same guarantees.
  await watchButton(rowFor(page, rows, second.name)).click();
  await expect(rowFor(page, rows, second.name)).toHaveCount(0);
  await expect(rowFor(page, rows, first.name)).toBeVisible();
  await expect(count(page)).toHaveText("Showing 1 of 1");
  expect(requests, "still no explore request").toEqual([]);
  await expect(page.locator(skeleton)).toHaveCount(0);

  // Unstarring the only pool left empties the view immediately.
  await keptButton.click();
  await expect(
    page.getByRole("heading", { name: "Your watchlist starts here" }),
  ).toBeVisible();
  await expect(rowFor(page, rows, first.name)).toHaveCount(0);
  expect(requests, "the empty state needed no read either").toEqual([]);

  expect(
    await cls(page),
    "three removals and the empty state cost the page no layout shift",
  ).toBe(0);
});
