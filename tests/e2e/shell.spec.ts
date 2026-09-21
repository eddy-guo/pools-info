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
    // the strip's dot settles on the rail's own word for a read that failed:
    // delayed, never "Paused" (nobody paused it) and never "Live".
    await expect(page.locator(".subnav-live")).toHaveAttribute(
      "data-state",
      "delayed",
    );
    await expect(page.locator(".subnav-live")).toHaveText("Delayed");
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
    await expect(connect).toHaveAttribute("aria-haspopup", "dialog");
    await expect(connect).toHaveAccessibleName("Set my wallet");
    const search = await page
      .locator(".header-actions .search-trigger")
      .boundingBox();
    const box = await connect.boundingBox();
    expect(box!.x, "the placeholder sits right of search").toBeGreaterThan(
      search!.x + search!.width,
    );
    if (isMobile) {
      // Under 768 px the control is an icon-only 44 px square: its name
      // carries the label and no chip text is drawn.
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
      await expect(connect).toContainText("Set my wallet");
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
    await connect.click();
    const setWalletDialog = page.getByRole("dialog", { name: "Set my wallet" });
    await expect(setWalletDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(setWalletDialog).toBeHidden();
    await expect(page.locator(".footer")).toContainText(
      "Independent analytics. Not affiliated with Uniswap Labs.",
    );
    // The candle chart's library is credited here, not on the chart: its
    // licence wants its NOTICE line and a link to tradingview.com on a page
    // users see, so the on-chart logo is off (candles.tsx) and this plain
    // line stands in on every route at every width - text only, no mark.
    const credit = page.locator(".footer .footer-credit");
    await expect(credit).toBeVisible();
    await expect(credit).toHaveText(
      "TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/",
    );
    await expect(credit.getByRole("link")).toHaveAttribute(
      "href",
      "https://www.tradingview.com/",
    );
    await expect(credit.locator("img, svg")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

/* No list scrolls sideways at any width. The page never measured wider than
   the viewport; the tables did, inside their own scroll boxes (the creators
   board was 1000px in a 360px box on a phone, the trader leaderboard 1095px in
   729px at 768), so every scrollable box is held to its own width too. The
   Just launched rail is a designed card carousel, the one box that may. Every
   width is pure CSS here, so one load is measured across all five. */
for (const route of routes) {
  test(`${route} fits every width without a sideways scroll`, async ({
    page,
    isMobile,
  }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const widths = isMobile
      ? [page.viewportSize()!.width]
      : [390, 768, 1024, 1280, 1440];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(async () => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const root = document.scrollingElement!;
        const boxes = [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((node) => {
            if (node.closest(".launch-rail")) return false;
            const { overflowX } = getComputedStyle(node);
            return (
              (overflowX === "auto" || overflowX === "scroll") &&
              node.scrollWidth > node.clientWidth + 1
            );
          })
          .map(
            (node) =>
              `${node.className}: ${node.scrollWidth}px in ${node.clientWidth}px`,
          );
        return { page: root.scrollWidth - root.clientWidth, boxes };
      });
      expect(overflow.page, `the page at ${width}px`).toBeLessThanOrEqual(1);
      expect(overflow.boxes, `scroll boxes at ${width}px`).toEqual([]);
    }
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

test("the strip's Live dot shows Delayed, never Live or Paused, when the feed read fails", async ({
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
  const before = await dot.boundingBox();
  await expect(dot).toHaveAttribute("data-state", "delayed");
  await expect(dot).toHaveText("Delayed");
  expect((await dot.boundingBox())!.width, "the reserved width holds").toBe(
    before!.width,
  );
});

// Sweep s6 defect 17: the strip read "Paused" while the rail said the feed
// was running, and still "Paused" once the reader paused it. The strip now
// carries the rail's own word, so every state the rail can be in reads the
// same in both places, and a page with no rail names the feed as the rail
// would (offline for a feed that never started, never "Paused").
test("the strip tracks the rail through streaming, paused and offline", async ({
  page,
}) => {
  await page.clock.install({
    time: new Date(liveFeedFixture.coverage.asOf * 1000),
  });
  let offline = false;
  await page.route("**/api/live-trades/", (route) =>
    route.fulfill({
      json: offline
        ? {
            ...liveFeedFixture,
            events: [],
            coverage: {
              ...liveFeedFixture.coverage,
              state: "uninitialized",
              startBlock: null,
              headBlock: null,
              throughBlock: null,
              throughHash: null,
              asOf: null,
              checkedAt: null,
              lagBlocks: null,
              discoveryThroughBlock: null,
              discoveryLagBlocks: null,
            },
          }
        : liveFeedFixture,
    }),
  );
  await page.goto("/");
  const dot = page.locator(".subnav-live");
  const rail = page.getByRole("region", { name: "Recent trades" });
  const railState = rail.getByRole("status");
  await expect(railState).toHaveText("streaming");
  await expect(dot).toHaveAttribute("data-state", "streaming");
  await expect(dot).toHaveText("Live");
  const width = (await dot.boundingBox())!.width;
  await rail.getByRole("button", { name: "Pause feed" }).click();
  await expect(railState).toHaveText("paused");
  await expect(dot).toHaveAttribute("data-state", "paused");
  await expect(dot).toHaveText("Paused");
  expect((await dot.boundingBox())!.width).toBe(width);
  await rail.getByRole("button", { name: "Resume feed" }).click();
  await expect(railState).toHaveText("streaming");
  await expect(dot).toHaveText("Live");
  // A page without a rail polls on its own and names a feed that never
  // started offline, the honest state while nothing feeds the rail.
  offline = true;
  await page.goto("/traders/");
  await expect(dot).toHaveAttribute("data-state", "offline");
  await expect(dot).toHaveText("Offline");
  expect((await dot.boundingBox())!.width).toBe(width);
});

test.describe("Wallet profile entry", () => {
  const control = (page: import("@playwright/test").Page) =>
    page.locator(".header-actions .connect-button");

  test("the set-wallet dialog validates the address and the chip updates without reload", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/");
    const trigger = control(page);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Set my wallet" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Saved only in this browser. No connection is made."),
    ).toBeVisible();
    const input = dialog.getByLabel("Your wallet address");
    await input.fill("not-an-address");
    await dialog.getByRole("button", { name: "Use this wallet" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Enter a valid 0x address.",
    );
    await expect(dialog).toBeVisible();
    const before = await trigger.boundingBox();
    await input.fill(wallet);
    await dialog.getByRole("button", { name: "Use this wallet" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    if (!isMobile) await expect(trigger).toContainText("0x4745…bce1");
    const after = await trigger.boundingBox();
    expect(
      after!.width,
      "the reserved box does not move when the wallet is set",
    ).toBe(before!.width);
    expect(
      await page.evaluate(() => localStorage.getItem("poolsinfo.my-wallet.v1")),
    ).toBe(wallet);
  });

  test("the connected menu reaches every destination, closes on Escape with focus returned, and forgets the wallet", async ({
    page,
  }) => {
    await page.addInitScript((address) => {
      localStorage.setItem("poolsinfo.my-wallet.v1", address);
    }, wallet);
    await page.goto("/");
    const trigger = control(page);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "Wallet menu" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Portfolio",
      "Following",
      "Watchlist",
      "Share PnL card",
      "Forget this wallet",
    ]);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();

    await trigger.click();
    await menu.getByRole("menuitem", { name: "Portfolio" }).click();
    await expect(page).toHaveURL(`/wallet/${wallet}/`);
    await expect(page.locator(".page-heading h1")).toHaveText("Portfolio");

    await trigger.click();
    await menu.getByRole("menuitem", { name: "Following" }).click();
    await expect(page).toHaveURL(/\/traders\/\?view=following$/);

    await trigger.click();
    await menu.getByRole("menuitem", { name: "Watchlist" }).click();
    await expect(page).toHaveURL(/\/\?view=watchlist$/);

    await trigger.click();
    await menu.getByRole("menuitem", { name: "Share PnL card" }).click();
    const share = page.getByRole("dialog", { name: "Share PnL card" });
    await expect(share).toBeVisible();
    await page.getByRole("button", { name: "Close share card" }).click();
    await expect(share).toBeHidden();

    await trigger.click();
    await menu.getByRole("menuitem", { name: "Forget this wallet" }).click();
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAccessibleName("Set my wallet");
    expect(
      await page.evaluate(() => localStorage.getItem("poolsinfo.my-wallet.v1")),
    ).toBeNull();
  });

  test("the mobile chip collapses to the identity tile only", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "desktop keeps the full chip");
    await page.addInitScript((address) => {
      localStorage.setItem("poolsinfo.my-wallet.v1", address);
    }, wallet);
    await page.goto("/");
    const trigger = control(page);
    const box = await trigger.boundingBox();
    expect(box!.width).toBe(44);
    expect(box!.height).toBe(44);
    expect((await trigger.innerText()).trim()).toBe("");
    await expect(trigger.locator(".avatar")).toBeVisible();
  });

  test("a stored wallet paints the connected chip on the screener with zero layout shift", async ({
    page,
  }) => {
    await page.addInitScript((address) => {
      localStorage.setItem("poolsinfo.my-wallet.v1", address);
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
    }, wallet);
    await page.goto("/");
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
      timeout: 20000,
    });
    await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
    await expect(control(page)).toHaveAttribute("aria-haspopup", "menu");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { layoutMeasurement: { cls: number } })
            .layoutMeasurement.cls,
      ),
      "every non-input layout shift since navigation",
    ).toBe(0);
  });
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
    await expect(page.locator(".subnav-eth-price")).toHaveText("ETH $4,218.44");
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
