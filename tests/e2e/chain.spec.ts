import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import catalog from "../../data/catalog/chain.json";
import captured from "../../data/pools/index.json";
import {
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
  await expect(page).toHaveURL("http://127.0.0.1:3101/");
  await expect(page.getByRole("heading", { name: "Pools." })).toBeVisible();
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Launches covered", { exact: true }) })
      .getByText(String(chain.markets.length), { exact: true })
      .filter({ visible: true }),
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
      name: "Holder balances are not collected yet",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("refresh failure retains data and recovers, with pause stopping automatic requests", async ({
  page,
}) => {
  let calls = 0;
  const updated = structuredClone(chain);
  updated.generatedAt = new Date().toISOString();
  updated.toTimestamp = Math.floor(Date.now() / 1000);
  updated.toBlock += 100;
  updated.markets[0].name = "Updated real token";
  await page.clock.install();
  await page.route("**/api/markets/", async (r) => {
    calls++;
    await r.fulfill(
      calls === 1
        ? { status: 503, json: { error: "unavailable" } }
        : { json: updated },
    );
  });
  await page.goto("/");
  await expect(
    page.getByText("Updates delayed - showing last captured data", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(
    page.getByText("Automatic updates active", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".desktop-pools, .mobile-pools")
      .getByText("Updated real token", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pause updates", exact: true })
    .click();
  const before = calls;
  await page.clock.fastForward(65000);
  expect(calls).toBe(before);
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
  await page.goto("/methodology/");
  await expect(
    page.getByRole("heading", { name: "Behind the numbers." }),
  ).toBeVisible();
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
  const response = await request.get(
    `/cards/${address}.png?pool=${m.id}&launch=${m.launchTx}&window=All`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const image = await response.body();
  expect(image.readUInt32BE(16)).toBe(1200);
  expect(image.readUInt32BE(20)).toBe(630);
  expect((await request.get("/cards/not-an-address.png")).status()).toBe(404);
  expect(
    (await request.get(`/cards/${address}.png?realized=999999`)).status(),
  ).toBe(400);
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
  await page.route("**/api/markets/", (r) => {
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

test("live feed deduplicates overlapping checks, retains data on failure, and pauses", async ({
  page,
}) => {
  await page.clock.install();
  let count = 0;
  const event = {
    poolId: market.id,
    txHash: chain.trades[0].txHash,
    logIndex: 0,
    block: chain.toBlock,
    timestamp: Math.floor(Date.now() / 1000),
    amount0: "-100000000000000000",
    amount1: "1000000",
    transactionSender: wallet,
  };
  const batch = {
    fromBlock: chain.toBlock - 999,
    toBlock: chain.toBlock,
    toTimestamp: Math.floor(Date.now() / 1000),
    events: [event],
    truncated: false,
    generatedAt: new Date().toISOString(),
  };
  await page.route("**/api/trades/**", (r) => {
    count++;
    return r.fulfill(
      count === 3
        ? { status: 503, json: { error: "unavailable" } }
        : { json: batch },
    );
  });
  await page.goto("/");
  const feed = page.locator(".trade-stream");
  await expect(feed.locator(".stream-event")).toHaveCount(1);
  await expect(feed.getByText("0.1 ETH", { exact: true })).toBeVisible();
  await page.clock.fastForward(16000);
  await expect.poll(() => count).toBe(2);
  await expect(feed.locator(".stream-event")).toHaveCount(1);
  await page.clock.fastForward(16000);
  await expect(feed.getByText(/Updates delayed/)).toBeVisible();
  await expect(feed.locator(".stream-event")).toHaveCount(1);
  await feed.getByRole("button", { name: "Pause feed" }).click();
  const before = count;
  await page.clock.fastForward(32000);
  expect(count).toBe(before);
  await feed.getByRole("button", { name: "Resume feed" }).click();
  await expect.poll(() => count).toBe(before + 1);
  await expect(feed.locator(".stream-event")).toHaveCount(1);
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
  // A market-only capture must not accidentally start a network audit in offline mode.
  const audit = await page.request.get(
    `/api/markets/${pool.id}/accounting/?launch=${pool.launchTx}`,
  );
  expect(audit.status()).toBe(503);
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
  const now = chain.toTimestamp + 6 * 60 * 60;
  await page.clock.install({ time: new Date(now * 1000) });
  await page.goto("/");
  const first = page
    .locator(`.launch-card time[data-launched-at="${market.launchedAt}"]`)
    .first();
  const ageMinutes = Math.floor((now - market.launchedAt) / 60);
  const expected =
    ageMinutes < 60
      ? `${ageMinutes}m`
      : ageMinutes < 1440
        ? `${Math.floor(ageMinutes / 60)}h`
        : `${Math.floor(ageMinutes / 1440)}d`;
  await expect(first).toHaveText(expected);
  await expect(first).not.toHaveText("<1m");
});
