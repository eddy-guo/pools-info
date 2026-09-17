import test from "node:test";
import assert from "node:assert/strict";
import { productRequest } from "./product-request";
import { preloadedProduct, readProduct } from "./product-server";
import {
  cardCurve,
  cardHero,
  cardStats,
  cardTopPosition,
  readCardWallet,
} from "./product-card";
import { cardQuery, cardUrl, parseCardOptions } from "./card-options";
import { validatePoolResponse } from "./pool-response";
import type {
  AnalyticsExploreResponse,
  AnalyticsLeaderboardResponse,
  AnalyticsWalletResponse,
  CreatorsResponse,
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
  assert.equal(
    first.total,
    all.items.filter((pool) => pool.stats.volumeWei !== null).length,
  );
  assert.ok(first.total < all.total);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.ok(
    BigInt(first.items[0].stats.volumeWei!) >=
      BigInt(second.items[0].stats.volumeWei!),
  );
});

test("creators proxy scopes sort to the read API's own keys and preload groups by sender", async () => {
  assert.equal(
    productRequest(
      ["creators"],
      new URLSearchParams(
        "window=All&sort=median&direction=asc&limit=10&offset=0",
      ),
    ).endpoint,
    "creators",
  );
  for (const q of ["sort=launch", "sort=volume&sort=median", "metric=realized"])
    assert.throws(() => productRequest(["creators"], new URLSearchParams(q)));
  const launches = (await preloadedProduct(
    "creators",
    new URLSearchParams("limit=1000"),
  )) as CreatorsResponse;
  assert.equal(launches.window, "All");
  assert.ok(launches.items.length > 0);
  for (let i = 1; i < launches.items.length; i++)
    assert.ok(launches.items[i].launches <= launches.items[i - 1].launches);
  const volume = (await preloadedProduct(
    "creators",
    new URLSearchParams("sort=volume&limit=1000"),
  )) as CreatorsResponse;
  assert.ok(volume.items.every((r) => r.measured > 0 && r.volumeWei !== null));
  assert.ok(volume.total <= launches.total);
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
    "7d",
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

test("share card options round-trip through the query the modal and the route share", () => {
  assert.deepEqual(parseCardOptions(new URLSearchParams("")), {
    window: "All",
    preset: "pink",
    anonymous: false,
    notional: false,
  });
  const chosen = {
    window: "7d" as const,
    preset: "mint" as const,
    anonymous: true,
    notional: true,
  };
  assert.deepEqual(parseCardOptions(cardQuery(chosen)), chosen);
  assert.equal(
    cardUrl(`0x${"A".repeat(40)}`, { ...chosen, anonymous: false }),
    `/cards/0x${"a".repeat(40)}.png?window=7d&theme=mint&notional=1`,
  );
  // A stale or hand-edited link still renders with the defaults.
  assert.deepEqual(
    parseCardOptions(new URLSearchParams("window=2y&theme=neon&anon=yes")),
    parseCardOptions(new URLSearchParams("")),
  );
});

test("share card figures are signed, amount-free without notional and never placeholders", () => {
  const wallet = {
    address: `0x${"1".repeat(40)}`,
    rank: 12,
    realizedWei: "-23357282114254574",
    unrealizedWei: null,
    netWei: null,
    volumeWei: "514442717885745426",
    roi: -16.042,
    wins: 3,
    losses: 5,
    winRate: 37.5,
    tradeCount: 85,
    supportedTradeCount: 85,
    supportedPositionCount: 14,
    excludedPositionCount: 0,
    bestWei: "11471084300772102",
    avgHold: null,
    last: null,
    asOf: null,
    oldestAsOf: null,
    completeWindow: true,
  };
  assert.deepEqual(cardHero(wallet), { value: "-16.04%", tone: "down" });
  assert.deepEqual(cardHero({ ...wallet, roi: 0.004 }), {
    value: "0.00%",
    tone: "text",
  });
  assert.deepEqual(cardHero({ ...wallet, roi: null }), {
    value: "-0.02336 ETH",
    tone: "down",
  });
  assert.equal(cardHero({ ...wallet, roi: null, realizedWei: null }), null);
  assert.deepEqual(
    cardStats(wallet, false).map((s) => [s.label, s.value]),
    [
      ["Win rate", "37.5%"],
      ["Record", "3W · 5L"],
      ["Trades", "85"],
    ],
  );
  assert.deepEqual(
    cardStats(wallet, true).map((s) => [s.label, s.value]),
    [
      ["Volume", "0.5144 ETH"],
      ["Win rate", "37.5%"],
      ["Trades", "85"],
    ],
  );
  // No closed cycle: the win rate slot is dropped, not dashed.
  assert.deepEqual(
    cardStats({ ...wallet, winRate: null, wins: 0, losses: 0 }, false).map(
      (s) => s.label,
    ),
    ["Record", "Trades", "Positions"],
  );
});

test("share card chart follows the wallet's own curve and names its top position", () => {
  const curve = cardCurve(
    [
      { time: 100, wei: "0" },
      { time: 150, wei: "2000000000000000000" },
      { time: 300, wei: "-1000000000000000000" },
    ],
    300,
    100,
  )!;
  assert.deepEqual(
    curve.points.map(([x, y]) => [Math.round(x), Math.round(y)]),
    [
      [0, 67],
      [75, 0],
      [300, 100],
    ],
  );
  assert.equal(Math.round(curve.zeroY!), 67);
  assert.equal(cardCurve([{ time: 100, wei: "5" }], 300, 100), null);
  const flat = cardCurve(
    [
      { time: 0, wei: "7" },
      { time: 10, wei: "7" },
    ],
    100,
    50,
  )!;
  assert.deepEqual(
    flat.points.map(([, y]) => y),
    [25, 25],
  );
  const position = (
    symbol: string,
    realizedWei: string | null,
    volumeWei: string,
  ) =>
    ({ symbol, realizedWei, volumeWei }) as Parameters<
      typeof cardTopPosition
    >[0][number];
  assert.equal(
    cardTopPosition([
      position("A", "5", "1"),
      position("B", "9", "1"),
      position("C", null, "99"),
      position("D", "9", "2"),
    ])?.symbol,
    "D",
  );
  assert.equal(cardTopPosition([]), null);
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
  assert.equal(card.poolSymbol, position.symbol);
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

const stackBtc =
  "0xe38aea5b2ba31e5a4d641f43a0b6a42ae3f20c19d7a9ceb533bc01ec8272c0f6";
const stackToken = "0x163da2c74cc56d8c71671f7374b0522d9d16006c";
const monkiiLabs =
  "0x2b92729e11429b6452872cca4d1cdc26568274b716093f1ae2e3e10b88844e5c";
/** The live read API's pool response, trimmed to one observation and candle. */
const savedPool = () => ({
  coverage: { chainId: 4663, source: "indexed_chain_events" },
  generatedAt: "2026-09-16T05:03:18.562Z",
  pool: {
    poolId: stackBtc,
    token: stackToken,
    name: "Stack Btc 7",
    symbol: "STACK",
    imageUrl: "ipfs://QmVjvbtLH6vDUTYrNzSLciuLL7JLL3QBZrfQ78V4JQMy55",
    // Block heights and times arrive as decimal strings, not numbers.
    launch: {
      block: "63742277",
      transactionHash:
        "0xcc811c4fd51971d02697adfd748a6c47d076aad897c70354dc7ea15f19fa17f0",
      transactionInitiator: "0xacb0be2f174851314f373367e4b9956c4a834b15",
      timestamp: "1789483971",
      sourceStream: "discovery:v2",
      discoverySource: "historical_discovery",
      sourceBatchThroughBlock: "63742337",
    } as Record<string, unknown>,
    coverage: { startBlock: "63742277", throughBlock: "63744999" },
  },
  market: {
    poolId: stackBtc,
    token: stackToken,
    decimals: 18,
    priceWei: "2708629098",
    window: "24h",
    volumeWei: "89175448391573819392",
    trades: 1711,
    change: null,
    observations: [
      {
        id: "0x3801b5d22f8fbb93f691e3850943e1aa611c977c10b85c8c679662b6677bb5c4:73",
        side: "sell",
        block: 63744981,
        ethWei: "499639903581326",
        logIndex: 73,
        tokenRaw: "184889703373714560783913",
        blockHash:
          "0xb5874bfb2158b38a7c41a8174deed4bed35eabe5466b0734d2b2cc7833053052",
        timestamp: 1789484251,
        transactionHash:
          "0x3801b5d22f8fbb93f691e3850943e1aa611c977c10b85c8c679662b6677bb5c4",
      },
    ],
    coverage: {
      startBlock: 63742277,
      cutoff: {
        block: 63744999,
        hash: "0xe0e8403a34fbcbb785fbb0ebbe0b2f135845171a170bc24499b8c30c8342cb66",
        asOf: 1789484253,
      },
      indexedAt: "2026-09-15T23:14:29.785Z",
      completeWindow: true,
      windowStart: 1789397853,
      priceBaseline: null,
      unitBasis: {
        block: 63743999,
        hash: "0xd069a593e0c6baea949d6c9e2f4bc3f506ff4788ae4fa58d634a8b797068c50f",
        asOf: 1789484149,
        decimals: 18,
        source: "verified_deep_snapshot",
      },
      unitsConflict: false,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 60,
      fromTimestamp: 1789483920,
      truncated: false,
      candles: [
        {
          low: "2628552789",
          high: "2715678394",
          open: "2628552789",
          time: 1789483920,
          close: "2715678394",
          volume: "102306162628590046",
        },
      ],
    },
  },
  analytics: null,
});

test("a saved pool launch is read from either number or decimal-string heights", async (t) => {
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
  const path = ["pools", stackBtc];
  let response = savedPool();
  t.mock.method(globalThis, "fetch", async () => Response.json(response));
  const saved = await readProduct<ReturnType<typeof savedPool>>(
    path,
    new URLSearchParams(),
  );
  assert.equal(saved.delivery.source, "indexer");
  assert.equal(saved.pool.name, "Stack Btc 7");
  assert.deepEqual(saved.pool.launch, {
    ...savedPool().pool.launch,
    block: 63742277,
    timestamp: 1789483971,
    sourceBatchThroughBlock: 63742337,
  });
  // apps/api asserts its own JSON types on the raw body after calling the
  // validator, so validating must not quietly repair a string regression.
  const raw = savedPool();
  validatePoolResponse(raw, stackBtc, "24h");
  assert.deepEqual(raw.pool.launch, savedPool().pool.launch);
  // A pool outside the preload has no fallback, so rejection is the 404 page.
  for (const bad of ["63742277x", "6.5e7", " 63742277", "-1", "", 1.5, null])
    for (const field of ["block", "timestamp", "sourceBatchThroughBlock"]) {
      // An unrecorded source batch is absent data, not a malformed value.
      if (bad === null && field === "sourceBatchThroughBlock") continue;
      response = savedPool();
      response.pool.launch[field] = bad;
      await assert.rejects(
        readProduct(path, new URLSearchParams()),
        /outside available saved coverage/i,
      );
    }
  response = savedPool();
  delete response.pool.launch.sourceBatchThroughBlock;
  assert.equal(
    (
      await readProduct<ReturnType<typeof savedPool>>(
        path,
        new URLSearchParams(),
      )
    ).delivery.source,
    "indexer",
  );
});

test("a preloaded pool still resolves while the saved index is unavailable", async (t) => {
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
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("index offline");
  });
  const preloaded = await readProduct<{ name: string }>(
    ["pools", monkiiLabs],
    new URLSearchParams(),
  );
  assert.equal(preloaded.delivery.source, "preloaded");
  assert.equal(preloaded.name, "MonkiiLabs");
});

const historyWallet = `0x${"a".repeat(40)}`;
const historyPath = ["wallets", historyWallet, "history"];
function historyPage(overrides: Record<string, unknown> = {}) {
  return {
    source: "blockscout",
    chainId: 4663,
    wallet: historyWallet,
    kind: "transactions",
    items: [
      {
        hash: `0x${"1".repeat(64)}`,
        block: 63744405,
        timestamp: 1789484191,
        from: historyWallet,
        to: `0x${"b".repeat(40)}`,
        method: "execute",
        status: "ok",
        value: "16300000000000000",
        fee: "7625152352000",
      },
    ],
    nextCursor: "eyJ2IjoxfQ",
    fetchedAt: "2026-09-16T06:47:13.746Z",
    stale: false,
    note: "Explorer history for display only; not accounting or PnL evidence.",
    ...overrides,
  };
}
function withIndexer(t: import("node:test").TestContext, base?: string) {
  const old = process.env.INDEXER_API_URL,
    offline = process.env.CHAIN_REFRESH_DISABLED;
  if (base) process.env.INDEXER_API_URL = base;
  else delete process.env.INDEXER_API_URL;
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (old === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = old;
    if (offline === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = offline;
  });
}

test("explorer history proxy admits one bounded kind and an opaque cursor", () => {
  const checked = productRequest(
    historyPath,
    new URLSearchParams("kind=token-transfers&cursor=eyJ2IjoxfQ"),
  );
  assert.equal(checked.endpoint, `wallets/${historyWallet}/history`);
  assert.equal(
    checked.params.toString(),
    "kind=token-transfers&cursor=eyJ2IjoxfQ",
  );
  for (const q of [
    "",
    "kind=swaps",
    "kind=transactions&window=All",
    "kind=transactions&kind=token-transfers",
    "kind=transactions&cursor=../../v1/leaderboard",
    `kind=transactions&cursor=${"a".repeat(4097)}`,
  ])
    assert.throws(() => productRequest(historyPath, new URLSearchParams(q)));
  assert.throws(() =>
    productRequest(
      [...historyPath, "extra"],
      new URLSearchParams("kind=transactions"),
    ),
  );
});

test("explorer history keeps the read API's outage contract and never falls back", async (t) => {
  const { readWalletHistory, WalletHistoryUnavailableError } =
    await import("./product-server");
  const params = new URLSearchParams("kind=transactions");
  withIndexer(t);
  await assert.rejects(readWalletHistory(historyPath, params), (error) => {
    assert.ok(error instanceof WalletHistoryUnavailableError);
    assert.equal(error.reason, "not_configured");
    return true;
  });
  // A saved read of the same path must not invent an empty wallet profile.
  await assert.rejects(readProduct(historyPath, params), /Explorer history/);
  withIndexer(t, "https://index.example");
  let requested = "";
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    requested = String(input);
    return Response.json(
      { error: "wallet_history_unavailable", reason: "budget_exhausted" },
      { status: 503, headers: { "Retry-After": "120" } },
    );
  });
  await assert.rejects(
    readWalletHistory(historyPath, new URLSearchParams("kind=transactions")),
    (error) => {
      assert.ok(error instanceof WalletHistoryUnavailableError);
      assert.equal(error.reason, "budget_exhausted");
      assert.equal(error.retryAfter, 120);
      return true;
    },
  );
  assert.equal(
    requested,
    `https://index.example/v1/wallets/${historyWallet}/history?kind=transactions`,
  );
});

test("explorer history rejects another wallet's page and unshowable rows", async (t) => {
  const { readWalletHistory } = await import("./product-server");
  const { validateWalletHistoryResponse } =
    await import("./wallet-history-response");
  const valid = historyPage();
  assert.doesNotThrow(() =>
    validateWalletHistoryResponse(valid, historyWallet, "transactions"),
  );
  for (const bad of [
    historyPage({ wallet: `0x${"c".repeat(40)}` }),
    historyPage({ kind: "token-transfers" }),
    historyPage({ chainId: 1 }),
    historyPage({ nextCursor: "https://evil.example/page" }),
    historyPage({ items: Array.from({ length: 51 }, () => valid.items[0]) }),
    historyPage({ items: [{ ...valid.items[0], value: "16.3" }] }),
    historyPage({ items: [{ ...valid.items[0], status: "reverted" }] }),
    historyPage({ items: [{ ...valid.items[0], from: "not-an-address" }] }),
    // Newest first: a later row may not climb back up the chain.
    historyPage({
      items: [
        valid.items[0],
        { ...valid.items[0], hash: `0x${"2".repeat(64)}`, block: 63744406 },
      ],
    }),
  ])
    assert.throws(() =>
      validateWalletHistoryResponse(bad, historyWallet, "transactions"),
    );
  assert.throws(() =>
    validateWalletHistoryResponse(
      {
        ...historyPage({ kind: "token-transfers" }),
        items: [
          {
            transactionHash: `0x${"1".repeat(64)}`,
            logIndex: 10,
            block: 63744405,
            timestamp: 1789484191,
            from: historyWallet,
            to: `0x${"b".repeat(40)}`,
            token: {
              address: `0x${"d".repeat(40)}`,
              symbol: "STACK",
              name: "Stack",
              decimals: 18,
              type: "ERC-20",
            },
            // Neither an amount nor a token id leaves nothing true to show.
            value: null,
            tokenId: null,
            method: null,
          },
        ],
      },
      historyWallet,
      "token-transfers",
    ),
  );
  withIndexer(t, "https://index.example");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(historyPage({ wallet: `0x${"c".repeat(40)}` })),
  );
  await assert.rejects(
    readWalletHistory(historyPath, new URLSearchParams("kind=transactions")),
    (error: Error & { reason?: string }) => {
      assert.equal(error.reason, "upstream_unavailable");
      return true;
    },
  );
});

test("explorer history display strings accept null and up to 256 characters, and reject empty or longer", async () => {
  const { validateWalletHistoryResponse } = await import(
    "./wallet-history-response"
  );
  const valid = historyPage();
  const withMethod = (method: string | null) =>
    historyPage({ items: [{ ...valid.items[0], method }] });
  assert.doesNotThrow(() =>
    validateWalletHistoryResponse(
      withMethod(null),
      historyWallet,
      "transactions",
    ),
  );
  assert.doesNotThrow(() =>
    validateWalletHistoryResponse(
      withMethod("x".repeat(256)),
      historyWallet,
      "transactions",
    ),
  );
  assert.throws(() =>
    validateWalletHistoryResponse(
      withMethod(""),
      historyWallet,
      "transactions",
    ),
  );
  assert.throws(() =>
    validateWalletHistoryResponse(
      withMethod("x".repeat(257)),
      historyWallet,
      "transactions",
    ),
  );
});
