import { test, expect, type Page, type Route } from "@playwright/test";

/*
 * The wallet's Trades tab reads `wallets/:address/history?kind=trades`, an
 * on-demand Blockscout PRO read the e2e suite's own fixture deployment never
 * answers (readWalletTradeHistory, like the ETH/USD rate, has no preloaded
 * fallback), so every state here is exercised by intercepting that route's
 * own fetch, exactly as wallet-context.spec.ts's own route mocks do.
 */

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const historyPath = `**/api/product/wallets/${wallet}/history/**`;

function envelope(items: unknown[], nextCursor: string | null = null) {
  return {
    source: "blockscout",
    chainId: 4663,
    wallet,
    kind: "trades",
    items,
    nextCursor,
    fetchedAt: new Date().toISOString(),
    stale: false,
    note: "Explorer history for display only; not accounting or PnL evidence.",
  };
}

function trade(overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: `0x${"1".repeat(64)}`,
    logIndex: 0,
    block: 65841861,
    timestamp: 1789695885,
    side: "buy",
    token: {
      address: `0x${"a".repeat(40)}`,
      symbol: "PEPE",
      name: "Pepe",
      decimals: 18,
      type: "ERC-20",
    },
    tokenRaw: "1234567890123456789",
    method: "swapExactETHForTokens",
    ...overrides,
  };
}

async function openTrades(page: Page, viewport?: { width: number; height: number }) {
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`/wallet/${wallet}/?window=All&tab=trades`);
}

/** Whichever of the desktop table's rows or the phone's cards is actually on
    screen at the current viewport: the other exists in the DOM but hidden,
    and a plain count would tally it too. */
const resolvedRows = (page: Page) =>
  page
    .locator(
      ':is(.wallet-trades-table tbody tr, .mobile-wallet-row)[data-row="resolved"]',
    )
    .filter({ visible: true });

test("a populated page renders exact quantities, neutral sides and no ETH figure", async ({
  page,
}, testInfo) => {
  await page.route(historyPath, (route: Route) =>
    route.fulfill({ json: envelope([trade(), trade({ side: "sell", logIndex: 1 })]) }),
  );
  await openTrades(page);
  const mobile = testInfo.project.name === "mobile";
  const rows = mobile
    ? page.locator('.mobile-wallet-row[data-row="resolved"]')
    : page.locator('.wallet-trades-table tbody tr[data-row="resolved"]');
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  const region = mobile
    ? page.locator(".mobile-wallet-rows")
    : page.locator(".wallet-trades-table");
  // Bigint-exact: 1234567890123456789 raw / 1e18 = 1.234567890123456789,
  // truncated to six fractional digits - a float division of this raw value
  // is not exact at this magnitude, so an implementation that took that
  // shortcut would print a different tail.
  await expect(mobile ? first : first.locator("td").nth(1)).toContainText(
    "1.234567 PEPE",
  );
  await expect(first.locator(".address-chip .mono").first()).toHaveText(
    "0xaaaa…aaaa",
  );
  await expect(first.locator(".wallet-trade-side")).toHaveText("Buy");
  await expect(rows.nth(1).locator(".wallet-trade-side")).toHaveText("Sell");
  // Side never borrows the app's signed PnL colour classes.
  for (const side of await region.locator(".wallet-trade-side").all())
    await expect(side).not.toHaveClass(/positive|negative/);
  await expect(region).not.toContainText("ETH");
  const txLink = first.getByRole("link", { name: /0x1111…1111/ });
  await expect(txLink).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/0x${"1".repeat(64)}`,
  );
});

test("a wallet with no explorer trade history shows a designed empty state", async ({
  page,
}) => {
  await page.route(historyPath, (route: Route) =>
    route.fulfill({ json: envelope([]) }),
  );
  await openTrades(page);
  await expect(
    page.getByRole("heading", { name: "No trade history" }),
  ).toBeVisible();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
});

test("a failed read shows a compact retry banner and honors Retry-After", async ({
  page,
}) => {
  let calls = 0;
  await page.route(historyPath, (route: Route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        json: { error: "wallet_history_unavailable", reason: "budget_exhausted" },
      });
    return route.fulfill({ json: envelope([trade()]) });
  });
  await openTrades(page);
  await expect(
    page.getByRole("heading", { name: "Trade history unavailable" }),
  ).toBeVisible();
  // Withheld immediately: hammering "Try again" before the server's own
  // delay elapses would only answer the same failure again.
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({
    timeout: 3000,
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(resolvedRows(page)).toHaveCount(1);
  expect(calls).toBe(2);
});

test("Load more keys off nextCursor, never a fixed row count", async ({
  page,
}) => {
  const firstPage = Array.from({ length: 30 }, (_, i) =>
    trade({ logIndex: i, transactionHash: `0x${String(i).padStart(64, "2")}` }),
  );
  const secondPage = Array.from({ length: 5 }, (_, i) =>
    trade({
      logIndex: 100 + i,
      transactionHash: `0x${String(i).padStart(64, "3")}`,
    }),
  );
  let calls = 0;
  await page.route(historyPath, (route: Route) => {
    calls++;
    const url = new URL(route.request().url());
    if (url.searchParams.get("cursor") === "page2")
      return route.fulfill({ json: envelope(secondPage, null) });
    return route.fulfill({ json: envelope(firstPage, "page2") });
  });
  await openTrades(page);
  const rows = resolvedRows(page);
  await expect(rows).toHaveCount(25);
  expect(calls).toBe(1);
  // The remaining 5 of the 30 already on hand: revealed without a new fetch.
  await page.getByRole("button", { name: "Load 25 more" }).click();
  await expect(rows).toHaveCount(30);
  expect(calls).toBe(1);
  // The buffer is exhausted; nextCursor is non-null, so another click fetches.
  await page.getByRole("button", { name: "Load 25 more" }).click();
  await expect(rows).toHaveCount(35);
  expect(calls).toBe(2);
  // nextCursor is now null and every row on hand is shown: no further control.
  await expect(
    page.getByRole("button", { name: /Load \d+ more/ }),
  ).toHaveCount(0);
});

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`the trades tab loads at CLS 0 (${name})`, async ({ page }) => {
    await page.addInitScript(() => {
      const state = { cls: 0 };
      Object.assign(window, { tradesShifts: state });
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
    await page.route(historyPath, (route: Route) =>
      route.fulfill({
        json: envelope(
          Array.from({ length: 12 }, (_, i) => trade({ logIndex: i })),
        ),
      }),
    );
    await openTrades(page, viewport);
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
      timeout: 20000,
    });
    await expect(resolvedRows(page)).toHaveCount(12);
    const cls = await page.evaluate(
      () => (window as unknown as { tradesShifts: { cls: number } })
        .tradesShifts.cls,
    );
    // The suite's own noise tolerance (see AGENTS.md): a sub-pixel score under
    // 0.001 is measurement noise, not a real shift.
    expect(cls).toBeLessThan(0.001);
  });
}
