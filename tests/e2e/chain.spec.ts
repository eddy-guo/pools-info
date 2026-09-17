import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import catalog from "../../data/catalog/chain.json";
import captured from "../../data/pools/index.json";
import { preloadedProduct } from "../../apps/web/src/lib/product-server";
import type {
  AnalyticsExploreResponse,
  AnalyticsPoolDetail,
  AnalyticsLeaderboardResponse,
  AnalyticsWalletResponse,
  LiveTradeFeedResponse,
  LiveTradeEvent,
} from "@pools/core";
import {
  buildHolderLedger,
  buildAnalyticsModel,
  leaderboardAnalytics,
  walletAnalytics,
  searchAnalytics,
  poolHref,
  walletHref,
  type PoolAudit,
  type Address,
  type ChainMarket,
} from "@pools/core";
const wallet = "0x1111111111111111111111111111111111111111";
const market = chain.markets[0] as ChainMarket;
function fixture(): PoolAudit {
  const executions = Array.from({ length: 11 }, (_, i) => ({
    trade: {
      id: String(i),
      poolId: market.id as Address,
      trader: wallet as Address,
      txHash: `0x${(i + 1).toString(16).padStart(64, "0")}` as Address,
      logIndex: 0,
      block: market.launchBlock + i + 1,
      timestamp: market.launchedAt + (i === 10 ? 100 : i),
      side: i === 10 ? ("sell" as const) : ("buy" as const),
      ethWei: i === 10 ? "1500000000000000000" : "100000000000000000",
      tokenRaw: i === 10 ? "100000000000000000000" : "10000000000000000000",
    },
    flags: [],
    matchedTransfer: String(i),
  }));
  return {
    poolId: market.id,
    market,
    toBlock: chain.toBlock,
    toTimestamp: chain.toTimestamp,
    generatedAt: chain.generatedAt,
    executions,
    wallets: [
      {
        address: wallet,
        swaps: 11,
        buys: 10,
        sells: 1,
        volumeWei: "2500000000000000000",
        realizedWei: "500000000000000000",
        inventoryRaw: "0",
        balanceRaw: "0",
        balanceMatches: true,
        eligible: true,
        flags: [],
        evidenceTx: market.launchTx,
      },
    ],
    unattributedSwaps: 0,
    transfersChecked: 11,
  };
}
test.beforeEach(async ({ page }) => {
  await page.route("**/api/markets/", (r) =>
    r.fulfill({ status: 503, json: { error: "disabled" } }),
  );
});
test("real screener keeps watchlists, filters, pool navigation and the legacy live link", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const redirect = await page.request.get("/live/?q=keep", { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers().location).toBe("/?q=keep");
  await page.goto("/live/");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Pools." })).toBeVisible();
  await expect(
    page
      .locator(".desktop-pools, .mobile-pools")
      .locator(".token-cell strong")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("DEMO SNAPSHOT", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Filter pools" }).fill(market.token);
  await expect(
    page
      .getByRole("button", { name: "Add to watchlist" })
      .filter({ visible: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Add to watchlist" })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "Watchlist", exact: true }).click();
  await page.reload();
  await expect(
    page
      .getByRole("button", { name: "Remove from watchlist" })
      .filter({ visible: true }),
  ).toBeVisible();
  await page.goto(poolHref(market));
  await expect(
    page.getByRole("heading", { name: market.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Launch transaction" }),
  ).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${market.launchTx}`,
  );
  await page.getByRole("button", { name: "Holders", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Holder snapshot is processing",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("saved product refresh retains data during failures and recovers without browser RPC", async ({
  page,
}) => {
  const response = preloadedProduct(
    "explore",
    new URLSearchParams("q=" + market.token),
  ) as AnalyticsExploreResponse;
  let calls = 0;
  await page.route("**/api/product/explore/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.get("q")) return route.continue();
    calls++;
    if (calls === 2)
      return route.fulfill({
        status: 503,
        json: { error: "Saved index unavailable" },
      });
    return route.fulfill({
      json: { ...response, delivery: { source: "indexer", notice: null } },
    });
  });
  await page.goto(`/?q=${market.token}`);
  const row = page
    .locator(".desktop-pools, .mobile-pools")
    .getByText(market.name, { exact: true })
    .filter({ visible: true });
  await expect(row).toBeVisible();
  await page
    .locator("main")
    .getByRole("button", { name: "Refresh saved data" })
    .click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(row).toBeVisible();
  await page
    .locator("main")
    .getByRole("button", { name: "Refresh saved data" })
    .click();
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(row).toBeVisible();
  expect(calls).toBe(3);
});
test("audited leaderboard links to real wallet metrics and scoped share cards, retaining audit on failure", async ({
  page,
}) => {
  let calls = 0;
  await page.route(`**/api/markets/${market.id}/accounting/**`, async (r) => {
    calls++;
    await r.fulfill(
      calls === 1
        ? { json: fixture() }
        : { status: 503, json: { error: "unavailable" } },
    );
  });
  await page.goto(`/traders/?pool=${market.id}&launch=${market.launchTx}`);
  await page
    .getByRole("button", { name: /^(Audit traders|Refresh audit)$/ })
    .click();
  await expect(
    page.getByRole("link", { name: "0x1111…1111", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByLabel("Minimum swaps")
    .filter({ visible: true })
    .selectOption("25");
  await expect(
    page.getByRole("heading", {
      name: "No qualifying traders in this pool and window",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Minimum swaps")
    .filter({ visible: true })
    .selectOption("10");
  await page
    .getByRole("button", { name: "Refresh audit", exact: true })
    .click();
  await expect(
    page.getByText(/The previous audit remains visible/),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "0x1111…1111", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "0x1111…1111", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("+0.5 ETH", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Trades", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Observed trade history" }),
  ).toBeVisible();
  await expect(page.getByText("+0.5 ETH", { exact: true }).first()).toHaveCSS(
    "color",
    "rgb(63, 214, 140)",
  );
  // The UI fixture supplies a synthetic audited wallet. Reuse a real captured
  // PNG for its image request; server-side card generation is tested separately.
  const capturedWallet = market.accounting!.wallets[0].address;
  const png = await page.request.get(
    `/cards/${capturedWallet}.png?pool=${market.id}&launch=${market.launchTx}&window=All`,
  );
  expect(png.status()).toBe(200);
  await page.route(`**/cards/${wallet}.png?*`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: await png.body(),
    }),
  );
  await page
    .getByRole("button", { name: "Generate share card", exact: true })
    .click();
  const share = page.getByRole("dialog", { name: "Share card" });
  await expect(share).toBeVisible();
  await expect(share.getByRole("img")).toBeVisible();
  await expect(
    share.getByRole("link", { name: "Download PNG" }),
  ).toHaveAttribute(
    "href",
    new RegExp(`/cards/${wallet}.png\\?pool=${market.id}`),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("creator routes, arbitrary wallet lookup and typed global search remain usable", async ({
  page,
}) => {
  await page.goto("/creators/");
  await expect(page.getByRole("heading", { name: "Creators." })).toBeVisible();
  await page
    .locator(`a[href="/creators/${market.launchSender.toLowerCase()}/"]`)
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/creators\/0x/);
  await page.goto("/wallet/");
  await page.getByLabel("Wallet address", { exact: true }).fill(wallet);
  await page.getByRole("button", { name: "Open wallet profile" }).click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${wallet}/`));
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const input = page.getByRole("textbox", {
    name: "Search tokens, wallets, creators, or transaction hashes",
  });
  await input.fill(market.token);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("link", { name: new RegExp(market.symbol) }),
  ).toBeVisible();
  await input.fill("example.eth");
  await expect(page.getByText(/ENS name detected/)).toBeVisible();
  await input.fill(chain.trades[0].txHash);
  await expect(page.getByRole("dialog").getByRole("link")).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${chain.trades[0].txHash}`,
  );
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("server-generated card uses captured RPC audit data and returns a 1200 by 630 PNG", async ({
  request,
}) => {
  const m = chain.markets.find(
    (m) => m.accounting?.executions?.length && m.accounting.wallets.length,
  )!;
  const address = m.accounting!.wallets[0].address;
  const response = await request.get(`/cards/${address}.png?window=All`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const image = await response.body();
  expect(image.readUInt32BE(16)).toBe(1200);
  expect(image.readUInt32BE(20)).toBe(630);
  expect((await request.get("/cards/not-an-address.png")).status()).toBe(404);
  const spoofed = await request.get(
    `/cards/${address}.png?window=All&realized=999999`,
  );
  expect(spoofed.status()).toBe(200);
  expect(await spoofed.body()).toEqual(image);
  expect((await request.get(walletHref(address, m))).status()).toBe(200);
});

test("direct pool links hydrate their candle charts without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const pool of chain.markets) {
    await page.goto(poolHref(pool));
    await page.getByRole("button", { name: "6h", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "6h", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(errors, `Hydration errors for ${pool.symbol}`).toEqual([]);
  }
});

test("command search handles fuzzy names, keyboard navigation, real resolver results and stale responses", async ({
  page,
}) => {
  await page.route("**/api/ens/**", async (r) => {
    if (r.request().url().includes("missing.eth"))
      return r.fulfill({ json: { name: "missing.eth", address: null } });
    await r.fulfill({
      json: { name: "example.eth", address: wallet, chainId: 1 },
    });
  });
  await page.goto("/");
  await expect(page.locator(".search-trigger")).toBeEnabled();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search Pools Info" });
  const input = dialog.getByRole("textbox");
  await input.fill("FOLIOO");
  await expect(dialog.getByRole("link").first()).toContainText("FOLIO");
  await input.press("ArrowDown");
  await expect(dialog.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(input).toBeFocused();
  await input.fill("missing.eth");
  await expect(dialog.getByText(/No Ethereum address record/)).toBeVisible();
  await input.fill("example.eth");
  const result = dialog.getByRole("link", { name: /example.eth/ });
  await expect(result).toHaveAttribute("href", `/wallet/${wallet}/`);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/wallet/${wallet}/`));
  await page.keyboard.press("Control+k");
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await dialog.getByRole("textbox").fill("example.eth");
  await dialog.getByRole("textbox").fill("nonsensexyz");
  await expect(
    dialog.getByText("No matches in current coverage"),
  ).toBeVisible();
  await expect(dialog.getByRole("link", { name: /example.eth/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
test("chart separates interval from range, switches FDV and keeps seven trade pages local", async ({
  page,
}) => {
  const update = structuredClone(chain);
  update.markets[0].series = Array.from({ length: 140 }, (_, i) => ({
    time: chain.toTimestamp - 140 + i,
    wei: String(1000000000 + i * 1000000),
  }));
  update.trades = Array.from({ length: 140 }, (_, i) => ({
    ...chain.trades[0],
    poolId: market.id,
    txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
    logIndex: i,
    timestamp: chain.toTimestamp - i,
  }));
  let requests = 0;
  await page.route(`**/api/markets/${market.id}/?*`, (r) => {
    requests++;
    return r.fulfill({ json: update });
  });
  await page.goto(poolHref(market));
  await expect(
    page.getByRole("img", { name: /Price candle chart/ }),
  ).toBeVisible();
  await page
    .getByLabel("Candle interval", { exact: true })
    .filter({ visible: true })
    .selectOption("1s");
  await page
    .getByLabel("Chart display")
    .filter({ visible: true })
    .selectOption("FDV");
  await expect(
    page.getByRole("img", { name: /FDV candle chart/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect(
    page
      .getByLabel("Candle interval", { exact: true })
      .filter({ visible: true }),
  ).toHaveValue("1s");
  await page.getByRole("button", { name: "Trades", exact: true }).click();
  await expect(
    page.getByText("140 swap events", { exact: true }),
  ).toBeVisible();
  const before = requests;
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("7 / 7", { exact: true })).toBeVisible();
  expect(requests).toBe(before);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

function liveEvent(
  index: number,
  timestamp: number,
  patch: Partial<LiveTradeEvent> = {},
): LiveTradeEvent {
  const hash = `0x${index.toString(16).padStart(64, "0")}`;
  return {
    id: `${hash}:0`,
    poolId: market.id,
    token: market.token,
    name: market.name,
    symbol: market.symbol,
    launchTx: market.launchTx,
    transactionHash: hash,
    logIndex: 0,
    block: chain.toBlock + index,
    blockHash: `0x${"a".repeat(64)}`,
    timestamp,
    side: "buy",
    ethWei: "100000000000000000",
    tokenRaw: "1000000",
    transactionInitiator: wallet,
    attribution: "transaction_initiator_only",
    ...patch,
  };
}
function liveBatch(
  events: LiveTradeEvent[],
  timestamp: number,
  poolId: string | null = null,
  throughBlock = chain.toBlock + 100,
): LiveTradeFeedResponse {
  return {
    source: "indexed_recent_chain_events",
    generatedAt: new Date(timestamp * 1000).toISOString(),
    poolId,
    events,
    truncated: false,
    replacement: true,
    coverage: {
      state: "current",
      scope: "verified_pools_launches_only",
      registryExhaustive: false,
      pnlAvailable: false,
      startBlock: chain.toBlock,
      headBlock: throughBlock + 128,
      throughBlock,
      throughHash: `0x${"a".repeat(64)}`,
      asOf: timestamp,
      checkedAt: new Date(timestamp * 1000).toISOString(),
      lagBlocks: 128,
      discoveryThroughBlock: throughBlock,
      discoveryLagBlocks: 128,
      knownPools: 165,
      staleAfterSeconds: 180,
    },
  };
}

// The rail shows trades and their status, never a coverage stamp.
const coverageStamp = /Checked through block|· block|tracked pools/i;

test("live feed highlights new identities, retains stale trades, pauses, and replaces reorg and empty windows", async ({
  page,
}, testInfo) => {
  const timestamp = chain.toTimestamp;
  await page.clock.install({ time: new Date(timestamp * 1000) });
  const a = liveEvent(1, timestamp),
    b = liveEvent(2, timestamp, { side: "sell" }),
    c = liveEvent(3, timestamp);
  let calls = 0;
  await page.route("**/api/live-trades/**", (route) => {
    calls++;
    if (calls === 3)
      return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    const events =
      calls === 1 ? [a, a] : calls === 2 ? [b, a] : calls === 4 ? [c] : [];
    return route.fulfill({
      json: liveBatch(
        events,
        timestamp,
        null,
        calls >= 4 ? chain.toBlock + 3 : chain.toBlock + 100,
      ),
    });
  });
  await page.goto("/");
  const feed = page.getByRole("region", { name: "Recent trades" });
  await expect(feed.locator(".stream-event")).toHaveCount(1);
  await expect(feed.locator('[data-new="true"]')).toHaveCount(0);
  await expect(feed.getByText("0.1 ETH", { exact: true })).toBeVisible();
  await expect(feed).not.toContainText(coverageStamp);
  await expect(feed.getByRole("link", { name: "0x1111…1111" })).toHaveAttribute(
    "href",
    `/wallet/${wallet}/?window=All`,
  );
  await expect(
    feed.getByRole("link", { name: market.symbol, exact: true }),
  ).toHaveAttribute("href", poolHref(market));
  await page.clock.fastForward(16000);
  await expect.poll(() => calls).toBe(2);
  await expect(feed.locator(".stream-event")).toHaveCount(2);
  await expect(feed.locator(`[data-event-id="${b.id}"]`)).toHaveAttribute(
    "data-new",
    "true",
  );
  await expect(feed.locator(`[data-event-id="${a.id}"]`)).toHaveAttribute(
    "data-new",
    "false",
  );
  await feed.screenshot({ path: testInfo.outputPath("live-trades-rail.png") });
  await expect(
    feed
      .locator(`[data-event-id="${b.id}"]`)
      .getByText("Sell", { exact: true }),
  ).toHaveCSS("color", "rgb(255, 97, 105)");
  await page.clock.fastForward(16000);
  await expect(feed.getByRole("status")).toHaveText("delayed");
  await expect(feed).not.toContainText(coverageStamp);
  await expect(feed.locator(".stream-event")).toHaveCount(2);
  await feed.getByRole("button", { name: "Pause feed" }).click();
  await page.clock.fastForward(45000);
  expect(calls).toBe(3);
  await expect(feed.getByRole("status")).toHaveText("paused");
  await feed.getByRole("button", { name: "Resume feed" }).click();
  await expect.poll(() => calls).toBe(4);
  await expect(feed.locator(".stream-event")).toHaveCount(1);
  await expect(feed.locator(`[data-event-id="${c.id}"]`)).toBeVisible();
  await expect(feed.locator(`[data-event-id="${c.id}"]`)).toHaveAttribute(
    "data-new",
    "true",
  );
  await expect(feed).not.toContainText(coverageStamp);
  await page.clock.fastForward(16000);
  await expect.poll(() => calls).toBe(5);
  await expect(feed.locator(".stream-event")).toHaveCount(0);
  await expect(feed.getByText("No recent trades")).toBeVisible();
});

test("pool live feed has bounded rows, no overlapping polls, stops when hidden, and rejects another pool", async ({
  page,
}) => {
  const timestamp = chain.toTimestamp;
  await page.clock.install({ time: new Date(timestamp * 1000) });
  let release: () => void = () => {},
    calls = 0;
  const filters: string[] = [];
  await page.route("**/api/live-trades/**", async (route) => {
    filters.push(
      new URL(route.request().url()).searchParams.get("poolId") ?? "",
    );
    calls++;
    if (calls === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    const events =
      calls === 1
        ? Array.from({ length: 50 }, (_, i) => liveEvent(i + 1, timestamp))
        : calls === 2
          ? [liveEvent(1, timestamp, { poolId: `0x${"f".repeat(64)}` })]
          : [liveEvent(51, timestamp)];
    await route.fulfill({ json: liveBatch(events, timestamp, market.id) });
  });
  await page.goto(poolHref(market), { waitUntil: "domcontentloaded" });
  const feed = page.getByRole("region", { name: "Recent trades" });
  await expect.poll(() => calls).toBe(1);
  await expect(feed.getByRole("status")).toHaveText("streaming");
  await expect(feed).not.toContainText(coverageStamp);
  await page.clock.fastForward(9000);
  expect(calls).toBe(1);
  release();
  await expect(feed.locator(".stream-event")).toHaveCount(50);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(45000);
  expect(calls).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls).toBe(2);
  await expect(feed.getByRole("status")).toHaveText("delayed");
  await expect(feed).not.toContainText(coverageStamp);
  await expect(feed.locator(".stream-event")).toHaveCount(50);
  // A delayed window recovers on the next poll; there is no retry control.
  await page.clock.fastForward(16000);
  await expect.poll(() => calls).toBe(3);
  await expect(feed.getByRole("status")).toHaveText("streaming");
  await expect(feed.locator(".stream-event")).toHaveCount(1);
  expect(filters).toEqual([market.id, market.id, market.id]);
  await page.clock.fastForward(181000);
  await expect(feed.getByRole("status")).toHaveText("delayed");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("live feed slides arriving trades into place with transform and opacity only", async ({
  page,
}, testInfo) => {
  const now = chain.toTimestamp;
  // Two-day-old trades keep the age labels' text stable across clock ticks.
  const timestamp = now - 2 * 86400;
  await page.clock.install({ time: new Date(now * 1000) });
  await page.addInitScript(() => {
    const shifts: unknown[] = [];
    Object.assign(window, { layoutShifts: shifts });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources: {
            node: Element | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (!shift.hadRecentInput)
          shifts.push({
            value: shift.value,
            sources: shift.sources.map((source) => ({
              node: source.node?.outerHTML.slice(0, 120),
              from: source.previousRect.toJSON(),
              to: source.currentRect.toJSON(),
            })),
          });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map((index) =>
    liveEvent(index, timestamp, { side: index % 2 ? "buy" : "sell" }),
  );
  const windows = [[a], [c, b, a], [d, c, b, a], [e, d, c, b, a]];
  let calls = 0;
  await page.route("**/api/live-trades/**", (route) =>
    route.fulfill({
      json: liveBatch(windows[Math.min(calls++, windows.length - 1)], now),
    }),
  );
  await page.goto("/");
  // Jumping the clock past the screener's saved-read timeout while those reads
  // are in flight aborts them into an error line that moves the table.
  await page.waitForLoadState("networkidle");
  const feed = page.getByRole("region", { name: "Recent trades" });
  const rows = feed.locator(".stream-event");
  await expect(rows).toHaveCount(1);
  await expect(feed.getByRole("status")).toHaveText("streaming");
  // Document-relative layout geometry of the feed and its surroundings,
  // unaffected by scrolling or by the transforms the entrance applies.
  const geometry = (retained: string) =>
    feed.evaluate((node, retained) => {
      const top = (element: Element | null) =>
        Math.round(element!.getBoundingClientRect().top + scrollY);
      const surface = node.querySelector(".activity-list")!;
      return {
        region: [top(node), node.getBoundingClientRect().height],
        surface: [top(surface), surface.getBoundingClientRect().height],
        below: top(node.nextElementSibling),
        retained: surface.querySelector<HTMLElement>(
          `[data-event-id="${retained}"]`,
        )!.offsetTop,
      };
    }, retained);
  const transforms = () =>
    rows.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).transform),
    );
  const shifts = () =>
    page.evaluate(
      () => (window as unknown as { layoutShifts: unknown[] }).layoutShifts,
    );
  const before = await geometry(a.id);
  const shiftsBefore = (await shifts()).length;
  await page.clock.fastForward(16000);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-event-id", c.id);
  await expect(rows.nth(0)).toHaveAttribute("data-new", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-new", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-event-id", a.id);
  await expect(rows.nth(2)).toHaveAttribute("data-new", "false");
  await expect
    .poll(transforms, { message: "the entrance runs to completion" })
    .toEqual(["none", "none", "none"]);
  await page.waitForTimeout(100);
  const after = await geometry(a.id);
  expect(
    after.retained - before.retained,
    "the retained row moved down two slots in layout",
  ).toBeGreaterThan(0);
  expect(
    { region: after.region, surface: after.surface, below: after.below },
    "nothing outside the scroll surface moved",
  ).toEqual({
    region: before.region,
    surface: before.surface,
    below: before.below,
  });
  expect(
    (await shifts()).slice(shiftsBefore),
    "layout-shift entries recorded while trades arrived",
  ).toEqual([]);
  // Freeze the document timeline so the next arrival can be inspected frame
  // by frame; scrubbing is an instrument, so entries are not counted here.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  const slot = (await geometry(c.id)).retained;
  await page.clock.fastForward(16000);
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute("data-event-id", d.id);
  const distance = (await geometry(c.id)).retained - slot;
  expect(distance, "one arriving row pushes the list one slot").toBeGreaterThan(
    0,
  );
  const frame = (time: number) =>
    feed.evaluate((node, time) => {
      for (const animation of node.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
      return [...node.querySelectorAll<HTMLElement>(".stream-event")].map(
        (row) => {
          const style = getComputedStyle(row);
          return { transform: style.transform, opacity: style.opacity };
        },
      );
    }, time);
  const frames: Record<number, { transform: string; opacity: string }[]> = {};
  for (const time of [0, 225, 450]) {
    frames[time] = await frame(time);
    await feed.screenshot({
      path: testInfo.outputPath(`live-feed-frame-${time}.png`),
    });
  }
  await testInfo.attach("live-feed-frames", {
    body: JSON.stringify({ before, after, distance, frames }, null, 2),
    contentType: "application/json",
  });
  const arriving = `matrix(1, 0, 0, 1, 0, -${distance})`;
  expect(
    frames[0],
    "every row starts where the list was painted, the arriving row invisible",
  ).toEqual([
    { transform: arriving, opacity: "0" },
    { transform: arriving, opacity: "1" },
    { transform: arriving, opacity: "1" },
    { transform: arriving, opacity: "1" },
  ]);
  for (const row of frames[225]) {
    const y = Number(row.transform.match(/, (-?[\d.]+)\)$/)![1]);
    expect(y, "the rows are still sliding down midway").toBeLessThan(0);
    expect(y).toBeGreaterThan(-distance);
  }
  expect(frames[450], "the rows settle with no transform left").toEqual(
    Array.from({ length: 4 }, () => ({ transform: "none", opacity: "1" })),
  );
  await feed.evaluate((node) => {
    // The head's streaming dot pulses without end; only the row slides settle.
    for (const row of node.querySelectorAll(".stream-event"))
      for (const animation of row.getAnimations({ subtree: true }))
        animation.finish();
  });
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.fastForward(16000);
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveAttribute("data-event-id", e.id);
  await expect(rows.nth(0)).toHaveAttribute("data-new", "true");
  await expect(rows.nth(0)).toBeVisible();
  await expect(rows.nth(0)).toHaveCSS("animation-name", "none");
  await expect(rows.nth(0)).toHaveCSS("opacity", "1");
  expect(await transforms()).toEqual(Array.from({ length: 5 }, () => "none"));
  expect(
    await feed.evaluate((node) => node.getAnimations({ subtree: true }).length),
    "reduced motion shows the row without any animation",
  ).toBe(0);
});

test("catalog token search opens a verified pool link and loads its details on demand", async ({
  page,
}) => {
  const entry = catalog.pools.find(
    (p) => !chain.markets.some((m) => m.id === p.id),
  )!;
  const data = structuredClone(chain);
  data.markets = [{ ...chain.markets[0], ...entry }];
  data.trades = [];
  let requested = false;
  await page.route(`**/api/markets/${entry.id}/?*`, (r) => {
    requested = true;
    expect(r.request().url()).toContain(`launch=${entry.launchTx}`);
    return r.fulfill({ json: data });
  });
  await page.goto("/");
  await expect(page.locator(".search-trigger")).toBeEnabled();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search Pools Info" });
  await dialog.getByRole("textbox").fill(entry.token);
  const result = dialog
    .getByRole("link", { name: new RegExp(entry.token, "i") })
    .filter({ hasText: "details load on demand" });
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/pool/${entry.id}/`));
  await expect(
    page.getByRole("heading", { name: entry.name, exact: true }),
  ).toBeVisible();
  expect(requested).toBe(true);
});

test("captured pool history loads without RPC and survives a failed refresh", async ({
  page,
}) => {
  const saved = Object.values(captured.snapshots)[0];
  const pool = saved.markets[0];
  let marketRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes(`/api/markets/${pool.id}/`)) marketRequests++;
  });
  await page.goto(poolHref(pool));
  await expect(
    page.getByRole("heading", { name: pool.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Trades", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText(
    `${saved.trades.length} swap events`,
  );
  await expect(page.locator(".live-candles canvas").first()).toBeVisible();
  const initialRequests = marketRequests;
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText(
    `7 / ${Math.ceil(saved.trades.length / 20)}`,
  );
  expect(marketRequests).toBe(initialRequests);
  await page.route(`**/api/markets/${pool.id}/**`, (r) =>
    r.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page
    .getByRole("button", { name: "Refresh pool data", exact: true })
    .click();
  await expect(
    page.getByText(
      "Refresh unavailable. The captured pool data remains visible.",
    ),
  ).toBeVisible();
  await expect(page.locator(".pagination")).toContainText(
    `${saved.trades.length} swap events`,
  );
  await expect(
    page.getByRole("button", { name: "Refresh pool data", exact: true }),
  ).toBeEnabled();
  // The expanded capture includes saved accounting, available without a network audit.
  const audit = await page.request.get(
    `/api/markets/${pool.id}/accounting/?launch=${pool.launchTx}`,
  );
  expect(audit.status()).toBe(200);
  const savedAudit = await audit.json();
  expect(savedAudit.executions).toHaveLength(saved.trades.length);
  expect(savedAudit.wallets.length).toBeGreaterThan(100);
});

test("existing device watchlists survive the design key migration and can stay empty", async ({
  page,
}) => {
  await page.addInitScript((id) => {
    if (localStorage.getItem("pools:watchlist") === null)
      localStorage.setItem("pools:watchlist", JSON.stringify([id]));
  }, market.id);
  await page.goto(`/?view=watchlist&q=${market.token}`);
  const remove = page
    .getByRole("button", { name: "Remove from watchlist" })
    .filter({ visible: true });
  await expect(remove).toHaveCount(1);
  await remove.click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("poolsinfo.watchlist.v1")),
    )
    .toBe("[]");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pools." })).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "Remove from watchlist" })
      .filter({ visible: true }),
  ).toHaveCount(0);
});

test("a captured losing wallet shows independently signed PnL and real creator coverage", async ({
  page,
}) => {
  const pool = chain.markets.find((p) =>
    p.accounting?.wallets.some(
      (w) => w.realizedWei !== null && BigInt(w.realizedWei) < 0n,
    ),
  )!;
  const losing = pool.accounting!.wallets.find(
    (w) => w.realizedWei !== null && BigInt(w.realizedWei) < 0n,
  )!;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(walletHref(losing.address, pool));
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Realized PnL", { exact: true }) })
      .locator(".negative"),
  ).toHaveCSS("color", "rgb(255, 97, 105)");
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Realized ROI", { exact: true }) })
      .locator(".negative"),
  ).toHaveCSS("color", "rgb(255, 97, 105)");
  await page.getByRole("tab", { name: "Launches", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Launches.*covered/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/Grouped by launch transaction sender/),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Trades", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Observed trade history" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("a stale market snapshot never presents old launches as just minted", async ({
  page,
}) => {
  const latest = [...catalog.pools, ...chain.markets].sort(
    (a, b) => b.launchedAt - a.launchedAt,
  )[0];
  const now = latest.launchedAt + 6 * 60 * 60;
  await page.clock.install({ time: new Date(now * 1000) });
  await page.goto("/");
  const first = page
    .locator(`.launch-card time[data-launched-at="${latest.launchedAt}"]`)
    .first();
  const ageMinutes = Math.floor((now - latest.launchedAt) / 60);
  const expected =
    ageMinutes < 60
      ? `${ageMinutes}m`
      : ageMinutes < 1440
        ? `${Math.floor(ageMinutes / 60)}h`
        : `${Math.floor(ageMinutes / 1440)}d`;
  await expect(first).toHaveText(expected);
  await expect(first).not.toHaveText("<1m");
});

test("saved global catalog shows unprocessed pools and paginates the global sort", async ({
  page,
  request,
}) => {
  const response = await request.get(
    "/api/product/explore/?limit=100&sort=launch&window=All",
  );
  const all = (await response.json()) as AnalyticsExploreResponse;
  expect(all.total).toBeGreaterThan(25);
  const unprocessed = all.items.find((p) => !p.processed)!;
  await page.route(`**/api/live-trades/?poolId=${unprocessed.id}`, (route) =>
    route.fulfill({
      json: liveBatch(
        [
          liveEvent(1, chain.toTimestamp, {
            poolId: unprocessed.id,
            token: unprocessed.token,
            name: unprocessed.name,
            symbol: unprocessed.symbol,
            launchTx: unprocessed.launchTx,
          }),
        ],
        chain.toTimestamp,
        unprocessed.id,
      ),
    }),
  );
  await page.goto("/?sort=launch&window=All");
  await expect(page.locator(".pagination")).toContainText(
    `1-25 of ${all.total}`,
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/offset=25/);
  await expect(page.locator(".pagination")).toContainText(
    `26-50 of ${all.total}`,
  );
  const displayed = page
    .locator(".desktop-pools, .mobile-pools")
    .getByText(all.items[25].name, { exact: true })
    .filter({ visible: true })
    .first();
  await expect(displayed).toBeVisible();
  await page
    .getByRole("textbox", { name: "Filter pools" })
    .fill(unprocessed.token);
  await expect(page.locator(".pagination")).toContainText("1-1 of 1");
  await page
    .locator(".desktop-pools, .mobile-pools")
    .getByRole("link", { name: new RegExp(unprocessed.symbol) })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: unprocessed.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/background analytics are still processing/),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Recent trades" })
      .locator(".stream-event"),
  ).toHaveCount(1);
});

test("default saved leaderboard opens matching global wallet positions, trades and card without audits", async ({
  page,
}) => {
  const audit = fixture();
  const snapshot = {
    ...chain,
    toTimestamp: Math.max(
      chain.toTimestamp,
      ...audit.executions.map((e) => e.trade.timestamp),
    ),
    toBlock: Math.max(
      chain.toBlock,
      ...audit.executions.map((e) => e.trade.block),
    ),
    markets: [
      {
        ...market,
        accounting: {
          executions: audit.executions,
          wallets: audit.wallets,
          unattributedSwaps: 0,
          transfersChecked: 11,
        },
      },
    ],
    trades: audit.executions.map((e) => e.trade),
  };
  const model = buildAnalyticsModel(
    [market],
    [
      {
        snapshot,
        holders: null,
        liquidityWei: null,
        sourceKind: "indexed",
        generatedAt: chain.generatedAt,
      },
    ],
  );
  const board = leaderboardAnalytics(model, { window: "All", minTrades: 10 });
  const profile = walletAnalytics(model, wallet, "All");
  expect(board.items[0].realizedWei).toBe("500000000000000000");
  expect(profile.wallet.realizedWei).toBe(board.items[0].realizedWei);
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/accounting/") || r.method() === "POST")
      reads.push(r.url());
  });
  await page.route("**/api/product/leaderboard/?**", (r) =>
    r.fulfill({
      json: { ...board, delivery: { source: "indexer", notice: null } },
    }),
  );
  await page.route(`**/api/product/wallets/${wallet}/?**`, (r) =>
    r.fulfill({
      json: { ...profile, delivery: { source: "indexer", notice: null } },
    }),
  );
  await page.route(`**/cards/${wallet}.png?**`, (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#0B0B0E"/></svg>',
    }),
  );
  await page.goto("/traders/?window=All");
  await expect(page.getByRole("button", { name: /Audit traders/ })).toHaveCount(
    0,
  );
  await page
    .locator(`a[href="/wallet/${wallet}/?window=All"]`)
    .filter({ visible: true })
    .first()
    .click();
  const realized = page
    .locator(".stat")
    .filter({ has: page.getByText("Realized PnL", { exact: true }) });
  await expect(realized).toContainText("+0.5 ETH");
  await expect(realized.locator(".positive")).toHaveCSS(
    "color",
    "rgb(63, 214, 140)",
  );
  await expect(
    page.getByRole("heading", { name: "Positions by pool" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Trades", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Trade history" }),
  ).toBeVisible();
  await expect(page.locator("main tbody tr")).toHaveCount(11);
  await page
    .getByRole("button", { name: "Share PnL card", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "PnL share card preview" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All`,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(reads).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("command search extends instant local matches with saved-only tokens and wallets and keeps local results on outage", async ({
  page,
}) => {
  const indexed = {
    ...market,
    id: `0x${"a".repeat(64)}`,
    token: `0x${"a".repeat(40)}`,
    name: "Quasar Indexed",
    symbol: "QSR",
    launchTx: `0x${"b".repeat(64)}`,
  };
  const model = buildAnalyticsModel([indexed], []);
  let release: () => void = () => {};
  let pending = false;
  await page.route("**/api/product/search/?**", async (r) => {
    const q = new URL(r.request().url()).searchParams.get("q")!;
    if (q === market.symbol) {
      await new Promise<void>((resolve) => {
        release = resolve;
        pending = true;
      });
      return r.fulfill({ status: 503, json: { error: "Unavailable" } });
    }
    const result = await searchAnalytics(model, q);
    if (q === "wallet:0x1111")
      result.entries = [
        {
          id: `wallet:${wallet}`,
          group: "Wallets",
          title: "0x1111…1111",
          context: "Saved wallet across processed pools",
          address: wallet,
          terms: [wallet],
          href: `/wallet/${wallet}/?window=All`,
        },
      ];
    return r.fulfill({
      json: {
        ...result,
        delivery: { source: "indexer", notice: null },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog"),
    input = dialog.getByRole("textbox");
  await input.fill(market.symbol);
  await expect(
    dialog.getByRole("link", { name: new RegExp(market.symbol) }).first(),
  ).toBeVisible();
  await expect.poll(() => pending).toBe(true);
  release();
  await expect(dialog.getByText(/Saved search is unavailable/)).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: new RegExp(market.symbol) }).first(),
  ).toBeVisible();
  await input.fill("wallet:0x1111");
  await expect(dialog.getByRole("link", { name: /0x1111/ })).toHaveAttribute(
    "href",
    `/wallet/${wallet}/?window=All`,
  );
  await input.fill("Quasar");
  const token = dialog.getByRole("link", { name: /Quasar Indexed/ });
  await expect(token).toHaveAttribute("href", poolHref(indexed));
  await token.click();
  await expect(page).toHaveURL(new RegExp(indexed.id));
});

test("ENS creator search reaches saved-only creators and opens their profile", async ({
  page,
}) => {
  const creator = `0x${"a9".repeat(20)}`;
  const queries: string[] = [];
  const model = buildAnalyticsModel(
    [{ ...market, launchSender: creator as Address }],
    [],
  );
  await page.route("**/api/ens/?**", (r) =>
    r.fulfill({ json: { name: "indexed.eth", address: creator } }),
  );
  await page.route("**/api/product/search/?**", async (r) => {
    const q = new URL(r.request().url()).searchParams.get("q")!;
    queries.push(q);
    await r.fulfill({ json: await searchAnalytics(model, q) });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("creator:indexed.eth");
  const link = dialog.locator(`a[href="/creators/${creator}/"]`);
  await expect(link).toBeVisible();
  await expect.poll(() => queries).toContain(`creator:${creator}`);
  await expect(link).not.toContainText("creator status not verified");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/creators/${creator}/`));
});

test("ENS wallet fallback stays usable while saved search is slow or unavailable", async ({
  page,
}) => {
  const address = `0x${"a9".repeat(20)}`;
  let pending = false;
  let release: () => void = () => {};
  await page.route("**/api/ens/?**", (r) =>
    r.fulfill({ json: { name: "indexed.eth", address } }),
  );
  await page.route("**/api/product/search/?**", async (r) => {
    if (
      new URL(r.request().url()).searchParams.get("q") === `wallet:${address}`
    ) {
      await new Promise<void>((resolve) => {
        release = resolve;
        pending = true;
      });
    }
    await r.fulfill({ status: 503, json: { error: "Unavailable" } });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("indexed.eth");
  const link = dialog.getByRole("link", { name: /indexed.eth/ });
  await expect(link).toBeVisible();
  await expect.poll(() => pending).toBe(true);
  await expect(dialog.getByRole("link")).toHaveCount(1);
  release();
  await expect(dialog.getByText(/Saved search is unavailable/)).toBeVisible();
  await expect(link).toHaveAttribute("href", walletHref(address));
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${address}/`));
});

test("saved pool details show reconciled holders and label infrastructure separately", async ({
  page,
}) => {
  const payload = (await preloadedProduct(
    `pools/${market.id}`,
    new URLSearchParams("window=All"),
  )) as { analytics: AnalyticsPoolDetail };
  const infrastructure = `0x${"2".repeat(40)}` as Address;
  const zero = `0x${"0".repeat(40)}` as Address;
  const hash = `0x${"a".repeat(64)}` as Address;
  payload.analytics.holders = buildHolderLedger(
    [wallet, infrastructure].map((address, index) => ({
      token: market.token,
      txHash: hash,
      blockHash: hash,
      block: market.launchBlock,
      logIndex: index,
      from: zero,
      to: address as Address,
      valueRaw: "100000000000000000000",
    })),
    {
      token: market.token,
      coverage: {
        fromBlock: market.launchBlock,
        toBlock: chain.toBlock,
        cutoffBlockHash: hash,
        tokenBirthBlock: market.launchBlock,
      },
      totalSupplyRaw: "200000000000000000000",
      infrastructure: [{ address: infrastructure, label: "PoolManager" }],
    },
  );
  let savedReads = 0;
  await page.route(`**/api/product/pools/${market.id}/`, (r) => {
    savedReads++;
    return r.fulfill({
      json: { ...payload, delivery: { source: "indexer", notice: null } },
    });
  });
  await page.goto(poolHref(market));
  await page.getByRole("button", { name: "Holders", exact: true }).click();
  await expect(page.getByText(/Reconciled holder snapshot/)).toBeVisible();
  await expect(page.locator("main tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("cell", { name: "PoolManager", exact: true }),
  ).toBeVisible();
  const holders = page
    .locator(".stat")
    .filter({ has: page.getByText("Holders", { exact: true }) });
  await expect(holders.locator("strong").filter({ visible: true })).toHaveText(
    "1",
  );
  await page
    .getByRole("button", { name: "Refresh pool data", exact: true })
    .click();
  await expect.poll(() => savedReads).toBe(2);
  await expect(
    page.getByText(/Balances do not establish cost basis or PnL/),
  ).toBeVisible();
});

test("real preloaded leaderboard opens its profitable top wallet and generates the same global card", async ({
  page,
  request,
}, testInfo) => {
  // No product endpoint or image interception: this reads the actual captured dataset.
  const boardResponse = await request.get(
    "/api/product/leaderboard/?window=All&minTrades=10&metric=realized&limit=25",
  );
  expect(boardResponse.status()).toBe(200);
  const board = (await boardResponse.json()) as AnalyticsLeaderboardResponse;
  expect(board.total).toBeGreaterThanOrEqual(50);
  const top = board.items[0];
  expect(top.address).toBe("0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1");
  expect(top.realizedWei).toBe("11471084300772102");
  const profileResponse = await request.get(
    `/api/product/wallets/${top.address}/?window=All`,
  );
  expect(profileResponse.status()).toBe(200);
  const profile = (await profileResponse.json()) as AnalyticsWalletResponse;
  expect(profile.wallet.realizedWei).toBe(top.realizedWei);
  expect(profile.wallet.rank).toBe(1);
  expect(profile.curve.at(-1)?.wei).toBe(top.realizedWei);
  const browserErrors: string[] = [],
    unexpected: string[] = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/accounting/") || r.method() === "POST")
      unexpected.push(r.url());
  });
  await page.goto("/traders/?window=All");
  await page
    .locator(`a[href="/wallet/${top.address}/?window=All"]`)
    .filter({ visible: true })
    .first()
    .click();
  const stat = page
    .locator(".stat")
    .filter({ has: page.getByText("Realized PnL", { exact: true }) })
    .filter({ visible: true });
  await expect(stat.locator(".positive")).toHaveAttribute(
    "title",
    `${top.realizedWei} wei`,
  );
  await expect(stat).toContainText("+0.01147 ETH");
  await page.getByRole("tab", { name: "Trades", exact: true }).click();
  await expect(
    page.locator("main tbody tr").filter({ visible: true }),
  ).toHaveCount(profile.trades.length);
  await page
    .getByRole("button", { name: "Share PnL card", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "PnL share card preview" });
  const card = dialog.getByRole("img");
  await expect(card).toBeVisible();
  await expect
    .poll(() => card.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1200);
  await expect(
    dialog.getByRole("link", { name: /Download PNG/ }),
  ).toHaveAttribute("href", `/cards/${top.address}.png?window=All`);
  const response = await request.get(`/cards/${top.address}.png?window=All`);
  expect(response.status()).toBe(200);
  const png = await response.body();
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
  await page.screenshot({
    path: testInfo.outputPath("real-positive-wallet-card.png"),
    fullPage: true,
  });
  expect(browserErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("an empty saved analytics publication shows processing instead of the Unix epoch", async ({
  page,
}) => {
  const base = preloadedProduct(
    "explore",
    new URLSearchParams(),
  ) as AnalyticsExploreResponse;
  await page.route("**/api/product/explore/?**", (route) =>
    route.fulfill({
      json: {
        ...base,
        items: [],
        total: 0,
        nextOffset: null,
        coverage: {
          ...base.coverage,
          catalogPools: 165,
          processedPools: 0,
          asOf: 0,
          oldestAsOf: null,
        },
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "No pools match these filters" }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("1970");
  await expect(page.locator(".network-subnav")).toHaveText(
    "v4 · Robinhood Chain",
  );
});
