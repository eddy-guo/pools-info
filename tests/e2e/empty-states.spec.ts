import { test, expect, type Page } from "@playwright/test";

// The audit measured the screener's "No pools match these filters" block at
// y=2460 (desktop) and y=6169 (mobile): it rendered after the reserved table
// area instead of inside it, so the user saw a blank panel. These checks pin
// the message to the top of that area at both viewports, and pin the reserved
// geometry so the panel never collapses under it.
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const viewports = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
} as const;

function surface(testInfo: { project: { name: string } }) {
  return testInfo.project.name === "desktop"
    ? ({
        viewport: viewports.desktop,
        rows: ".explore-page .desktop-pools",
        maxTop: 1000,
        /* The reserved first page: 25 rows at 62px under the 34px header. */
        reservedHeight: 25 * 62 + 34,
      } as const)
    : ({
        viewport: viewports.mobile,
        rows: ".explore-page .mobile-pools",
        maxTop: 1500,
        /* The reserved first page: 25 cards at 104px. */
        reservedHeight: 25 * 104,
      } as const);
}

async function trackShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { emptyStateShifts: state });
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

const bufferedShiftSum = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { emptyStateShifts: { cls: number } })
        .emptyStateShifts.cls,
  );

test("the screener's empty state reads inside the panel, under the toolbar", async ({
  page,
}, testInfo) => {
  const { viewport, rows, maxTop, reservedHeight } = surface(testInfo);
  await page.setViewportSize(viewport);
  await trackShifts(page);

  await page.goto("/?q=zzqqxxvv");
  const empty = page.locator(".table-region .empty-state");
  await expect(
    empty.getByRole("heading", { name: "No pools match these filters" }),
  ).toBeVisible();
  await expect(
    empty.locator(".empty-symbol svg"),
    "the designed empty state keeps its icon",
  ).toBeVisible();

  const toolbar = (await page
    .locator(".explore-page .explore-toolbar")
    .boundingBox())!;
  const block = (await empty.boundingBox())!;
  const reserved = (await page.locator(rows).boundingBox())!;
  expect(
    block.y,
    "the message sits in the first screens, not below the reserved rows",
  ).toBeLessThan(maxTop);
  expect(
    block.y,
    "the message sits under the toolbar, inside the panel",
  ).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  expect(
    block.y - reserved.y,
    "the message occupies the top of the reserved area",
  ).toBeLessThan(reserved.height / 2);
  expect(
    reserved.height,
    "the reserved table area keeps its first page's height rather than collapsing",
  ).toBe(reservedHeight);
  expect(
    await bufferedShiftSum(page),
    "every non-input layout shift since navigation",
  ).toBe(0);
});

test("the wallet's empty positions use the same designed empty state", async ({
  page,
}, testInfo) => {
  const { viewport } = surface(testInfo);
  await page.setViewportSize(viewport);
  await trackShifts(page);
  await page.route(`**/api/product/wallets/${wallet}**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, positions: [], positionsTruncated: false },
    });
  });

  await page.goto(`/wallet/${wallet}/?window=All`);
  const empty = page.locator(".table-region .empty-state");
  await expect(
    empty.getByRole("heading", { name: "No positions in this window" }),
  ).toBeVisible();
  await expect(empty.locator(".empty-symbol svg")).toBeVisible();

  const region = (await page
    .locator(
      ".wallet-page .wallet-list-region, .wallet-page .mobile-wallet-rows",
    )
    .filter({ visible: true })
    .boundingBox())!;
  const block = (await empty.boundingBox())!;
  expect(
    block.y - region.y,
    "the message occupies the top of the reserved area",
  ).toBeLessThan(region.height / 2);
  expect(
    await bufferedShiftSum(page),
    "every non-input layout shift since navigation",
  ).toBe(0);
});
