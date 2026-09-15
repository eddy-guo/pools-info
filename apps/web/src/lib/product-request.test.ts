import test from "node:test";
import assert from "node:assert/strict";
import { productRequest } from "./product-request";
import { preloadedProduct, readProduct } from "./product-server";
import { walletCaptureLabel, readCardWallet } from "./product-card";
import type {
  AnalyticsExploreResponse,
  AnalyticsLeaderboardResponse,
  AnalyticsWalletResponse,
} from "@pools/core";

test("public proxy permits bounded product reads and rejects arbitrary upstream paths", () => {
  assert.equal(
    productRequest(
      ["explore"],
      new URLSearchParams("sort=volume&limit=25&offset=0"),
    ).endpoint,
    "explore",
  );
  for (const [path, q] of [
    [["..", "ready"], ""],
    [["explore"], "limit=101"],
    [["explore"], "offset=-1"],
    [["explore"], "q=a&q=b"],
    [["explore"], "origin=https://example.com"],
    [["explore"], "ids=0x123"],
    [["wallets", "0x123"], ""],
    [["search"], `q=${"x".repeat(101)}`],
  ] as [string[], string][])
    assert.throws(() => productRequest(path, new URLSearchParams(q)));
});

test("preloaded catalog preserves unprocessed launches and global sorting before pagination", async () => {
  const all = (await preloadedProduct(
    "explore",
    new URLSearchParams("limit=100&sort=launch"),
  )) as AnalyticsExploreResponse;
  assert.ok(all.coverage.catalogPools > 8);
  assert.ok(all.items.some((p) => !p.processed));
  const first = (await preloadedProduct(
    "explore",
    new URLSearchParams("limit=1&sort=volume"),
  )) as AnalyticsExploreResponse;
  const second = (await preloadedProduct(
    "explore",
    new URLSearchParams("limit=1&offset=1&sort=volume"),
  )) as AnalyticsExploreResponse;
  assert.equal(first.total, all.total);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.ok(
    BigInt(first.items[0].stats.volumeWei!) >=
      BigInt(second.items[0].stats.volumeWei!),
  );
});

test("preloaded leaderboard and wallet share one supported-position calculation", async () => {
  const board = (await preloadedProduct(
    "leaderboard",
    new URLSearchParams("window=All&minTrades=1"),
  )) as AnalyticsLeaderboardResponse;
  assert.ok(board.items.length);
  for (const row of board.items.slice(0, 5)) {
    const profile = (await preloadedProduct(
      `wallets/${row.address}`,
      new URLSearchParams("window=All"),
    )) as AnalyticsWalletResponse;
    assert.equal(profile.wallet.realizedWei, row.realizedWei);
    assert.equal(profile.wallet.unrealizedWei, row.unrealizedWei);
    assert.equal(
      profile.wallet.supportedPositionCount,
      row.supportedPositionCount,
    );
    assert.equal(profile.curve.at(-1)?.wei ?? "0", row.realizedWei);
  }
});

test("index outage retains a labeled preload and never leaks provider details", async (t) => {
  const old = process.env.INDEXER_API_URL,
    offline = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (old === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = old;
    if (offline === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = offline;
  });
  let called = "";
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    called = String(input);
    throw Error("secret-provider-debug");
  });
  const result = await readProduct<AnalyticsExploreResponse>(
    ["explore"],
    new URLSearchParams("limit=25"),
  );
  assert.equal(called, "https://index.example/v1/explore?limit=25");
  assert.equal(result.delivery.source, "preloaded");
  assert.ok(result.items.length);
  assert.ok(!JSON.stringify(result).includes("secret-provider-debug"));
});

test("proxy supports backend windows and uses matching bounds and fallback defaults", async () => {
  assert.equal(
    productRequest(
      ["leaderboard"],
      new URLSearchParams("window=6h&minTrades=0&offset=0001"),
    ).params.toString(),
    "window=6h&minTrades=0&offset=1",
  );
  assert.equal(
    productRequest(
      ["pools", `0x${"a".repeat(64)}`],
      new URLSearchParams("window=6h"),
    ).params.get("window"),
    "6h",
  );
  for (const q of ["minTrades=1000", "offset=1000000"])
    assert.throws(() =>
      productRequest(["leaderboard"], new URLSearchParams(q)),
    );
  assert.equal(
    (
      (await preloadedProduct(
        "explore",
        new URLSearchParams(),
      )) as AnalyticsExploreResponse
    ).window,
    "24h",
  );
  assert.equal(
    (
      (await preloadedProduct(
        "leaderboard",
        new URLSearchParams(),
      )) as AnalyticsLeaderboardResponse
    ).window,
    "All",
  );
});

test("a stale upstream window cannot masquerade as the newly selected window", async (t) => {
  const prior = process.env.INDEXER_API_URL,
    disabled = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (prior === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = prior;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  const stale = await preloadedProduct(
    "leaderboard",
    new URLSearchParams("window=All"),
  );
  t.mock.method(globalThis, "fetch", async () => Response.json(stale));
  const result = await readProduct<AnalyticsLeaderboardResponse>(
    ["leaderboard"],
    new URLSearchParams("window=7d"),
  );
  assert.equal(result.window, "7d");
  assert.equal(result.delivery.source, "preloaded");
});

test("share card timestamps use the wallet's own capture range and preserve unknown cutoff", () => {
  assert.equal(
    walletCaptureLabel({ asOf: 2000, oldestAsOf: 1000 }),
    "Wallet captures 1970-01-01 00:16:40 to 1970-01-01 00:33:20 UTC",
  );
  assert.equal(
    walletCaptureLabel({ asOf: 1000, oldestAsOf: 1000 }),
    "Wallet captured 1970-01-01 00:16:40 UTC",
  );
  assert.equal(
    walletCaptureLabel({ asOf: null, oldestAsOf: null }),
    "Wallet cutoff unavailable",
  );
});

test("an explicitly scoped share card cannot silently switch to global wallet PnL", async (t) => {
  const previous = process.env.CHAIN_REFRESH_DISABLED;
  process.env.CHAIN_REFRESH_DISABLED = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = previous;
  });
  const board = (await preloadedProduct(
    "leaderboard",
    new URLSearchParams("minTrades=1"),
  )) as AnalyticsLeaderboardResponse;
  const wallet = (await preloadedProduct(
    `wallets/${board.items[0].address}`,
    new URLSearchParams("window=All"),
  )) as AnalyticsWalletResponse;
  const position = wallet.positions.find((p) => p.supported)!;
  const card = await readCardWallet(
    wallet.wallet.address,
    "All",
    position.poolId,
    position.launchTx,
  );
  assert.equal(card.global, false);
  assert.equal(card.result.positions.length, 1);
  assert.equal(card.result.wallet.realizedWei, position.realizedWei);
  assert.equal(card.result.wallet.asOf, position.asOf);
  await assert.rejects(
    readCardWallet(
      wallet.wallet.address,
      "All",
      position.poolId,
      `0x${"f".repeat(64)}`,
    ),
    /capture unavailable/,
  );
});

test("following proxy bounds and canonicalizes explicit wallet selections", () => {
  const a = `0x${"a".repeat(40)}`;
  assert.equal(
    productRequest(
      ["following"],
      new URLSearchParams({
        wallets: a.toUpperCase().replace("0X", "0x"),
        limit: "50",
      }),
    ).params.get("wallets"),
    a,
  );
  for (const query of [
    "wallets=bad",
    `wallets=${a},${a}`,
    `wallets=${a}&wallets=${a}`,
    "limit=51",
    "limit=0",
    "window=All",
  ]) {
    assert.throws(() =>
      productRequest(["following"], new URLSearchParams(query)),
    );
  }
});

test("following activity fails closed during outage instead of inventing an empty preload", async (t) => {
  const old = process.env.INDEXER_API_URL;
  const disabled = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (old === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = old;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 503 }),
  );
  await assert.rejects(
    readProduct(
      ["following"],
      new URLSearchParams({ wallets: `0x${"1".repeat(40)}` }),
    ),
    /Following|following/,
  );
});

test("following proxy rejects another wallet's activity and unsupported attribution", async () => {
  const { validateFollowingResponse } = await import("./following-response");
  const a = `0x${"1".repeat(40)}`,
    b = `0x${"2".repeat(40)}`,
    h = `0x${"3".repeat(64)}`;
  const params = new URLSearchParams({ wallets: a });
  const response = {
    scope: "saved_verified_positions",
    notice: "Partial",
    hasMore: false,
    coverage: {
      requestedWallets: 1,
      returnedPools: 1,
      asOf: 200,
      oldestAsOf: 200,
      generatedAt: "2026-09-15T00:00:00Z",
      complete: false,
      registryExhaustive: false,
    },
    items: [
      {
        id: `${h}:1`,
        wallet: a,
        poolId: h,
        token: b,
        symbol: "TOKEN",
        decimals: 18,
        txHash: h,
        logIndex: 1,
        block: 100,
        timestamp: 100,
        side: "buy",
        ethWei: "9007199254740993",
        tokenRaw: "1000000000000000000",
        priceWei: "9007199254740993",
        asOf: 200,
        throughBlock: 200,
        supported: true,
      },
    ],
  };
  assert.doesNotThrow(() => validateFollowingResponse(response, params));
  for (const patch of [
    { wallet: b },
    { supported: false },
    { ethWei: 9007199254740993 },
    { side: "transfer" },
    { timestamp: 201 },
    { token: "javascript:alert(1)" },
  ]) {
    assert.throws(() =>
      validateFollowingResponse(
        { ...response, items: [{ ...response.items[0], ...patch }] },
        params,
      ),
    );
  }
  assert.throws(() =>
    validateFollowingResponse(
      { ...response, items: [response.items[0], response.items[0]] },
      params,
    ),
  );
});

test("trade share routes require an exact event and explicit proven wallet", () => {
  const h = `0x${"a".repeat(64)}`;
  const a = `0x${"b".repeat(40)}`;
  const path = ["trades", h, h, "2147483647"];
  assert.equal(
    productRequest(
      path,
      new URLSearchParams({ wallet: a.toUpperCase().replace("0X", "0x") }),
    ).params.get("wallet"),
    a,
  );
  for (const index of ["-1", "01", "1.0", "2147483648", "9007199254740993"])
    assert.throws(() =>
      productRequest(
        ["trades", h, h, index],
        new URLSearchParams({ wallet: a }),
      ),
    );
  for (const q of [
    "",
    "wallet=bad",
    `wallet=${a}&wallet=${a}`,
    `wallet=${a}&window=All`,
  ])
    assert.throws(() => productRequest(path, new URLSearchParams(q)));
});

test("trade share validation keeps exact proceeds minus basis and rejects misrouted evidence", async () => {
  const { validateTradeShareResponse } = await import("./trade-share-response");
  const h = `0x${"1".repeat(64)}`;
  const a = `0x${"2".repeat(40)}`;
  const params = new URLSearchParams({ wallet: a });
  const endpoint = `trades/${h}/${h}/1`;
  const response = {
    scope: "saved_verified_sale",
    coverage: { complete: false, registryExhaustive: false },
    trade: {
      wallet: a,
      poolId: h,
      token: a,
      symbol: "TOKEN",
      decimals: 18,
      txHash: h,
      logIndex: 1,
      block: 100,
      timestamp: 100,
      asOf: 200,
      throughBlock: 200,
      supported: true,
      side: "sell",
      ethWei: "9007199254740993",
      tokenRaw: "1000000000000000000",
      disposedCostWei: "9007199254740994",
      realizedWei: "-1",
    },
  };
  assert.doesNotThrow(() =>
    validateTradeShareResponse(response, endpoint, params),
  );
  for (const patch of [
    { realizedWei: "0" },
    { disposedCostWei: "-1" },
    { ethWei: 9007199254740993 },
    { wallet: `0x${"3".repeat(40)}` },
    { logIndex: 2 },
    { poolId: `0x${"4".repeat(64)}` },
    { txHash: `0x${"5".repeat(64)}` },
    { supported: false },
    { timestamp: 201 },
    { block: 201 },
    { decimals: 37 },
    { ethWei: "1e18" },
    { tokenRaw: "0" },
  ])
    assert.throws(() =>
      validateTradeShareResponse(
        { ...response, trade: { ...response.trade, ...patch } },
        endpoint,
        params,
      ),
    );
});

test("trade sharing never revives a preloaded PnL when saved evidence disappears or is invalid", async (t) => {
  const prior = process.env.INDEXER_API_URL;
  const disabled = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (prior === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = prior;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  const h = `0x${"1".repeat(64)}`;
  const a = `0x${"2".repeat(40)}`;
  const params = new URLSearchParams({ wallet: a });
  const path = ["trades", h, h, "1"];
  const response = {
    scope: "saved_verified_sale",
    coverage: { complete: false, registryExhaustive: false },
    trade: {
      wallet: a,
      poolId: h,
      token: a,
      symbol: "TOKEN",
      decimals: 18,
      txHash: h,
      logIndex: 1,
      block: 100,
      timestamp: 100,
      asOf: 200,
      throughBlock: 200,
      supported: true,
      side: "sell",
      ethWei: "9007199254740993",
      tokenRaw: "1000000000000000000",
      disposedCostWei: "9007199254740994",
      realizedWei: "-1",
    },
  };
  let next = () => Response.json(response);
  t.mock.method(globalThis, "fetch", async () => next());
  const saved = await readProduct<typeof response>(path, params);
  assert.equal(saved.delivery.source, "indexer");
  assert.equal(saved.trade.realizedWei, "-1");
  for (const status of [404, 503]) {
    next = () => new Response(null, { status });
    await assert.rejects(
      readProduct(path, params),
      /verified sale is unavailable/,
    );
  }
  next = () =>
    Response.json({
      ...response,
      trade: { ...response.trade, realizedWei: "1" },
    });
  await assert.rejects(
    readProduct(path, params),
    /verified sale is unavailable/,
  );
  process.env.CHAIN_REFRESH_DISABLED = "1";
  await assert.rejects(
    readProduct(path, params),
    /verified sale is unavailable/,
  );
});
