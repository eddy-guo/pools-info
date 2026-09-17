import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { formatMoney, poolHref } from "@pools/core";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const routes = [
  "/",
  poolHref(chain.markets[0]),
  "/traders/",
  "/creators/",
  `/creators/${chain.markets[0].launchSender.toLowerCase()}/`,
  "/wallet/",
  `/wallet/${wallet}/`,
];

for (const route of routes) {
  test(`${route} keeps the shell to the network context, search and a quiet wallet placeholder`, async ({
    page,
    isMobile,
  }) => {
    await page.goto(route);
    const strip = page.locator(".network-subnav");
    await expect(strip).toBeVisible();
    await expect(page.locator(".network-context")).toHaveText(
      "v4 · Robinhood Chain",
    );
    // CHAIN_REFRESH_DISABLED=1 makes /api/live-trades/ 503 in this suite, so
    // the strip's dot settles on the feed's real, unstreaming state.
    await expect(page.locator(".subnav-live")).toHaveAttribute(
      "data-state",
      "paused",
    );
    await expect(page.locator(".subnav-live")).toHaveText("Paused");
    await expect(strip).not.toContainText("block");
    await expect(strip).not.toContainText("indexed");
    await expect(page.getByRole("link", { name: "Methodology" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("link", { name: "API" })).toHaveCount(0);
    await expect(page.locator('a[href="/methodology/"]')).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link")).toHaveText([
      "Pools",
      "Traders",
      "Creators",
    ]);
    await expect(page.locator(".header-actions .search-trigger")).toBeVisible();
    const connect = page.locator(".header-actions .connect-button");
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute("aria-disabled", "true");
    await expect(connect).toHaveAccessibleName("Connect wallet, coming soon");
    const search = await page
      .locator(".header-actions .search-trigger")
      .boundingBox();
    const box = await connect.boundingBox();
    expect(box!.x, "the placeholder sits right of search").toBeGreaterThan(
      search!.x + search!.width,
    );
    if (isMobile) {
      // Under 768 px the control is an icon-only 44 px square: its name
      // carries the coming-soon note and no chip text is drawn.
      expect((await connect.innerText()).trim()).toBe("");
      expect(box!.width).toBe(44);
      expect(box!.height).toBe(44);
      const toggle = await page
        .locator(".header-actions .unit-toggle")
        .boundingBox();
      expect(
        box!.x,
        "the control clears the unit toggle",
      ).toBeGreaterThanOrEqual(toggle!.x + toggle!.width);
    } else {
      await expect(connect).toContainText("Connect wallet");
      await expect(connect).toContainText("Soon");
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
    await connect.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".footer")).toContainText(
      "Independent analytics. Not affiliated with Uniswap Labs.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("the H1 row carries a Trader leaderboard call to action at the right", async ({
  page,
}) => {
  await page.goto("/");
  const cta = page.locator(".page-heading .leaderboard-cta");
  await expect(cta).toHaveText("Trader leaderboard →");
  await expect(cta).toHaveAttribute("href", "/traders/");
  const heading = await page.locator(".page-heading h1").boundingBox();
  const button = await cta.boundingBox();
  expect(button!.x, "the button sits right of the H1").toBeGreaterThan(
    heading!.x + heading!.width,
  );
  await cta.click();
  await expect(page).toHaveURL(/\/traders\/$/);
});

const liveFeedFixture = {
  source: "indexed_recent_chain_events",
  replacement: true,
  generatedAt: "2026-09-17T00:00:00.000Z",
  truncated: false,
  poolId: null,
  events: [],
  coverage: {
    state: "current",
    scope: "verified_pools_launches_only",
    registryExhaustive: false,
    pnlAvailable: false,
    knownPools: 10,
    staleAfterSeconds: 60,
    startBlock: 1,
    headBlock: 100,
    throughBlock: 100,
    asOf: 1758067200,
    lagBlocks: 0,
    discoveryThroughBlock: 100,
    discoveryLagBlocks: 0,
    throughHash: `0x${"a".repeat(64)}`,
    checkedAt: "2026-09-17T00:00:00.000Z",
  },
};

test("the strip's Live dot turns green once the trade feed reports streaming", async ({
  page,
}) => {
  // Pinned to the fixture's own asOf: TradeStream's own staleness check
  // compares against the real clock, so an unpinned run reads this fixture
  // as stale once staleAfterSeconds has elapsed since the fixture was written.
  await page.clock.install({
    time: new Date(liveFeedFixture.coverage.asOf * 1000),
  });
  await page.route("**/api/live-trades/", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: liveFeedFixture });
  });
  await page.goto("/");
  const dot = page.locator(".subnav-live");
  // Before the delayed read resolves, the dot claims neither state: no
  // "Live" label, a neutral dot, and the reserved width already in place.
  await expect(dot).toHaveAttribute("data-state", "unknown");
  await expect(dot).toHaveText("");
  const before = await dot.boundingBox();
  await expect(dot).toHaveAttribute("data-state", "streaming");
  await expect(dot).toHaveText("Live");
  const after = await dot.boundingBox();
  expect(after!.width, "the label's reserved width never shifts").toBe(
    before!.width,
  );
});

test("the strip's Live dot shows Paused, never Live, when the feed read fails", async ({
  page,
}) => {
  await page.route("**/api/live-trades/", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await page.goto("/");
  const dot = page.locator(".subnav-live");
  await expect(dot).toHaveAttribute("data-state", "unknown");
  await expect(dot).toHaveText("");
  await expect(dot).toHaveAttribute("data-state", "paused");
  await expect(dot).toHaveText("Paused");
});

const ethPriceFixture = {
  usdPerEth: 4218.44,
  asOf: "2026-09-17T00:00:00.000Z",
  source: "coinbase" as const,
};
const toggle = (page: import("@playwright/test").Page) =>
  page.locator(".header-actions .unit-toggle");

test.describe("ETH/USD unit toggle", () => {
  test("defaults to ETH, shows the strip's rate once the read resolves, switches figures and persists across reload", async ({
    page,
  }) => {
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: ethPriceFixture }),
    );
    await page.goto("/");
    const ethButton = toggle(page).getByRole("button", { name: "ETH" });
    const usdButton = toggle(page).getByRole("button", { name: "USD" });
    await expect(ethButton).toHaveAttribute("aria-pressed", "true");
    await expect(usdButton).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".subnav-eth-price")).toHaveText(
      "ETH $4,218.44",
    );
    await usdButton.click();
    await expect(usdButton).toHaveAttribute("aria-pressed", "true");
    await expect(ethButton).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(
      toggle(page).getByRole("button", { name: "USD" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("renders the exact USD value of a known wei figure on the screener", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "the desktop table carries the figure this asserts");
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: ethPriceFixture }),
    );
    await page.goto("/");
    const row = page
      .locator(".explore-page .desktop-pools [data-row='resolved']")
      .first();
    await expect(row).toBeAttached();
    const cell = row.locator("td").nth(4).locator(".number");
    const wei = (await cell.getAttribute("title"))!.replace(" wei", "");
    await toggle(page).getByRole("button", { name: "USD" }).click();
    await expect(cell).toHaveText(
      formatMoney(wei, "USD", ethPriceFixture.usdPerEth),
    );
  });

  test("leaves ETH figures unchanged and marks USD unavailable when the price read fails", async ({
    page,
    isMobile,
  }) => {
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({
        status: 503,
        headers: { "Retry-After": "30" },
        json: { error: "price_unavailable" },
      }),
    );
    await page.goto("/");
    const usdButton = toggle(page).getByRole("button", { name: "USD" });
    await expect(usdButton).toHaveAccessibleName(/unavailable/i);
    const row = isMobile
      ? page
          .locator(".explore-page .mobile-pools [data-row='resolved']")
          .first()
      : page
          .locator(".explore-page .desktop-pools [data-row='resolved']")
          .first();
    await expect(row).toBeAttached();
    const cell = row.locator(".number").first();
    const before = await cell.innerText();
    await usdButton.click();
    await expect(usdButton).toHaveAttribute("aria-pressed", "true");
    await expect(cell).toHaveText(before);
    await expect(page.locator(".subnav-eth-price")).toHaveText("");
    await expect(page.locator(".network-subnav")).not.toContainText("$");
  });
});

test("the retired methodology route lands on the screener", async ({
  page,
  request,
}) => {
  const response = await request.get("/methodology/", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/");
  await page.goto("/methodology/");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByRole("heading", { name: "Pools." })).toBeVisible();
});
