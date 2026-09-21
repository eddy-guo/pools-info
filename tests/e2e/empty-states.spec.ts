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

  if (testInfo.project.name === "mobile") {
    const reserved = page.locator(
      '.wallet-page .mobile-position[data-row="reserved"]',
    );
    await expect(reserved).toHaveCount(25);
    await expect(reserved.first()).toBeHidden();
  }

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
 * The frozen accounting route answers a wallet it has never observed with
 * `wallet.asOf: null` (the latest cut of the pools it holds a position in,
 * null only when it holds none) beside zero counts, while the live board
 * ranks that same wallet at the top. The page reads that shape as not yet
 * indexed rather than as hard zeros; a measured wallet with nothing in the
 * window still carries its cut and keeps its zeros.
 */
const unindexedLine = "This wallet's trading has not been indexed yet.";
/* The unobserved shape, field for field as the read API serves it. */
const unobservedWallet = {
  address: wallet,
  rank: null,
  realizedWei: null,
  netWei: null,
  unrealizedWei: null,
  volumeWei: "0",
  roi: null,
  wins: 0,
  losses: 0,
  winRate: null,
  tradeCount: 0,
  supportedTradeCount: 0,
  supportedPositionCount: 0,
  excludedPositionCount: 0,
  bestWei: null,
  avgHold: null,
  last: null,
  asOf: null,
  oldestAsOf: null,
  completeWindow: false,
};
/* 129 launches, the count the real unobserved top wallet carries. */
const launches = Array.from({ length: 129 }, (_, i) => ({
  id: `0x${(i + 1).toString(16).padStart(64, "0")}`,
  token: `0x${(i + 1).toString(16).padStart(40, "0")}`,
  name: `Launch ${i + 1}`,
  symbol: `L${i + 1}`,
  launchTx: `0x${(i + 1).toString(16).padStart(64, "f")}`,
  launchSender: wallet,
  launchBlock: 65841861 + i,
  launchedAt: 1789695885 + i * 60,
}));

const tile = (page: Page, label: string) =>
  page
    .locator(".wallet-page .live-eight-stats .stat")
    .filter({ has: page.locator("span", { hasText: label }) })
    .locator("strong");
const behaviourValue = (page: Page, label: string) =>
  page
    .locator(".wallet-page .wallet-behaviour-row")
    .filter({ has: page.locator("span", { hasText: label }) })
    .locator(".number");

test("a wallet the accounting has never observed reads as not indexed, not as zeros", async ({
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
      json: {
        ...body,
        wallet: unobservedWallet,
        positions: [],
        positionsTruncated: false,
        trades: [],
        tradesTruncated: false,
        curve: [],
        launches,
        launchesTruncated: false,
      },
    });
  });

  await page.goto(`/wallet/${wallet}/?window=All`);
  const empty = page.locator(".table-region .empty-state");
  await expect(empty).toContainText(unindexedLine);
  await expect(page.locator(".wallet-page .chart-empty-note")).toHaveText(
    unindexedLine,
  );
  // The most traded pools rail carries the same one line: an unobserved
  // wallet has no window in which its activity could be empty.
  await expect(page.locator(".wallet-page .wallet-top-pools")).toHaveText(
    unindexedLine,
  );
  // No rank badge at all: the board this wallet was clicked from ranks it.
  await expect(page.locator(".wallet-page .page-heading")).not.toContainText(
    "RANK",
  );
  // The unmeasured figures carry the quiet mark the six honest tiles use.
  for (const label of ["Trades", "Volume"]) {
    await expect(tile(page, label)).toHaveText("\u2013");
    await expect(tile(page, label).locator(".unavailable")).toHaveCount(1);
  }
  for (const label of ["Wins", "Losses"])
    await expect(behaviourValue(page, label)).toHaveText("");
  const tabs = page.getByRole("tablist", { name: "Wallet activity" });
  await expect(tabs.getByRole("tab", { name: "Positions" })).toHaveText(
    "Positions",
  );
  await expect(tabs.getByRole("tab", { name: /^Trades/ })).toHaveCount(0);
  // The launches are real: they come from the catalog, not the accounting.
  await expect(tabs.getByRole("tab", { name: "Launches" })).toHaveText(
    "Launches129",
  );
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  expect(
    await bufferedShiftSum(page),
    "every non-input layout shift since navigation",
  ).toBe(0);
});

test("a measured wallet with nothing in the window keeps its zeros", async ({
  page,
}, testInfo) => {
  const { viewport } = surface(testInfo);
  await page.setViewportSize(viewport);
  await page.route(`**/api/product/wallets/${wallet}**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // The preloaded wallet is measured: its cut is the condition that keeps
    // every zero below an honest zero.
    expect(typeof body.wallet.asOf).toBe("number");
    await route.fulfill({
      response,
      json: {
        ...body,
        wallet: {
          ...unobservedWallet,
          asOf: body.wallet.asOf,
          oldestAsOf: body.wallet.oldestAsOf,
        },
        positions: [],
        positionsTruncated: false,
        trades: [],
        tradesTruncated: false,
        curve: [],
        launches,
        launchesTruncated: false,
      },
    });
  });

  await page.goto(`/wallet/${wallet}/?window=All`);
  const empty = page.locator(".table-region .empty-state");
  await expect(empty).toContainText("This wallet has no positions.");
  await expect(page.locator(".wallet-page .chart-empty-note")).toHaveText(
    "No realized PnL in this window.",
  );
  await expect(page.locator(".wallet-page .wallet-top-pools")).toHaveText(
    "No pool activity in this window.",
  );
  await expect(page.locator(".wallet-page .page-heading")).toContainText(
    "UNRANKED",
  );
  await expect(tile(page, "Trades")).toHaveText("0");
  await expect(tile(page, "Volume")).toHaveText("0 ETH");
  for (const label of ["Wins", "Losses"])
    await expect(behaviourValue(page, label)).toHaveText("0");
  const tabs = page.getByRole("tablist", { name: "Wallet activity" });
  await expect(tabs.getByRole("tab", { name: "Positions" })).toHaveText(
    "Positions0",
  );
  await expect(tabs.getByRole("tab", { name: /^Trades/ })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "Launches" })).toHaveText(
    "Launches129",
  );
  await expect(page.locator(".wallet-page")).not.toContainText(unindexedLine);
});

/*
 * The aggregate ledger serves a wallet's header, window figures and positions
 * but no per-wallet trade list and no curve yet (trades: [], curve: [] beside
 * a real tradeCount). The production page of 18 Sep 2026 read that as three
 * contradictions: a Trades tab at 0 beside a Trades tile of 594, "No realized
 * PnL in this window." under a Realized PnL tile of +198.89 ETH, and every one
 * of its 129 positions rendered at once.
 */
/* Sixty positions, more than two Show more pages. */
const servedPositions = Array.from({ length: 60 }, (_, i) => ({
  poolId: `0x${(i + 1).toString(16).padStart(64, "a")}`,
  token: `0x${(i + 1).toString(16).padStart(40, "a")}`,
  symbol: `P${i + 1}`,
  decimals: 18,
  launchTx: `0x${(i + 1).toString(16).padStart(64, "b")}`,
  asOf: 1789695885,
  throughBlock: 65841861,
  supported: true,
  flags: [],
  realizedWei: String(BigInt(i + 1) * 10n ** 15n),
  unrealizedWei: "0",
  netWei: String(BigInt(i + 1) * 10n ** 15n),
  volumeWei: String(BigInt(60 - i) * 10n ** 17n),
  position: {
    poolId: `0x${(i + 1).toString(16).padStart(64, "a")}`,
    trader: wallet,
    quantity: "0",
    costWei: "0",
    realizedWei: String(BigInt(i + 1) * 10n ** 15n),
    proceedsWei: String(BigInt(i + 1) * 10n ** 17n),
    investedWei: String(BigInt(i + 1) * 10n ** 17n),
    buys: 5,
    sells: 5,
    flags: [],
    realizations: [],
  },
}));

test("a served wallet whose curve is not sent says so, with no Trades tab and its positions in pages", async ({
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
      json: {
        ...body,
        wallet: {
          ...body.wallet,
          tradeCount: 594,
          supportedTradeCount: 594,
          rankingTradeCount: 594,
          realizedWei: "198890000000000000000",
        },
        positions: servedPositions,
        positionsTruncated: false,
        trades: [],
        tradesTruncated: false,
        curve: [],
        launches,
        launchesTruncated: false,
      },
    });
  });

  await page.goto(`/wallet/${wallet}/?window=All`);
  // The tile keeps the served count; the strip has no Trades tab to
  // contradict it.
  await expect(tile(page, "Trades")).toHaveText("594");
  await expect(tile(page, "Realized PnL")).toHaveText("+198.89 ETH");
  await expect(page.getByRole("tab", { name: /^Trades/ })).toHaveCount(0);
  await expect(
    page.getByRole("tablist", { name: "Wallet activity" }).getByRole("tab"),
  ).toHaveText(["Positions60", "Launches129"]);
  // The curve panel says the curve is not served, never that there is no
  // realized PnL under a tile that shows some; the readout keeps its dash.
  await expect(page.locator(".wallet-page .chart-empty-note")).toHaveText(
    "The PnL curve is not served for this wallet yet.",
  );
  await expect(page.locator(".wallet-page .chart-readout time")).toHaveText(
    "No observations",
  );
  await expect(
    page.locator(".wallet-page .chart-readout .unavailable"),
  ).toHaveText("\u2013");
  await expect(page.locator(".wallet-page")).not.toContainText(
    "No realized PnL",
  );
  // At phone width the readout's label, value and time are three lines: the
  // production page of 18 Sep 2026 wrapped them into a 40px box that cut the
  // value's line and hid the time. The time's box sits inside the readout's
  // and the readout's inside the region's, both fixed from first paint.
  if (testInfo.project.name === "mobile") {
    const region = page.locator(".wallet-page .wallet-chart-region");
    const readout = region.locator(".chart-readout");
    const boxes = {
      region: await region.boundingBox(),
      readout: await readout.boundingBox(),
      time: await readout.locator("time").boundingBox(),
    };
    const within = (
      inner: { x: number; y: number; width: number; height: number } | null,
      outer: { x: number; y: number; width: number; height: number } | null,
    ) =>
      !!inner &&
      !!outer &&
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height;
    expect(within(boxes.time, boxes.readout), JSON.stringify(boxes)).toBe(
      true,
    );
    expect(within(boxes.readout, boxes.region), JSON.stringify(boxes)).toBe(
      true,
    );
  }
  // The positions come in pages under the shared Show more control, not
  // all at once: 25 rows from first paint, 25 more per click, the count
  // reading off the rows on hand.
  const rows = page
    .locator(".wallet-activity [data-row='resolved']")
    .filter({ visible: true });
  const foot = page.locator(".wallet-activity .pagination");
  await expect(rows).toHaveCount(25);
  await expect(foot.locator(".pagination-count")).toHaveText(
    "Showing 25 of 60",
  );
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  expect(
    await bufferedShiftSum(page),
    "every non-input layout shift since navigation",
  ).toBeLessThan(0.001);
  const more = foot.getByRole("button", { name: "Show 25 more" });
  await more.click();
  await expect(rows).toHaveCount(50);
  await expect(foot.locator(".pagination-count")).toHaveText(
    "Showing 50 of 60",
  );
  await expect(page).toHaveURL(/limit=50/);
  // The first newly revealed row takes focus, and the last page names the
  // rows it has left.
  await expect(
    page.locator("[data-row-index='25'] a").filter({ visible: true }),
  ).toBeFocused();
  await expect(
    foot.getByRole("button", { name: "Show 10 more" }),
  ).toBeVisible();
  await foot.getByRole("button", { name: "Show 10 more" }).click();
  await expect(rows).toHaveCount(60);
  await expect(foot.locator(".pagination-count")).toHaveText(
    "Showing 60 of 60",
  );
  await expect(foot.getByRole("button")).toHaveCount(0);
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
