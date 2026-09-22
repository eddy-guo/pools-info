import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import catalog from "../../data/catalog/chain.json";
import captured from "../../data/pools/index.json";
import { preloadedProduct } from "../../apps/web/src/lib/product-server";
import { methodologyCopy } from "../support/pool-copy";
import type {
  AnalyticsExploreResponse,
  AnalyticsLeaderboardResponse,
  AnalyticsWalletResponse,
} from "@pools/core";
import {
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
    page.getByRole("link", { name: "Explorer ↗", exact: true }),
  ).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/token/${market.token}`,
  );
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
  // A wallet without saved PnL has no card, not an empty one.
  expect(
    (await request.get(`/cards/0x${"2".repeat(40)}.png?window=All`)).status(),
  ).toBe(404);
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
  await expect(dialog.getByText("No matches")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /example.eth/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
test("chart ranges from the panel head with no select", async ({
  page,
}, testInfo) => {
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
  await page.route(`**/api/markets/${market.id}/?*`, (r) =>
    r.fulfill({ json: update }),
  );
  await page.goto(poolHref(market));
  await expect(
    page.getByRole("img", { name: /Price candle chart/ }),
  ).toBeVisible();
  const panel = page.locator(".pool-chart-panel");
  await expect(panel.locator("select")).toHaveCount(0);
  const control = panel.locator(".pool-chart-head .segmented");
  await expect(control.getByRole("button")).toHaveText([
    "5m",
    "1h",
    "6h",
    "24h",
    "1W",
    "All",
  ]);
  await expect(
    control.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await control.getByRole("button", { name: "6h", exact: true }).click();
  await expect(
    control.getByRole("button", { name: "6h", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    control.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  /* The head is one row: price, unit and, on the desktop, the control; the
     labelled changes stay on the window row, and the phone wraps the control
     under them. */
  await expect(panel.locator(".live-price-heading .change")).toHaveCount(0);
  await expect(panel.locator(".live-changes .change").first()).toBeVisible();
  const [price, unit, segmented] = await Promise.all(
    [
      ".pool-chart-head .price",
      ".pool-chart-head .price small",
      ".pool-chart-head .segmented",
    ].map((selector) => page.locator(selector).boundingBox()),
  );
  for (const box of testInfo.project.name === "desktop"
    ? [unit, segmented]
    : [unit])
    expect(box!.y, "on the price's row").toBeLessThan(price!.y + price!.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
  const result = dialog.locator(`a[href^="/pool/${entry.id}/"]`);
  const shortToken = `${entry.token.slice(0, 6)}…${entry.token.slice(-4)}`;
  await expect(result).toContainText(new RegExp(shortToken, "i"));
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
  await page.goto(poolHref(pool));
  await expect(
    page.getByRole("heading", { name: pool.name, exact: true }),
  ).toBeVisible();
  const chart = page.locator(".interactive-chart canvas").first();
  await expect(chart).toBeVisible();
  let failed = 0;
  await page.route(`**/api/markets/${pool.id}/**`, (r) => {
    failed++;
    return r.fulfill({ status: 503, json: { error: "Unavailable" } });
  });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.click();
  await expect.poll(() => failed).toBe(1);
  await expect(refresh).toBeEnabled();
  await expect(chart).toBeVisible();
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

test("saved global catalog shows unprocessed pools and pages the global sort", async ({
  page,
  request,
}) => {
  const response = await request.get(
    "/api/product/explore/?limit=100&sort=launch&window=All",
  );
  const all = (await response.json()) as AnalyticsExploreResponse;
  expect(all.total).toBeGreaterThan(25);
  const unprocessed = all.items.find((p) => !p.processed)!;
  await page.goto("/?sort=launch&window=All");
  const shown = page.locator(".explore-page [data-row='resolved']").filter({
    visible: true,
  });
  await expect(shown.first()).toBeVisible();
  await expect(page.locator(".pagination")).toContainText(
    `Showing 25 of ${all.total}`,
  );
  await page.getByRole("button", { name: "Show 25 more", exact: true }).click();
  await expect(page).toHaveURL(/limit=50/);
  await expect(page.locator(".pagination")).toContainText(
    `Showing 50 of ${all.total}`,
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
  await expect(shown).toHaveCount(1);
  await page
    .locator(".desktop-pools, .mobile-pools")
    .getByRole("link", { name: new RegExp(unprocessed.symbol) })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: unprocessed.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".nullable-pool-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("body")).not.toContainText(methodologyCopy);
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
  // The card is served slowly on purpose: the modal must show its skeleton
  // first and swap the image in without moving.
  const cardRequests: string[] = [];
  await page.route(`**/cards/${wallet}.png?**`, async (r) => {
    cardRequests.push(new URL(r.request().url()).search);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#0B0B0E"/></svg>',
    });
  });
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
  // A phone shows the positions as rows rather than a table.
  await expect(
    page
      .locator("thead th", { hasText: "Holding" })
      .or(page.locator('.mobile-position[data-row="resolved"]'))
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Share PnL card", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Share PnL card/ });
  await expect(dialog).toBeVisible();
  const preview = dialog.locator("[data-state]"),
    card = dialog.getByRole("img");
  await expect(preview).toHaveAttribute("data-state", "loading");
  await expect(preview.locator("span").first()).toBeVisible();
  await expect(card).toHaveAttribute("src", `/cards/${wallet}.png?window=All`);
  // The dialog's own entrance settles first; what must not move is the slot.
  await dialog.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  await expect(preview).toHaveAttribute("data-state", "loading");
  const reserved = await preview.boundingBox();
  await expect(preview).toHaveAttribute("data-state", "ready");
  expect(await preview.boundingBox()).toEqual(reserved);
  expect(reserved!.width / reserved!.height).toBeCloseTo(1200 / 630, 2);
  // Every customize control re-renders the same route with a query parameter.
  await dialog.getByRole("radio", { name: "Mint" }).click();
  await expect(card).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&theme=mint`,
  );
  await dialog.getByRole("switch", { name: /Anonymous mode/ }).click();
  await expect(card).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&theme=mint&anon=1`,
  );
  await expect(dialog.getByRole("link", { name: "Download" })).toHaveAttribute(
    "download",
    "poolsinfo-pnl-all.png",
  );
  const notionalSwitch = dialog.getByRole("switch", { name: /Show notional/ });
  await notionalSwitch.click();
  await expect(card).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&theme=mint&anon=1&notional=1`,
  );
  await expect(preview).toHaveAttribute("data-state", "ready");
  // The design toggle is a segmented control beside the presets, defaults to
  // Liquid so it stays out of the query, and never moves the reserved slot.
  const designToggle = dialog.getByRole("group", { name: "Design" });
  await expect(
    designToggle.getByRole("button", { name: "Liquid" }),
  ).toHaveAttribute("aria-pressed", "true");
  await designToggle.getByRole("button", { name: "Export" }).click();
  // The export design's headline is already the realized amount and its
  // fixed trio has no slot for the volume, so the notional option is offered
  // disabled there with its reason on the label, and stays out of the URL
  // rather than naming an option the image ignores (sweep s6 defect 13).
  await expect(notionalSwitch).toBeDisabled();
  await expect(notionalSwitch).not.toBeChecked();
  await expect(
    dialog.locator("label").filter({ hasText: "Show notional" }),
  ).toContainText("Not offered on the Export design");
  await expect(card).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&theme=mint&anon=1&design=export`,
  );
  expect(await preview.boundingBox()).toEqual(reserved);
  await expect(dialog.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    `/cards/${wallet}.png?window=All&theme=mint&anon=1&design=export`,
  );
  await designToggle.getByRole("button", { name: "Liquid" }).click();
  // The Liquid choice was kept while the option was out of reach.
  await expect(notionalSwitch).toBeEnabled();
  await expect(notionalSwitch).toBeChecked();
  await expect(card).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&theme=mint&anon=1&notional=1`,
  );
  expect(await preview.boundingBox()).toEqual(reserved);
  // Back to Liquid is a URL already fetched once, so the browser serves it
  // from cache rather than repeating the request.
  expect(cardRequests).toEqual([
    "?window=All",
    "?window=All&theme=mint",
    "?window=All&theme=mint&anon=1",
    "?window=All&theme=mint&anon=1&notional=1",
    "?window=All&theme=mint&anon=1&design=export",
  ]);
  expect(await dialog.innerText()).not.toMatch(
    /reconcil|coverage|captur|excluded|methodolog|before gas|processed pools/i,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Share PnL card", exact: true }),
  ).toBeFocused();
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
  await expect(
    dialog.getByText("Some results are unavailable. Try again shortly."),
  ).toBeVisible();
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
  await expect(link).not.toContainText("Look up launch sender");
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
  await expect(
    dialog.getByText("Some results are unavailable. Try again shortly."),
  ).toBeVisible();
  await expect(link).toHaveAttribute("href", walletHref(address));
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${address}/`));
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
  await page
    .getByRole("button", { name: "Share PnL card", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Share PnL card/ });
  const card = dialog.getByRole("img");
  await expect(card).toBeVisible();
  await expect
    .poll(() => card.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1200);
  expect(
    await card.evaluate((image: HTMLImageElement) => image.naturalHeight),
  ).toBe(630);
  // Centred in the viewport, never in its top-left corner.
  const viewport = page.viewportSize()!,
    box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThan(0);
  expect(box.y).toBeGreaterThan(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
  await expect(dialog.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    `/cards/${top.address}.png?window=All`,
  );
  const response = await request.get(`/cards/${top.address}.png?window=All`);
  expect(response.status()).toBe(200);
  const png = await response.body();
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
  // A coarse bound against a runaway image (an embedded token picture, say):
  // the Liquid card's preset glow at the reference's strength renders at
  // about 99 KB, the export design at about 66 KB.
  expect(png.length).toBeLessThan(120_000);
  // The export design is the same route, one query parameter away, and
  // renders the real wallet at the same size within the same budget.
  await dialog
    .getByRole("group", { name: "Design" })
    .getByRole("button", { name: "Export" })
    .click();
  await expect(card).toHaveAttribute(
    "src",
    `/cards/${top.address}.png?window=All&design=export`,
  );
  await expect
    .poll(() => card.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1200);
  expect(
    await card.evaluate((image: HTMLImageElement) => image.naturalHeight),
  ).toBe(630);
  const exportResponse = await request.get(
    `/cards/${top.address}.png?window=All&design=export`,
  );
  expect(exportResponse.status()).toBe(200);
  const exportPng = await exportResponse.body();
  expect(exportPng.readUInt32BE(16)).toBe(1200);
  expect(exportPng.readUInt32BE(20)).toBe(630);
  expect(exportPng.length).toBeLessThan(120_000);
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
  await expect(page.locator(".network-context")).toHaveText(
    "v4 · Robinhood Chain",
  );
});
