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
  // With All already selected the hint has nothing left to offer (sweep s6
  // defect 16: "Select All" while All was the selected window).
  await expect(
    empty.getByRole("heading", { name: "No positions", exact: true }),
  ).toBeVisible();
  await expect(empty).toContainText("This wallet has no positions.");
  await expect(empty).not.toContainText("Select All");
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
  // Any narrower window still points at All, the one action that could
  // change the answer. The window's own read is awaited so the routed
  // response above is never disposed under its handler.
  const narrowed = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/product/wallets/${wallet}`) &&
      response.url().includes("window=7d"),
  );
  await page
    .locator(".wallet-page .segmented")
    .getByRole("button", { name: "7d", exact: true })
    .click();
  await narrowed;
  await expect(
    empty.getByRole("heading", { name: "No positions in this window" }),
  ).toBeVisible();
  await expect(empty).toContainText(
    "Select All to see this wallet's full history.",
  );
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
});

/*
 * The captain's escalation of 17 Sep 2026: on a cold home page against a read
 * API that was not answering, the visitor watched skeletons for eight seconds
 * and was then shown "Pepe in Hood at 14.1333 ETH" with launch cards reading
 * "3d", because the proxy quietly answered from the committed dataset. The
 * measured proxy response in that state is now exactly the one these routes
 * fulfil: HTTP 503 with `{"error":"data_unavailable"}` and a Retry-After.
 * `apps/web/src/lib/product-request.test.ts` pins the server side of that
 * contract, so this spec and the server cannot drift apart unnoticed.
 */
const unavailable = { error: "data_unavailable" };
/* Names and figures the committed dataset carries. None may reach the screen
   while the read API has nothing to say. */
const preloadedNames = [
  "Pepe in Hood",
  "MonkiiLabs",
  "Seymour Cash",
  "Longfolio",
];

async function withNoLiveData(page: Page) {
  await page.route("**/api/product/**", (route) =>
    route.fulfill({
      status: 503,
      json: unavailable,
      headers: { "retry-after": "30", "cache-control": "no-store" },
    }),
  );
  /* The pool page's accounted cut reads the same outage through its own route. */
  await page.route("**/api/markets/**", (route) =>
    route.fulfill({ status: 503, json: unavailable }),
  );
}

for (const [name, url, heading] of [
  ["home", "/", "Pools unavailable"],
  ["leaderboard", "/traders/", "Leaderboard unavailable"],
  ["creators", "/creators/", "Creators unavailable"],
  ["wallet", `/wallet/${wallet}/?window=All`, "Wallet unavailable"],
  [
    "pool",
    "/pool/0x2b92729e11429b6452872cca4d1cdc26568274b716093f1ae2e3e10b88844e5c/",
    "Price chart unavailable",
  ],
] as const)
  test(`the ${name} page shows nothing rather than stale figures when no live data is served`, async ({
    page,
  }, testInfo) => {
    const { viewport } = surface(testInfo);
    await page.setViewportSize(viewport);
    await withNoLiveData(page);

    await page.goto(url);
    const main = page.locator("main");
    if (name === "pool")
      /* The pool page has no list to empty; its reserved chart region is
         where it reports what it could not get. */
      await expect(
        main.locator(".pool-chart-region .empty-state"),
      ).toContainText("Live data is unavailable.");
    else
      await expect(
        main.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();

    const text = await main.innerText();
    expect(text, "no ETH amount survives an outage").not.toMatch(
      /[\d.]+\s*ETH/,
    );
    expect(text, "no percentage change survives an outage").not.toMatch(
      /[-+][\d.]+%/,
    );
    for (const stale of preloadedNames)
      expect(text, `${stale} is a committed fixture name`).not.toContain(stale);
    expect(
      await main.locator("[data-pending='true']").count(),
      "nothing is left shimmering as though it were still on its way",
    ).toBe(0);
  });

test("the home page's launch cards and rails report the outage instead of pending forever", async ({
  page,
}, testInfo) => {
  const { viewport } = surface(testInfo);
  await page.setViewportSize(viewport);
  await withNoLiveData(page);

  await page.goto("/");
  await expect(
    page.locator(".launch-rail").getByText("Launches unavailable"),
  ).toBeVisible();
  await expect(
    page.locator(".trade-stream").getByText("Live trades unavailable"),
  ).toBeVisible();
  await expect(
    page.locator(".explore-leaders").getByText("Top traders unavailable"),
  ).toBeVisible();
  await expect(page.locator(".launch-rail .launch-card")).toHaveCount(0);
  /* The count under the list never claims rows it does not have. */
  await expect(page.locator(".pagination .pagination-count")).toHaveText(
    "0 results",
  );
});
