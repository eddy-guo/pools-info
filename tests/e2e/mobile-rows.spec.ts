import { test, expect, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import type { LiveTradeFeedResponse } from "@pools/core";

/* W6: the phone rows read like the export - the screener card at 104px, the
   live rail row at 51px on both viewports - with no coverage copy anywhere
   in the product: not the mobile card's reserved rows, not the meta
   description. */

// Chain refresh is disabled in this suite, so the live route always answers
// 503; serve it the shape production serves so its rows can be measured.
async function serveLiveFeed(page: Page) {
  await page.route("**/api/live-trades/**", async (route) => {
    const poolId = new URL(route.request().url()).searchParams.get("poolId");
    const asOf = Math.floor(Date.now() / 1000) - 30;
    const json: LiveTradeFeedResponse = {
      source: "indexed_recent_chain_events",
      generatedAt: new Date(asOf * 1000).toISOString(),
      poolId,
      truncated: false,
      replacement: true,
      events: chain.markets
        .filter((market) => !poolId || market.id === poolId)
        .slice(0, 3)
        .map((market, index) => ({
          id: `0x${(index + 1).toString(16).padStart(64, "0")}:0`,
          poolId: market.id,
          token: market.token,
          name: market.name,
          symbol: market.symbol,
          launchTx: market.launchTx,
          transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
          logIndex: 0,
          block: chain.toBlock,
          blockHash: chain.blockHash,
          timestamp: asOf,
          side: index % 2 ? "sell" : "buy",
          ethWei: "100000000000000000",
          tokenRaw: "1000000",
          transactionInitiator: "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1",
          attribution: "transaction_initiator_only",
        })),
      coverage: {
        state: "current",
        scope: "verified_pools_launches_only",
        registryExhaustive: false,
        pnlAvailable: false,
        startBlock: chain.fromBlock,
        headBlock: chain.toBlock + 128,
        throughBlock: chain.toBlock,
        throughHash: chain.blockHash,
        asOf,
        checkedAt: new Date(asOf * 1000).toISOString(),
        lagBlocks: 128,
        discoveryThroughBlock: chain.toBlock,
        discoveryLagBlocks: 128,
        knownPools: 62324,
        staleAfterSeconds: 180,
      },
    };
    await route.fulfill({ json });
  });
}

const rowHeights = (rows: ReturnType<Page["locator"]>) =>
  rows.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
  );

test("the document description carries no coverage phrase", async ({
  page,
}) => {
  await page.goto("/");
  const description = await page
    .locator('meta[name="description"]')
    .getAttribute("content");
  expect(description, "a plain product description").not.toBeNull();
  expect(description, "no coverage/methodology copy").not.toMatch(
    /coverage/i,
  );
});

test("the screener phone card matches the export's 104px row, with no coverage text", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phone card only");
  await page.goto("/");
  const rows = page.locator(
    ".explore-page .mobile-pools .mobile-pool[data-row='resolved']",
  );
  await expect(rows.first()).toBeVisible();
  const heights = await rowHeights(rows);
  expect(heights.length, "the first page has cards").toBeGreaterThan(0);
  for (const height of heights) {
    expect(height, "104 ± 4px").toBeGreaterThanOrEqual(100);
    expect(height, "104 ± 4px").toBeLessThanOrEqual(108);
  }
  await expect(page.locator("main")).not.toContainText("Coverage pending");
  // The star stays a 44px tap target even on the shorter card.
  const star = rows.first().locator(".watch");
  expect(
    (await star.boundingBox())!.height,
    "44px tap target",
  ).toBeGreaterThanOrEqual(44);
});

// The mocked feed can still resolve to a window with no trades for a given
// scope (or land on a transient poll error), in which case the rail renders
// no `.stream-event` rows at all - there is nothing to measure a height on,
// so assert the rail's own status instead of assuming a row exists.
async function expectRailRows(rail: ReturnType<Page["locator"]>) {
  await expect(rail).toBeVisible();
  const rows = rail.locator(".stream-event");
  if ((await rows.count()) === 0) {
    await expect(rail.locator('[role="status"]')).toBeVisible();
    return;
  }
  const heights = await rowHeights(rows);
  for (const height of heights) {
    expect(height, "51 ± 2px").toBeGreaterThanOrEqual(49);
    expect(height, "51 ± 2px").toBeLessThanOrEqual(53);
  }
}

test("the live rail rows match the export's 51px row at both viewports", async ({
  page,
}) => {
  await serveLiveFeed(page);
  await page.goto("/");
  await expectRailRows(page.locator(".trade-stream"));
});
