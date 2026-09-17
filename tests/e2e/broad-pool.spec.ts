import { test, expect } from "@playwright/test";
import type { ObservedMarket } from "@pools/core";
import captured from "../../data/pools/index.json";
import { preloadedProduct } from "../../apps/web/src/lib/product-server";
import { methodologyCopy } from "../support/pool-copy";
const id = "0x" + "1".repeat(64),
  token = "0x" + "2".repeat(40),
  tx = "0x" + "3".repeat(64),
  hash = "0x" + "4".repeat(64);
const pool = {
  poolId: id,
  token,
  name: "Broad observed token",
  symbol: "BOT",
  launch: {
    block: 22754669,
    timestamp: 100000,
    transactionHash: tx,
    transactionInitiator: token,
  },
};
function fixture(): ObservedMarket {
  return {
    poolId: id,
    token,
    decimals: 18,
    priceWei: "2000000000000000000",
    window: "24h",
    volumeWei: "123000000000000000000",
    trades: 21001,
    change: 100,
    observations: [
      {
        id: `${tx}:0`,
        transactionHash: tx,
        logIndex: 0,
        block: 22754679,
        blockHash: hash,
        timestamp: 200000,
        side: "buy",
        ethWei: "1000000000000000000",
        tokenRaw: "500000000000000000",
      },
    ],
    coverage: {
      startBlock: 22754669,
      cutoff: { block: 22754679, hash, asOf: 200000 },
      indexedAt: "2026-09-15T00:00:00.000Z",
      completeWindow: true,
      windowStart: 113600,
      priceBaseline: { block: 22754669, hash, asOf: 113599 },
      unitBasis: {
        block: 22754679,
        hash,
        asOf: 200000,
        decimals: 18,
        source: "broad_token_units",
      },
      unitsConflict: false,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 60,
      fromTimestamp: 199980,
      truncated: false,
      candles: [
        {
          time: 199980,
          open: "1000000000000000000",
          high: "2000000000000000000",
          low: "1000000000000000000",
          close: "2000000000000000000",
          volume: "1000000000000000000",
        },
      ],
    },
  };
}
test("broad-only pool uses the real chart and exact market stats, with nothing under them", async ({
  page,
}, testInfo) => {
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        pool,
        analytics: null,
        market: fixture(),
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Price candle chart/ }),
  ).toBeVisible();
  await expect(page.locator(".stat > span")).toHaveText([
    "FDV",
    "Volume 24h",
    "Creator fee",
  ]);
  /* Holders, liquidity, fees, top traders and the trade history are cut. */
  await expect(page.locator(".table-tabs, .market-sidebar")).toHaveCount(0);
  const volume = page
    .locator(".stat")
    .filter({ has: page.getByText("Volume 24h", { exact: true }) });
  await expect(volume.locator("strong")).toContainText("123");
  await expect(volume.locator("small")).toHaveText("21,001 trades");
  await page.screenshot({
    path: testInfo.outputPath("broad-pool.png"),
    fullPage: true,
  });
  await expect(page.locator("body")).not.toContainText(methodologyCopy);
  await expect(page.locator(".pool-chart-panel select")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
/* A bare pool link has only its observed market, and the ledger's market
   carries the creator-fee flag when it is known. Only a real boolean renders
   a setting: an absent flag is the unavailable mark, never Disabled. */
for (const [creatorFees, expected] of [
  [true, "Enabled"],
  [false, "Disabled"],
  [undefined, "\u2013"],
] as const) {
  test(`observed market with creator fee ${String(creatorFees)} renders ${expected}`, async ({
    page,
  }) => {
    const market = fixture();
    if (creatorFees !== undefined) market.creatorFees = creatorFees;
    await page.route(`**/api/product/pools/${id}/`, (route) =>
      route.fulfill({
        json: {
          pool,
          analytics: null,
          market,
          delivery: { source: "indexer", notice: null },
        },
      }),
    );
    await page.goto(`/pool/${id}/`);
    await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
    const stat = page
      .locator(".stat")
      .filter({ has: page.getByText("Creator fee", { exact: true }) })
      .locator("strong");
    await expect(stat).toHaveText(expected);
    if (creatorFees === undefined)
      await expect(
        stat.locator(".unavailable"),
        "a missing flag is unavailable, not an inferred Disabled",
      ).toHaveText("\u2013");
  });
}
test("quiet token retains its chart with a dated unit basis after the global market cutoff advances", async ({
  page,
}) => {
  let advanced = false;
  let reads = 0;
  await page.route(`**/api/product/pools/${id}/`, (route) => {
    reads++;
    const market = fixture();
    if (advanced)
      market.coverage.cutoff = {
        block: 22754689,
        hash: "0x" + "5".repeat(64),
        asOf: 200100,
      };
    return route.fulfill({
      json: {
        pool,
        analytics: null,
        market,
        delivery: { source: "indexer", notice: null },
      },
    });
  });
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  advanced = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(
    page.getByRole("img", { name: /Price candle chart/ }),
  ).toBeVisible();
  await expect(page.locator(".live-price-heading")).toContainText("2");
});
test("direct pool link preserves verified published deep accounting alongside broad market data", async ({
  page,
}) => {
  const snapshot = Object.values(captured.snapshots)[0],
    deep = snapshot.markets[0];
  const payload = (await preloadedProduct(
    `pools/${deep.id}`,
    new URLSearchParams("window=All"),
  )) as Record<string, unknown>;
  const market = fixture();
  Object.assign(market, {
    poolId: deep.id,
    token: deep.token.toLowerCase(),
    observations: [],
    change: null,
  });
  Object.assign(market.coverage, {
    startBlock: deep.launchBlock,
    cutoff: {
      block: snapshot.toBlock + 10,
      hash,
      asOf: snapshot.toTimestamp + 60,
    },
    unitBasis: {
      block: snapshot.toBlock + 10,
      hash,
      asOf: snapshot.toTimestamp + 60,
      decimals: 18,
      source: "broad_token_units",
    },
    windowStart: snapshot.toTimestamp + 60 - 86400,
    priceBaseline: null,
    completeWindow: false,
  });
  Object.assign(market.history, { fromTimestamp: null, candles: [] });
  await page.route(`**/api/product/pools/${deep.id}/`, (route) =>
    route.fulfill({
      json: {
        ...payload,
        pool: {
          poolId: deep.id,
          name: deep.name,
          symbol: deep.symbol,
          token: deep.token.toLowerCase(),
          launch: {
            block: deep.launchBlock,
            timestamp: deep.launchedAt,
            transactionHash: deep.launchTx,
            transactionInitiator: deep.launchSender.toLowerCase(),
          },
        },
        market,
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${deep.id}/`);
  await expect(page.getByRole("heading", { name: deep.name })).toBeVisible();
  /* The accounted market is what knows the pool's creator fee setting. */
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Creator fee", { exact: true }) })
      .locator("strong"),
  ).toHaveText(deep.creatorFees ? "Enabled" : "Disabled");
});
test("discovered-only pool shows no invented zero totals", async ({ page }) => {
  const market = fixture();
  Object.assign(market, {
    decimals: null,
    priceWei: null,
    volumeWei: null,
    trades: null,
    change: null,
    observations: [],
  });
  Object.assign(market.coverage, {
    startBlock: null,
    cutoff: null,
    indexedAt: null,
    completeWindow: false,
    windowStart: null,
    priceBaseline: null,
    unitBasis: null,
  });
  Object.assign(market.history, { fromTimestamp: null, candles: [] });
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        pool,
        analytics: null,
        market,
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  const volume = page
    .locator(".stat")
    .filter({ has: page.getByText("Volume 24h", { exact: true }) });
  await expect(
    volume.locator("strong .unavailable"),
    "Volume 24h carries the quiet mark, never an invented zero",
  ).toHaveText("\u2013");
  await expect(
    volume.locator("small"),
    "no trade count is invented under it",
  ).toHaveCount(0);
});
test("a pool whose saved launch arrives as decimal strings still renders its identity", async ({
  page,
}) => {
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        // A bigint column read as text serialises these three as strings.
        pool: {
          ...pool,
          launch: {
            block: String(pool.launch.block),
            timestamp: String(pool.launch.timestamp),
            transactionHash: tx,
            transactionInitiator: token,
            sourceBatchThroughBlock: "22754729",
          },
        },
        analytics: null,
        market: fixture(),
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  await expect(page.getByText("Pool outside current coverage")).toHaveCount(0);
  await expect(page.locator(".pool-launch-meta")).toHaveText(
    /^launched \d+d ago by /,
  );
  await expect(page.locator(".pool-launch-meta time")).toHaveAttribute(
    "title",
    "1970-01-02 03:46:40 UTC",
  );
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Volume 24h", { exact: true }) })
      .locator("small"),
  ).toHaveText("21,001 trades");
});
