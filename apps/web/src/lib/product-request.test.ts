import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productRequest } from "./product-request";
import {
  InvalidHistoryCursorError,
  ProductUnavailableError,
  preloadedProduct,
  productUnavailableResponse,
  readProduct,
  readScreenerStats,
  readWalletPosition,
  readWalletTradeHistory,
  servedEthRateLifetimeMs,
} from "./product-server";
import {
  cardCurve,
  cardEth,
  cardEthFigure,
  cardExportHero,
  cardExportHeroSize,
  cardExportTrio,
  cardHero,
  cardInitials,
  cardStats,
  cardSymbol,
  cardTopPosition,
  cardTradeCount,
  cardEthText,
  cardLineSize,
  cardMoney,
  cardMoneyText,
  cardReadLifetimeMs,
  cardUsdPerEth,
  type CardEth,
  positionCardChart,
  positionCardFigures,
  readCardPosition,
  type PositionCardSource,
} from "./product-card";
import { cardQuery, cardUrl, parseCardOptions } from "./card-options";
import { fontAdvances, fontCodePoints } from "./font-coverage";
import { usdPrice } from "./usd-price";
import { validatePoolResponse } from "./pool-response";
import { validateCreatorsResponse } from "./creators-response";
import { validateStatsResponse } from "./stats-response";
import {
  validateExploreResponse,
  validateWalletLaunches,
} from "./explore-response";
import {
  displayEth,
  ethFigure,
  figureText,
  formatMoney,
  formatTokenAmount,
  subscript,
  type AnalyticsExploreResponse,
  type AnalyticsLeaderboardResponse,
  type AnalyticsWalletPosition,
  type AnalyticsWalletResponse,
  type AnalyticsWalletSummary,
  type CreatorsResponse,
} from "@pools/core";

/** The coverage of the face the card draws a token symbol in, as the route reads it. */
const geistPoints = fontCodePoints(
  readFileSync(
    new URL("../../public/fonts/Geist-SemiBold.ttf", import.meta.url),
  ),
);
const geist = (codePoint: number) => geistPoints.has(codePoint);

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

test("an index outage is reported, never answered from the committed dataset", async (t) => {
  const old = process.env.INDEXER_API_URL,
    offline = process.env.CHAIN_REFRESH_DISABLED,
    fixtures = process.env.PRODUCT_FIXTURES;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  /* Even a deployment that does name the fixtures must not have them
     substituted for a read API it was configured with and could not reach. */
  process.env.PRODUCT_FIXTURES = "1";
  t.after(() => {
    if (old === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = old;
    if (offline === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = offline;
    if (fixtures === undefined) delete process.env.PRODUCT_FIXTURES;
    else process.env.PRODUCT_FIXTURES = fixtures;
  });
  let called = "";
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    called = String(input);
    throw Error("secret-provider-debug");
  });
  await assert.rejects(
    readProduct<AnalyticsExploreResponse>(
      ["explore"],
      new URLSearchParams("limit=25"),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProductUnavailableError);
      assert.ok(!String((error as Error).message).includes("secret-provider"));
      return true;
    },
  );
  assert.equal(called, "https://index.example/v1/explore?limit=25");
  // The dataset the outage used to be answered from is still there, and still
  // the fixture the browser suites read; it simply never stands in for a read.
  const fixture = (await preloadedProduct(
    "explore",
    new URLSearchParams("limit=25"),
  )) as AnalyticsExploreResponse;
  assert.ok(fixture.items.length);
});

test("a deployment with no read API serves the committed dataset only when it names it", async (t) => {
  const old = process.env.INDEXER_API_URL,
    offline = process.env.CHAIN_REFRESH_DISABLED,
    fixtures = process.env.PRODUCT_FIXTURES;
  delete process.env.INDEXER_API_URL;
  delete process.env.CHAIN_REFRESH_DISABLED;
  delete process.env.PRODUCT_FIXTURES;
  t.after(() => {
    if (old === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = old;
    if (offline === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = offline;
    if (fixtures === undefined) delete process.env.PRODUCT_FIXTURES;
    else process.env.PRODUCT_FIXTURES = fixtures;
  });
  await assert.rejects(
    readProduct(["explore"], new URLSearchParams("limit=25")),
    (error: unknown) => error instanceof ProductUnavailableError,
  );
  process.env.PRODUCT_FIXTURES = "1";
  const served = await readProduct<AnalyticsExploreResponse>(
    ["explore"],
    new URLSearchParams("limit=25"),
  );
  assert.equal(served.delivery.source, "preloaded");
  assert.ok(served.items.length);
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
  await assert.rejects(
    readProduct<AnalyticsLeaderboardResponse>(
      ["leaderboard"],
      new URLSearchParams("window=7d"),
    ),
    (error: unknown) => error instanceof ProductUnavailableError,
  );
});

test("leaderboard proxy accepts the API default and forwards a selected window", async (t) => {
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
  const forwarded: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    const url = new URL(String(input));
    forwarded.push(url.toString());
    return Response.json(
      await preloadedProduct("leaderboard", url.searchParams),
    );
  });

  const defaultBoard = await readProduct<AnalyticsLeaderboardResponse>(
    ["leaderboard"],
    new URLSearchParams(),
  );
  assert.equal(defaultBoard.window, "7d");
  const selectedBoard = await readProduct<AnalyticsLeaderboardResponse>(
    ["leaderboard"],
    new URLSearchParams("window=All"),
  );
  assert.equal(selectedBoard.window, "All");
  assert.deepEqual(forwarded, [
    "https://index.example/v1/leaderboard",
    "https://index.example/v1/leaderboard?window=All",
  ]);
});

/**
 * The three positions the 29 Sep 2026 audit drew its mockups from, as the
 * production wallet read served them (ledger cut 1790695358, 15:22:38Z):
 * HOOKR open on the rank-1 wallet, BCTC closed at a gain on the rank-50 one
 * and POTATCHI closed at a loss on an unranked one.
 */
const auditedRow = (
  row: Omit<
    AnalyticsWalletPosition,
    | "asOf"
    | "throughBlock"
    | "supported"
    | "flags"
    | "decimals"
    | "netWei"
    | "volumeWei"
    | "position"
  > & {
    position: Omit<
      NonNullable<AnalyticsWalletPosition["position"]>,
      "poolId" | "realizedWei" | "flags" | "realizations"
    >;
  },
): AnalyticsWalletPosition => ({
  ...row,
  decimals: 18,
  asOf: 1790695358,
  // Not recorded by the audit, and never read by the card.
  throughBlock: 0,
  supported: true,
  flags: [],
  netWei: (
    BigInt(row.position.proceedsWei) - BigInt(row.position.investedWei)
  ).toString(),
  volumeWei: (
    BigInt(row.position.proceedsWei) + BigInt(row.position.investedWei)
  ).toString(),
  position: {
    ...row.position,
    poolId: row.poolId as `0x${string}`,
    realizedWei: row.realizedWei,
    flags: [],
    realizations: [],
  },
});
const audited = {
  HOOKR: auditedRow({
    poolId:
      "0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf",
    token: "0x18e674231a58c239dc7daedcffe15ec3a24cff5c",
    symbol: "HOOKR",
    launchTx:
      "0x53167870d0e235e0c1e1ced0ba2f32ed405a7a24335921b3c086e455cdc1ff95",
    realizedWei: "62476404844532343345",
    unrealizedWei: "36243833792632040664",
    position: {
      trader: "0x2f25b929f03fe2869e752f1910e5445f8b5778da",
      quantity: "8274943690407648622739002",
      costWei: "4046272975482997289",
      investedWei: "4455000000000000000",
      proceedsWei: "62885131869049346056",
      buys: 5,
      sells: 55,
      openedAt: 1785992576,
      firstHour: 1785992400,
      lastHour: 1789538400,
    },
  }),
  BCTC: auditedRow({
    poolId:
      "0xd25d59ecc06b6b6dd3aeff8d69ca9d6cdd1c3e8bd88bb4a2974bdb3ce75aee7b",
    token: "0x3df4bd4daf0a988ed3a876c51b048e176d2dbaaf",
    symbol: "BCTC",
    launchTx:
      "0xca4200e0614603824d37977ddea961ddd6a7ff3d307fbf64b55004c0e7b3de93",
    realizedWei: "11377738260148251460",
    unrealizedWei: "0",
    position: {
      trader: "0x5cef3188ab04bec8caace9818729c1c8f5553191",
      quantity: "0",
      costWei: "0",
      investedWei: "990000000000000000",
      proceedsWei: "12367738260148251460",
      buys: 1,
      sells: 4,
      openedAt: null,
      firstHour: 1788991200,
      lastHour: 1788994800,
    },
  }),
  POTATCHI: auditedRow({
    poolId:
      "0xfc7cd3b5dc34e54b1a2dce9041044555ea5c646a10a800e79bba71376ff5a936",
    token: "0xed954b9545ceee1b88b264546110f8c5d64cf7dd",
    symbol: "POTATCHI",
    launchTx:
      "0xc189d87e34f992ac2683003b1a9eb887c4337add7133a7ddf8e3bcde3b4307ee",
    realizedWei: "-678496036781504580",
    unrealizedWei: "0",
    position: {
      trader: "0x42c38dcff3bd710d28bcf0d96985f4005dc2dd36",
      quantity: "0",
      costWei: "0",
      investedWei: "814000000000000000",
      proceedsWei: "135503963218495420",
      buys: 21,
      sells: 1,
      openedAt: null,
      firstHour: 1790686800,
      lastHour: 1790690400,
    },
  }),
};
/** A position as the wallet page serves it, with no per-token price beside it. */
const fromWallet = (position: AnalyticsWalletPosition): PositionCardSource => ({
  position,
  mark: null,
  avgEntryPriceWei: null,
});
const text = (
  eth: { sign: "" | "+"; figure: ReturnType<typeof ethFigure> } | null,
) => eth && cardEthText(eth);

/** Every wallet the committed dataset's chain snapshot accounts for. */
const datasetWallets = () => [
  ...new Set(
    (
      JSON.parse(
        readFileSync(
          new URL("../../../../data/snapshots/chain.json", import.meta.url),
          "utf8",
        ),
      ) as {
        markets: { accounting?: { wallets: { address: string }[] } | null }[];
      }
    ).markets.flatMap((m) => m.accounting?.wallets.map((w) => w.address) ?? []),
  ),
];
const datasetPositions = () =>
  datasetWallets().flatMap((address) =>
    (
      preloadedProduct(
        `wallets/${address}`,
        new URLSearchParams("window=All"),
      ) as AnalyticsWalletResponse
    ).positions.map((row) => ({ address, row })),
  );

test("share card options round-trip through the query the modal and the route share", () => {
  assert.deepEqual(parseCardOptions(new URLSearchParams("")), {
    window: "All",
    preset: "lime",
    design: "liquid",
    anonymous: false,
    notional: false,
    unit: "ETH",
    usdPerEth: null,
  });
  const chosen = {
    window: "7d" as const,
    preset: "mint" as const,
    design: "liquid" as const,
    anonymous: true,
    notional: true,
    unit: "ETH" as const,
    usdPerEth: null,
  };
  assert.deepEqual(parseCardOptions(cardQuery(chosen)), chosen);
  assert.equal(
    cardUrl(`0x${"A".repeat(40)}`, { ...chosen, anonymous: false }),
    `/cards/0x${"a".repeat(40)}.png?window=7d&theme=mint&notional=1`,
  );
  // The non-default design still round-trips into the URL, and independently
  // of the preset: neither toggle depends on the other's default.
  assert.equal(
    cardUrl(`0x${"a".repeat(40)}`, {
      ...chosen,
      anonymous: false,
      notional: false,
      preset: "lime",
      design: "export",
    }),
    `/cards/0x${"a".repeat(40)}.png?window=7d&design=export`,
  );
  // The export design does not honour the notional option (its headline is
  // the realized amount already), so the option never reaches its URL and a
  // hand-written one reads as off: one image, not two identical ones.
  assert.deepEqual(
    parseCardOptions(cardQuery({ ...chosen, design: "export" })),
    {
      ...chosen,
      design: "export",
      notional: false,
    },
  );
  assert.equal(
    cardUrl(`0x${"a".repeat(40)}`, { ...chosen, design: "export" }),
    `/cards/0x${"a".repeat(40)}.png?window=7d&theme=mint&anon=1&design=export`,
  );
  assert.equal(
    parseCardOptions(new URLSearchParams("design=export&notional=1")).notional,
    false,
  );
  // The unit and the rate the page showed travel together, on both designs.
  const usd = { ...chosen, unit: "USD" as const, usdPerEth: 2706.735 };
  for (const design of ["liquid", "export"] as const)
    assert.deepEqual(parseCardOptions(cardQuery({ ...usd, design })), {
      ...usd,
      design,
      notional: design === "liquid",
    });
  assert.equal(
    cardQuery(usd).toString(),
    "window=7d&theme=mint&anon=1&notional=1&unit=usd&rate=2706.735",
  );
  // USD with no rate on hand stays USD on the URL: the route reads the rate
  // itself or falls back to ETH. A rate never stands alone.
  assert.deepEqual(parseCardOptions(cardQuery({ ...usd, usdPerEth: null })), {
    ...usd,
    usdPerEth: null,
  });
  for (const rate of ["0", "-1", "NaN", "Infinity", "abc", ""])
    assert.equal(
      parseCardOptions(new URLSearchParams(`unit=usd&rate=${rate}`)).usdPerEth,
      null,
      rate,
    );
  assert.deepEqual(
    parseCardOptions(new URLSearchParams("rate=2706.735")),
    parseCardOptions(new URLSearchParams("")),
  );
  // A stale or hand-edited link still renders with the defaults.
  assert.deepEqual(
    parseCardOptions(
      new URLSearchParams(
        "window=2y&theme=neon&anon=yes&design=bogus&unit=eur&rate=3000",
      ),
    ),
    parseCardOptions(new URLSearchParams("")),
  );
});

test("a position card's options round-trip, its amounts shown unless the URL hides them", () => {
  const scope = {
      pool: `0x${"b".repeat(64)}`,
      launch: `0x${"c".repeat(64)}`,
    },
    scoped = `pool=${scope.pool}&launch=${scope.launch}`,
    parsed = (query: string) =>
      parseCardOptions(new URLSearchParams(`${scoped}${query}`)),
    defaults = parseCardOptions(new URLSearchParams(scoped));
  // Every position link written before the option existed showed the
  // amounts, and still does.
  assert.equal(defaults.notional, true);
  assert.equal(cardQuery(defaults, scope).toString(), scoped);
  for (const options of [
    { ...defaults, notional: false },
    { ...defaults, design: "export" as const, notional: false },
    { ...defaults, preset: "amber" as const, anonymous: true },
    { ...defaults, unit: "USD" as const, usdPerEth: 2706.735 },
    {
      ...defaults,
      notional: false,
      design: "export" as const,
      unit: "USD" as const,
      usdPerEth: 1999.5,
    },
  ]) {
    const query = cardQuery(options, scope);
    assert.deepEqual(
      parseCardOptions(query),
      {
        ...options,
        notional: options.notional && options.design === "liquid",
      },
      query.toString(),
    );
  }
  assert.equal(
    cardQuery({ ...defaults, notional: false }, scope).toString(),
    `${scoped}&notional=0`,
  );
  // The export layout ignores the option, so it never reaches its URL.
  assert.equal(
    cardQuery(
      { ...defaults, design: "export", notional: false },
      scope,
    ).toString(),
    `${scoped}&design=export`,
  );
  assert.equal(parsed("&notional=1").notional, true);
  assert.equal(parsed("&notional=0&design=export").notional, false);
  // A window is not a position's to take: it never reaches a scoped URL.
  assert.equal(
    cardQuery({ ...defaults, window: "1h" }, scope).has("window"),
    false,
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
    excludedByFlag: null,
    bestWei: "11471084300772102",
    avgHold: null,
    last: null,
    asOf: null,
    oldestAsOf: null,
    completeWindow: true,
  };
  assert.deepEqual(cardHero(wallet), { value: "-16.0%", tone: "down" });
  assert.deepEqual(cardHero({ ...wallet, roi: 0.004 }), {
    value: "0.0%",
    tone: "text",
  });
  // A loss that rounds to zero at the tile's one decimal carries no sign and
  // no down colour, as the page's own tile prints it.
  assert.deepEqual(cardHero({ ...wallet, roi: -0.04 }), {
    value: "0.0%",
    tone: "text",
  });
  // Nothing disposed in the window means no ROI and no card, never a white
  // "0 ETH" headline that reads as a result.
  assert.equal(cardHero({ ...wallet, roi: null, realizedWei: "0" }), null);
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
      ["Volume", "0.51 ETH"],
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
  // Trades is the supported count the wallet page's tile and the board print,
  // never every attributed swap: the figures audit of 29 Sep 2026 (item D2)
  // caught the card at 26 against their 23 on one wallet read.
  const audited = { ...wallet, tradeCount: 26, supportedTradeCount: 23 };
  assert.equal(cardTradeCount(audited), 23);
  assert.deepEqual(
    cardStats(audited, false).map((s) => [s.label, s.value]),
    [
      ["Win rate", "37.5%"],
      ["Record", "3W · 5L"],
      ["Trades", "23"],
    ],
  );
  assert.deepEqual(
    cardStats(audited, true).map((s) => [s.label, s.value]),
    [
      ["Volume", "0.51 ETH"],
      ["Win rate", "37.5%"],
      ["Trades", "23"],
    ],
  );
  // The route's 404 gate reads the same count, so a wallet whose every
  // trade is on an excluded position (its page shows Trades 0) has no card.
  assert.equal(
    cardTradeCount({ ...wallet, tradeCount: 26, supportedTradeCount: 0 }),
    0,
  );
  // The export design's trio is fixed: Record always renders (even 0W · 0L
  // is real data), Best trade names the caller's own top position, and a
  // missing ROI leaves its slot empty rather than a placeholder.
  const orbit = { symbol: "ORBIT", token: `0x${"2".repeat(40)}` };
  assert.deepEqual(cardExportTrio(wallet, orbit, geist), {
    roi: "-16.0%",
    record: "3W · 5L",
    bestTrade: orbit,
  });
  assert.deepEqual(cardExportTrio({ ...wallet, roi: null }, null, geist), {
    roi: null,
    record: "3W · 5L",
    bestTrade: null,
  });
  // The export hero is the realized amount, as the captain's export draws it,
  // so no stat in the trio restates it (sweep s6 defect 14: the hero and the
  // ROI stat both read +187.32%).
  const exportHero = cardExportHero(wallet);
  assert.equal(exportHero!.value, "-0.02 ETH");
  assert.equal(exportHero!.tone, "down");
  assert.ok(
    !Object.values(cardExportTrio(wallet, orbit, geist)).includes(
      exportHero!.value,
    ),
  );
  assert.equal(
    cardExportHero({ ...wallet, realizedWei: "1046600000000000000" })!.value,
    "+1.05 ETH",
  );
  assert.equal(cardExportHero({ ...wallet, realizedWei: null }), null);
  assert.equal(
    cardExportHero({ ...wallet, roi: null, realizedWei: "0" }),
    null,
  );
  // The design's 207 px hero fits the figures the export was drawn with; a
  // longer one steps down to the largest size that fits the card's width.
  assert.equal(cardExportHeroSize("+12.40 ETH"), 207);
  assert.equal(cardExportHeroSize("+1.047 ETH"), 207);
  assert.ok(cardExportHeroSize("-0.02336 ETH") < 207);
  assert.ok(
    cardExportHeroSize("-0.0001234 ETH") < cardExportHeroSize("-0.02336 ETH"),
  );
  assert.ok(cardExportHeroSize("-0.0001234 ETH") >= 120);
  // From a million ETH the figure rule's compact form carries a letter the
  // size must count at its own width: "M" is a third wider than a digit, and
  // at the design's 207 px "+1.23M ETH" ran 1,066 px and wrapped.
  const million = cardExportHero({
    ...wallet,
    roi: 12,
    realizedWei: "1234567800000000000000000",
  })!.value;
  assert.equal(million, "+1.23M ETH");
  assert.equal(cardExportHeroSize(million), 202);
});

test("share card prints the wallet page's own figures for the audited wallets", () => {
  // The four production wallets of the PnL card audit of 29 Sep 2026 (read
  // API cursor 2026-09-29T15:22:38Z), with the strings their wallet page's
  // stat tiles print under the site's one figure rule: two decimals for an
  // ETH amount from 0.01 ETH, the ROI tile's one decimal, and the supported
  // trade count. The card prints the same, where it printed four significant
  // digits, a two-decimal ROI and every attributed trade before.
  const base = {
    unrealizedWei: null,
    netWei: null,
    excludedByFlag: null,
    last: null,
    asOf: 1790695358,
    oldestAsOf: 1790695358,
    completeWindow: true,
  };
  const top = {
    ...base,
    address: "0x2f25b929f03fe2869e752f1910e5445f8b5778da",
    rank: 1,
    realizedWei: "66223734506390192560",
    volumeWei: "97681113542028528825",
    roi: 805.667,
    wins: 11,
    losses: 7,
    winRate: 61.111111111111114,
    tradeCount: 110,
    supportedTradeCount: 103,
    supportedPositionCount: 19,
    excludedPositionCount: 4,
    bestWei: "1403702995627095569",
    avgHold: 220319,
  };
  const mid = {
    ...base,
    address: "0x5cef3188ab04bec8caace9818729c1c8f5553191",
    rank: 50,
    realizedWei: "20700661674978519804",
    volumeWei: "55816964231731636305",
    roi: 163.5743,
    wins: 17,
    losses: 57,
    winRate: 22.972972972972975,
    tradeCount: 207,
    supportedTradeCount: 193,
    supportedPositionCount: 74,
    excludedPositionCount: 9,
    bestWei: "3421112953478374377",
    avgHold: 523.0945945945946,
  };
  const loserHour = {
    ...base,
    address: "0x42c38dcff3bd710d28bcf0d96985f4005dc2dd36",
    rank: 65,
    realizedWei: "-571052117236791305",
    volumeWei: "508947882763208695",
    roi: -84.9779,
    wins: 0,
    losses: 1,
    winRate: 0,
    tradeCount: 10,
    supportedTradeCount: 10,
    supportedPositionCount: 9,
    excludedPositionCount: 0,
    bestWei: "-571052117236791305",
    avgHold: 1857,
  };
  const loserAll = {
    ...loserHour,
    rank: null,
    realizedWei: "-2235814105062195510",
    volumeWei: "3488185894937804490",
    roi: -78.1206,
    losses: 9,
    tradeCount: 90,
    supportedTradeCount: 90,
    bestWei: "-15547610960837812",
    avgHold: 847.6666666666666,
  };
  const oneTrade = {
    ...loserHour,
    address: "0x2d8bc8665d4b408c4b5e6cab2aa38066bafc2fdc",
    rank: null,
    realizedWei: "31149066115552184",
    volumeWei: "151149066115552184",
    roi: 25.9575,
    wins: 1,
    losses: 0,
    winRate: 100,
    tradeCount: 1,
    supportedTradeCount: 1,
    supportedPositionCount: 1,
    bestWei: "31149066115552184",
    avgHold: 3600,
  };
  assert.deepEqual(cardHero(top), { value: "+805.7%", tone: "up" });
  assert.equal(cardExportHero(top)!.value, "+66.22 ETH");
  assert.equal(cardExportHero(top)!.tone, "up");
  assert.deepEqual(cardHero(mid), { value: "+163.6%", tone: "up" });
  assert.equal(cardExportHero(mid)!.value, "+20.70 ETH");
  assert.deepEqual(cardHero(loserHour), { value: "-85.0%", tone: "down" });
  assert.equal(cardExportHero(loserHour)!.value, "-0.57 ETH");
  assert.equal(cardExportHero(loserHour)!.tone, "down");
  assert.deepEqual(cardHero(loserAll), { value: "-78.1%", tone: "down" });
  assert.equal(cardExportHero(loserAll)!.value, "-2.24 ETH");
  assert.deepEqual(cardHero(oneTrade), { value: "+26.0%", tone: "up" });
  assert.equal(cardExportHero(oneTrade)!.value, "+0.03 ETH");
  // The notional line and the Volume stat carry the same digits.
  assert.equal(cardEth(top.realizedWei, true), "+66.22 ETH");
  assert.equal(cardEth(top.volumeWei), "97.68 ETH");
  assert.equal(cardEth(mid.volumeWei), "55.82 ETH");
  assert.equal(cardEth(loserHour.volumeWei), "0.51 ETH");
  assert.equal(cardEth(loserAll.volumeWei), "3.49 ETH");
  // A tiny amount keeps the site's subscript-zero form on the card too: the
  // 24h board's rank 76 wallet realized -5,731,698,824 wei, which two
  // decimals would print as a fabricated "-0.00 ETH".
  assert.equal(cardEth("-5731698824", true), "-0.0₈5731 ETH");
  assert.deepEqual(
    cardExportHero({ ...top, realizedWei: "-5731698824" })!.eth,
    {
      sign: "",
      figure: { form: "subscript", sign: "-", zeros: 8, digits: "5731" },
      wei: "-5731698824",
    },
  );
  assert.deepEqual(cardEthFigure(top.realizedWei, true), {
    sign: "+",
    figure: { form: "plain", text: "66.22" },
    wei: top.realizedWei,
  });
  // The win rate, record and trade count read as the page's tiles: Trades
  // is the supported count, 103 and 193 where every attributed trade was 110
  // and 207.
  const shown = (wallet: Parameters<typeof cardStats>[0], notional: boolean) =>
    cardStats(wallet, notional).map((s) => [s.label, s.value]);
  assert.deepEqual(shown(top, false), [
    ["Win rate", "61.1%"],
    ["Record", "11W · 7L"],
    ["Trades", "103"],
  ]);
  assert.deepEqual(shown(top, true), [
    ["Volume", "97.68 ETH"],
    ["Win rate", "61.1%"],
    ["Trades", "103"],
  ]);
  assert.deepEqual(shown(mid, false), [
    ["Win rate", "23.0%"],
    ["Record", "17W · 57L"],
    ["Trades", "193"],
  ]);
  assert.deepEqual(shown(loserHour, false), [
    ["Win rate", "0.0%"],
    ["Record", "0W · 1L"],
    ["Trades", "10"],
  ]);
  assert.deepEqual(shown(loserAll, false), [
    ["Win rate", "0.0%"],
    ["Record", "0W · 9L"],
    ["Trades", "90"],
  ]);
  assert.deepEqual(shown(oneTrade, false), [
    ["Win rate", "100.0%"],
    ["Record", "1W · 0L"],
    ["Trades", "1"],
  ]);
  const hookr = {
    symbol: "HOOKR",
    token: "0x18e674231a58c239dc7daedcffe15ec3a24cff5c",
  };
  assert.deepEqual(cardExportTrio(top, hookr, geist), {
    roi: "+805.7%",
    record: "11W · 7L",
    bestTrade: hookr,
  });
  // Were its 20-glyph emoji token the top position, Best trade would be that
  // token's monogram alone: the card's faces draw none of the symbol.
  const emoji = {
    symbol: "🤑💰💵💴💶🪙💳🧾🏦💹💱📇🗃💼📊📋🖊🔍🔎📰",
    token: "0x1561ecadc047a1de15369e2c3af4375fbb3af9fa",
  };
  assert.deepEqual(cardExportTrio(top, emoji, geist).bestTrade, {
    symbol: null,
    token: emoji.token,
  });
  // From 10,000% the ROI takes the site's abbreviated form, the sign and
  // colour kept, so a figure never runs past its column: the rank-1 wallet's
  // HOOKR position realized 15,285.6% on its disposed cost.
  assert.deepEqual(cardHero({ ...top, roi: 15285.6 }), {
    value: "+15.3K%",
    tone: "up",
  });
  assert.deepEqual(cardHero({ ...top, roi: -15285.6 }), {
    value: "-15.3K%",
    tone: "down",
  });
  assert.equal(cardHero({ ...top, roi: 9999.94 })!.value, "+9999.9%");
  assert.equal(cardHero({ ...top, roi: 9999.96 })!.value, "+10K%");
  assert.equal(
    cardExportTrio({ ...top, roi: 1234567.8 }, null, geist).roi,
    "+1.2M%",
  );
});

test("share card token symbols keep what the card's face draws and never emoji", () => {
  const symbol = (text: string) => cardSymbol(text, geist);
  assert.equal(symbol("HOOKR"), "HOOKR");
  // Length is left whole: the renderer clamps a symbol by the width its slot
  // has left, which a glyph count cannot bound.
  assert.equal(symbol("PONSWARMCOIN"), "PONSWARMCOIN");
  // The card's faces have no emoji: a symbol the catalog really carries (the
  // rank-1 wallet's 20-glyph emoji token) has nothing left to draw, and the
  // card shows that token's monogram on its own.
  assert.equal(symbol("🤑💰💵💴💶🪙💳🧾🏦💹💱📇🗃💼📊📋🖊🔍🔎📰"), null);
  assert.equal(symbol("  "), null);
  assert.equal(symbol("🚀MOON🚀"), "MOON");
  assert.equal(symbol("👨‍👩‍👧  FAM"), "FAM");
  // Exactly what the face maps: Greek and Cyrillic are drawn, the Latin
  // Extended-B letters Geist leaves out are stripped with the emoji.
  assert.equal(symbol("Ünïcode-Ω"), "Ünïcode-Ω");
  assert.equal(symbol("ДОГЕ"), "ДОГЕ");
  assert.equal(symbol("ǱOGE"), "OGE");
  // The wallet tile's two glyphs are the site's monogram rule.
  assert.equal(
    cardInitials("0x2f25b929f03fe2869e752f1910e5445f8b5778da"),
    "2F",
  );
  assert.equal(
    cardInitials("0x18e674231a58c239dc7daedcffe15ec3a24cff5c"),
    "18",
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

test("a position card reads only a supported position of the named pool and launch", async (t) => {
  const previous = process.env.CHAIN_REFRESH_DISABLED,
    fixtures = process.env.PRODUCT_FIXTURES;
  process.env.CHAIN_REFRESH_DISABLED = "1";
  process.env.PRODUCT_FIXTURES = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = previous;
    if (fixtures === undefined) delete process.env.PRODUCT_FIXTURES;
    else process.env.PRODUCT_FIXTURES = fixtures;
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
  const card = await readCardPosition(
    wallet.wallet.address,
    position.poolId,
    position.launchTx,
  );
  assert.ok(card);
  // The wallet page's own row; the committed dataset folds no mark.
  assert.deepEqual(card.source, {
    position,
    mark: null,
    avgEntryPriceWei: null,
  });
  assert.equal(card.pool.id, position.poolId);
  assert.equal(card.pool.launchTx, position.launchTx);
  assert.equal(card.rank, wallet.wallet.rank);
  assert.deepEqual(
    await readCardPosition(wallet.wallet.address, position.poolId),
    card,
  );
  assert.equal(
    await readCardPosition(
      wallet.wallet.address,
      position.poolId,
      `0x${"f".repeat(64)}`,
    ),
    null,
  );
  assert.equal(
    await readCardPosition(wallet.wallet.address, `0x${"f".repeat(64)}`),
    null,
  );
  // The committed dataset's position read is the wallet page's row for every
  // position it holds, so a fixture card prints what the page prints.
  for (const { address, row } of datasetPositions())
    assert.deepEqual(
      (await readWalletPosition(address, row.poolId.toLowerCase()))?.position,
      row,
    );
  // An excluded position has no card, whatever the wallet's other rows say.
  const excluded = datasetPositions().find(({ row }) => !row.supported)!;
  assert.ok(excluded);
  assert.equal(
    await readCardPosition(excluded.address, excluded.row.poolId),
    null,
  );
});

test("a position card answers each refusal of the single-position read as its route does", async (t) => {
  const origin = process.env.INDEXER_API_URL,
    disabled = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (origin === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = origin;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  // Past the lifetime of any board read an earlier test left held.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * cardReadLifetimeMs });
  const positionBody = (of: AnalyticsWalletPosition) => ({
    coverage: { complete: false },
    window: "All",
    wallet: of.position!.trader,
    pool: {
      id: of.poolId,
      token: of.token,
      name: of.symbol,
      symbol: of.symbol,
      launchTx: of.launchTx,
      launchSender: `0x${"9".repeat(40)}`,
      launchBlock: 1,
      launchedAt: 1,
      launchType: "instant",
    },
    position: of,
    mark: {
      sqrtPriceX96: "1",
      priceWei: "4868000000000",
      block: 1,
      timestamp: 1,
      txHash: `0x${"1".repeat(64)}`,
      valueWei: "1",
    },
    roi: 1,
    totalRoi: 1,
    avgEntryPriceWei: "488980000000",
    cycles: null,
  });
  const poolBody = (of: AnalyticsWalletPosition, launch: string) => ({
    pool: {
      poolId: of.poolId,
      token: of.token,
      name: of.symbol,
      symbol: of.symbol,
      launchType: "instant",
      launch: { block: 1, timestamp: 1, transactionHash: launch },
    },
    analytics: null,
  });
  const board = (address: string) => ({
    coverage: {},
    window: "All",
    metric: "realized",
    minTrades: 10,
    items: [{ address, rank: 50 }],
    total: 1,
    nextOffset: null,
  });
  let served: Record<string, { status?: number; body: unknown }> = {},
    requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/v1/", "");
    requested.push(`${path}${url.search}`);
    const answer = served[path] ?? {
      status: 404,
      body: { error: "not_found" },
    };
    return Response.json(answer.body, { status: answer.status ?? 200 });
  });
  // Each case is its own wallet, so no answer is served from another's cache.
  let n = 0;
  const serve = (
    row: AnalyticsWalletPosition,
    answer: { status?: number; body: unknown },
  ) => {
    const address = `0x${(++n).toString(16).padStart(40, "0")}`;
    served = {
      [`wallets/${address}/positions/${row.poolId}`]: answer,
      leaderboard: { body: board(address) },
    };
    requested = [];
    return address;
  };
  const row = audited.BCTC;
  // The three "no such position" answers are the route's 404: no card.
  for (const error of [
    "pool_not_indexed",
    "wallet_not_found",
    "position_not_found",
  ])
    assert.equal(
      await readCardPosition(
        serve(row, { status: 404, body: { error } }),
        row.poolId,
      ),
      null,
      error,
    );
  // Every read it cannot answer is the route's 503, never a guessed card;
  // so is a read API without the route (its bare `not_found`).
  for (const error of [
    "position_coverage_unavailable",
    "position_refresh_pending",
    "catalog_identity_conflict",
  ])
    await assert.rejects(
      readCardPosition(
        serve(row, { status: 503, body: { error } }),
        row.poolId,
      ),
      ProductUnavailableError,
      error,
    );
  await assert.rejects(
    readCardPosition(
      serve(row, { status: 404, body: { error: "not_found" } }),
      row.poolId,
    ),
    ProductUnavailableError,
  );
  // A body naming another wallet, or a row another launch, is no card either.
  const own = (address: string) => ({
    ...row,
    position: { ...row.position!, trader: address as `0x${string}` },
  });
  let address = serve(row, { body: null });
  served[`wallets/${address}/positions/${row.poolId}`] = {
    body: positionBody(own(`0x${"e".repeat(40)}`)),
  };
  await assert.rejects(
    readCardPosition(address, row.poolId),
    ProductUnavailableError,
  );
  address = serve(row, { body: null });
  served[`wallets/${address}/positions/${row.poolId}`] = {
    body: {
      ...positionBody(own(address)),
      position: { ...own(address), launchTx: `0x${"6".repeat(64)}` },
    },
  };
  await assert.rejects(
    readCardPosition(address, row.poolId),
    ProductUnavailableError,
  );
  // A closed position is drawn from the position read and the board alone:
  // its prices exactly as served, its rank from the board, no pool read.
  address = serve(row, { body: null });
  served[`wallets/${address}/positions/${row.poolId}`] = {
    body: positionBody(own(address)),
  };
  const closed = await readCardPosition(address, row.poolId, row.launchTx);
  assert.deepEqual(closed?.source, {
    position: own(address),
    mark: positionBody(row).mark,
    avgEntryPriceWei: "488980000000",
  });
  assert.equal(closed?.pool.name, "BCTC");
  assert.equal(closed?.rank, 50);
  assert.deepEqual(closed?.candles, []);
  assert.deepEqual(requested, [
    `wallets/${address}/positions/${row.poolId}?window=All`,
    "leaderboard?window=All&limit=100",
  ]);
  // An open position reads its pool for the chart, which must name the
  // same launch; an excluded one has no card.
  const open = audited.HOOKR;
  address = serve(open, { body: null });
  served[`wallets/${address}/positions/${open.poolId}`] = {
    body: positionBody({
      ...open,
      position: { ...open.position!, trader: address as `0x${string}` },
    }),
  };
  served[`pools/${open.poolId}`] = {
    body: poolBody(open, `0x${"6".repeat(64)}`),
  };
  await assert.rejects(readCardPosition(address, open.poolId));
  // The pool read that disagreed is held like any other until it lapses.
  t.mock.timers.setTime(Date.now() + 2 * cardReadLifetimeMs);
  address = serve(open, { body: null });
  served[`wallets/${address}/positions/${open.poolId}`] = {
    body: positionBody({
      ...open,
      position: { ...open.position!, trader: address as `0x${string}` },
    }),
  };
  served[`pools/${open.poolId}`] = { body: poolBody(open, open.launchTx) };
  const held = await readCardPosition(address, open.poolId);
  assert.equal(held?.source.avgEntryPriceWei, "488980000000");
  assert.ok(requested.includes(`pools/${open.poolId}?window=All`));
  address = serve(row, { body: null });
  served[`wallets/${address}/positions/${row.poolId}`] = {
    body: {
      ...positionBody(own(address)),
      position: {
        ...own(address),
        supported: false,
        flags: ["unattributed_outflow"],
        realizedWei: null,
        netWei: null,
        unrealizedWei: null,
        position: null,
      },
    },
  };
  assert.equal(await readCardPosition(address, row.poolId), null);
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
    (error: unknown) => error instanceof ProductUnavailableError,
  );
  // Nor does the fixture deployment have follow activity to invent.
  process.env.CHAIN_REFRESH_DISABLED = "1";
  process.env.PRODUCT_FIXTURES = "1";
  t.after(() => delete process.env.PRODUCT_FIXTURES);
  await assert.rejects(
    readProduct(
      ["following"],
      new URLSearchParams({ wallets: `0x${"1".repeat(40)}` }),
    ),
    (error: unknown) => error instanceof ProductUnavailableError,
  );
});

/** The contract's own example response, verbatim (`GET /v1/following`,
 * trimmed from a real run against the explorer on 25 Sep 2026). */
const followingExample = {
  source: "blockscout",
  scope: "explorer_registry_trades",
  items: [
    {
      id: "0xb391b92e615feae009e3b3ffb0fdc7348aee1c29256b06cd5051378890666af7:17",
      wallet: "0x562f81ada979043b20b121490f1f0f4ce3f1ec59",
      poolId:
        "0x77bbe095432075e9d574ffc55c3076af5f5fe5f104b589a927c72abeebf3c81f",
      token: "0xe7a2fcf0f32e75ac4b14133f1fa4dff5a0dbaec6",
      symbol: "ROBINHOOD",
      name: "Robinhood",
      decimals: 18,
      txHash:
        "0xb391b92e615feae009e3b3ffb0fdc7348aee1c29256b06cd5051378890666af7",
      logIndex: 17,
      block: 65240160,
      timestamp: 1789635351,
      side: "sell",
      tokenRaw: "204380635229317043485969",
      method: "0x3593564c",
    },
  ],
  hasMore: true,
  notice:
    "Each followed wallet's newest explorer trades in verified-registry tokens. No ETH amounts or prices; wallets not read yet are listed in coverage.",
  note: "Explorer history for display only; not accounting or PnL evidence.",
  coverage: {
    requestedWallets: 2,
    returnedTokens: 1,
    wallets: [
      {
        wallet: "0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5",
        status: "read",
        fetchedAt: "2026-09-25T21:44:28.479Z",
        reason: null,
        olderTrades: true,
        horizonBlock: 72114732,
      },
      {
        wallet: "0x562f81ada979043b20b121490f1f0f4ce3f1ec59",
        status: "read",
        fetchedAt: "2026-09-25T21:44:35.272Z",
        reason: null,
        olderTrades: true,
        horizonBlock: 65213953,
      },
    ],
    generatedAt: "2026-09-25T21:44:36.065Z",
    complete: false,
    registryExhaustive: false,
  },
};
const followingParams = new URLSearchParams({
  wallets:
    "0x562f81ada979043b20b121490f1f0f4ce3f1ec59,0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5",
  limit: "50",
});
type FollowingExample = typeof followingExample;
const withTrade = (
  patch: Record<string, unknown>,
  data: FollowingExample = followingExample,
) => ({ ...data, items: [{ ...data.items[0], ...patch }] });
const withWallet = (index: number, patch: Record<string, unknown>) => ({
  ...followingExample,
  coverage: {
    ...followingExample.coverage,
    wallets: followingExample.coverage.wallets.map((w, i) =>
      i === index ? { ...w, ...patch } : w,
    ),
  },
});

test("following proxy accepts the contract's explorer trades example verbatim", async () => {
  const { validateFollowingResponse } = await import("./following-response");
  assert.doesNotThrow(() =>
    validateFollowingResponse(
      structuredClone(followingExample),
      followingParams,
    ),
  );
});

test("following proxy accepts a trade the explorer sent without symbol, name, decimals, time or pool", async () => {
  const { validateFollowingResponse } = await import("./following-response");
  for (const patch of [
    { symbol: null },
    { name: null },
    { decimals: null },
    { timestamp: null },
    { poolId: null },
    { symbol: null, name: null, decimals: null, timestamp: null, poolId: null },
    { method: null },
  ])
    assert.doesNotThrow(
      () => validateFollowingResponse(withTrade(patch), followingParams),
      JSON.stringify(patch),
    );
});

test("following proxy accepts every per-wallet coverage status and holds each to its shape", async () => {
  const { validateFollowingResponse } = await import("./following-response");
  // The trade belongs to the second wallet; the first takes each status.
  for (const patch of [
    { status: "read" },
    {
      status: "stale",
      reason: "budget_exhausted",
    },
    {
      status: "pending",
      fetchedAt: null,
      olderTrades: false,
      horizonBlock: null,
    },
    {
      status: "unavailable",
      fetchedAt: null,
      reason: "key_rejected",
      olderTrades: false,
      horizonBlock: null,
    },
    { olderTrades: false, horizonBlock: null },
  ])
    assert.doesNotThrow(
      () => validateFollowingResponse(withWallet(0, patch), followingParams),
      JSON.stringify(patch),
    );
  for (const patch of [
    { status: "partial" },
    { status: "pending" },
    { status: "read", fetchedAt: null },
    { status: "read", fetchedAt: "yesterday" },
    { reason: "rate_limited" },
    { olderTrades: "yes" },
    { horizonBlock: -1 },
    { wallet: `0x${"9".repeat(40)}` },
  ])
    assert.throws(
      () => validateFollowingResponse(withWallet(0, patch), followingParams),
      JSON.stringify(patch),
    );
  // A wallet the answer says it has not read can have no trades in it.
  for (const status of ["pending", "unavailable"])
    assert.throws(() =>
      validateFollowingResponse(
        withWallet(1, {
          status,
          fetchedAt: null,
          olderTrades: false,
          horizonBlock: null,
        }),
        followingParams,
      ),
    );
  // One coverage entry per requested wallet, in the api's sorted order.
  assert.throws(() =>
    validateFollowingResponse(
      {
        ...followingExample,
        coverage: {
          ...followingExample.coverage,
          wallets: [...followingExample.coverage.wallets].reverse(),
        },
      },
      followingParams,
    ),
  );
  assert.throws(() =>
    validateFollowingResponse(
      {
        ...followingExample,
        coverage: {
          ...followingExample.coverage,
          wallets: followingExample.coverage.wallets.slice(1),
        },
      },
      followingParams,
    ),
  );
});

test("following proxy rejects another wallet's trades, the retired shape and malformed rows", async () => {
  const { validateFollowingResponse } = await import("./following-response");
  for (const patch of [
    { wallet: `0x${"9".repeat(40)}` },
    { side: "transfer" },
    { token: "javascript:alert(1)" },
    { poolId: "pool" },
    { tokenRaw: 204380635229317043485969 },
    { tokenRaw: "-1" },
    { tokenRaw: "1.5" },
    { decimals: 256 },
    { decimals: "18" },
    { timestamp: "1789635351" },
    { symbol: "x".repeat(257) },
    { id: "0xb391:18" },
    { logIndex: -1 },
  ])
    assert.throws(
      () => validateFollowingResponse(withTrade(patch), followingParams),
      JSON.stringify(patch),
    );
  assert.throws(() =>
    validateFollowingResponse(
      {
        ...followingExample,
        items: [followingExample.items[0], followingExample.items[0]],
      },
      followingParams,
    ),
  );
  assert.throws(() =>
    validateFollowingResponse(
      withTrade({}),
      new URLSearchParams({
        wallets: followingParams.get("wallets")!,
        limit: "0",
      }),
    ),
  );
  // The pre-ledger accounting shape is retired with the api deploy.
  assert.throws(() =>
    validateFollowingResponse(
      { ...followingExample, scope: "saved_verified_positions" },
      followingParams,
    ),
  );
  assert.throws(() =>
    validateFollowingResponse(
      { ...followingExample, source: undefined },
      followingParams,
    ),
  );
  assert.throws(() =>
    validateFollowingResponse(
      {
        ...followingExample,
        coverage: {
          ...followingExample.coverage,
          returnedPools: 1,
          returnedTokens: undefined,
        },
      },
      followingParams,
    ),
  );
});

test("following proxy answers the explorer's 503 as the panel's unavailable state", async (t) => {
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
  for (const reason of [
    "not_configured",
    "budget_exhausted",
    "upstream_unavailable",
    "key_rejected",
  ]) {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(
        { error: "wallet_history_unavailable", reason },
        { status: 503, headers: { "Retry-After": "3600" } },
      ),
    );
    await assert.rejects(
      readProduct(["following"], followingParams),
      (error: unknown) => {
        assert.ok(error instanceof ProductUnavailableError);
        const response = productUnavailableResponse(error);
        assert.equal(response.status, 503);
        return true;
      },
    );
  }
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(structuredClone(followingExample)),
  );
  const served = await readProduct(["following"], followingParams);
  assert.deepEqual(served, {
    ...followingExample,
    delivery: { source: "indexer" },
  });
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
    await assert.rejects(readProduct(path, params));
  }
  next = () =>
    Response.json({
      ...response,
      trade: { ...response.trade, realizedWei: "1" },
    });
  await assert.rejects(
    readProduct(path, params),
    (error: unknown) => error instanceof ProductUnavailableError,
  );
  // Even the fixture deployment has no verified sale to publish.
  process.env.CHAIN_REFRESH_DISABLED = "1";
  process.env.PRODUCT_FIXTURES = "1";
  t.after(() => delete process.env.PRODUCT_FIXTURES);
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
  // A body this deployment cannot trust is as unusable as no body, and no
  // stored pool stands in for it.
  for (const bad of ["63742277x", "6.5e7", " 63742277", "-1", "", 1.5, null])
    for (const field of ["block", "timestamp", "sourceBatchThroughBlock"]) {
      // An unrecorded source batch is absent data, not a malformed value.
      if (bad === null && field === "sourceBatchThroughBlock") continue;
      response = savedPool();
      response.pool.launch[field] = bad;
      await assert.rejects(
        readProduct(path, new URLSearchParams()),
        (error: unknown) => error instanceof ProductUnavailableError,
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

test("a pool in the committed dataset is not resurrected while the index is unavailable", async (t) => {
  const prior = process.env.INDEXER_API_URL,
    disabled = process.env.CHAIN_REFRESH_DISABLED,
    fixtures = process.env.PRODUCT_FIXTURES;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  process.env.PRODUCT_FIXTURES = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = prior;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
    if (fixtures === undefined) delete process.env.PRODUCT_FIXTURES;
    else process.env.PRODUCT_FIXTURES = fixtures;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("index offline");
  });
  /* This is the pool page the captain was shown: it is in the committed
     snapshot, so it used to answer with that snapshot's days-old figures. */
  await assert.rejects(
    readProduct<{ name: string }>(["pools", monkiiLabs], new URLSearchParams()),
    (error: unknown) => error instanceof ProductUnavailableError,
  );
});

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

test("public proxy admits the eth/usd price with no query and rejects extras", () => {
  const checked = productRequest(
    ["prices", "eth-usd"],
    new URLSearchParams(""),
  );
  assert.equal(checked.endpoint, "prices/eth-usd");
  assert.equal(checked.params.toString(), "");
  assert.throws(() =>
    productRequest(["prices", "eth-usd"], new URLSearchParams("window=24h")),
  );
  assert.throws(() =>
    productRequest(["prices", "eth-usd", "extra"], new URLSearchParams("")),
  );
});

test("eth/usd price keeps the read API's outage contract and never falls back", async (t) => {
  const { readEthPrice, EthPriceUnavailableError } =
    await import("./product-server");
  const path = ["prices", "eth-usd"];
  withIndexer(t);
  await assert.rejects(readEthPrice(path, new URLSearchParams("")), (error) => {
    assert.ok(error instanceof EthPriceUnavailableError);
    assert.equal(error.retryAfter, 60);
    return true;
  });
  withIndexer(t, "https://index.example");
  let requested = "";
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    requested = String(input);
    return Response.json(
      { error: "price_unavailable" },
      { status: 503, headers: { "Retry-After": "45" } },
    );
  });
  await assert.rejects(readEthPrice(path, new URLSearchParams("")), (error) => {
    assert.ok(error instanceof EthPriceUnavailableError);
    assert.equal(error.retryAfter, 45);
    return true;
  });
  assert.equal(requested, "https://index.example/v1/prices/eth-usd");
});

test("product proxy preserves warming reason and Retry-After while generic outages keep their fallback", async (t) => {
  withIndexer(t, "https://index.example");
  let upstream = Response.json(
    { error: "data_temporarily_unavailable", reason: "warming" },
    { status: 503, headers: { "Retry-After": "5" } },
  );
  t.mock.method(globalThis, "fetch", async () => upstream.clone());

  let failure: ProductUnavailableError | undefined;
  await assert.rejects(
    readProduct(["explore"], new URLSearchParams("limit=25")),
    (error: unknown) => {
      assert.ok(error instanceof ProductUnavailableError);
      failure = error;
      return true;
    },
  );
  const warming = productUnavailableResponse(failure!);
  assert.equal(warming.status, 503);
  assert.equal(warming.headers.get("retry-after"), "5");
  assert.deepEqual(await warming.json(), {
    error: "data_unavailable",
    reason: "warming",
  });

  upstream = Response.json(
    { error: "data_temporarily_unavailable" },
    { status: 503, headers: { "Retry-After": "5" } },
  );
  failure = undefined;
  await assert.rejects(
    readProduct(["explore"], new URLSearchParams("limit=25")),
    (error: unknown) => {
      assert.ok(error instanceof ProductUnavailableError);
      failure = error;
      return true;
    },
  );
  const unavailable = productUnavailableResponse(failure!);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "30");
  assert.deepEqual(await unavailable.json(), { error: "data_unavailable" });
});

test("product proxy preserves either valid Retry-After form for warming", async (t) => {
  withIndexer(t, "https://index.example");
  let retryAfter = "120";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "data_temporarily_unavailable", reason: "warming" },
      { status: 503, headers: { "Retry-After": retryAfter } },
    ),
  );
  for (const expected of ["120", "Sun, 06 Nov 1994 08:49:37 GMT"]) {
    retryAfter = expected;
    let failure: ProductUnavailableError | undefined;
    await assert.rejects(
      readProduct(["explore"], new URLSearchParams("limit=25")),
      (error: unknown) => {
        assert.ok(error instanceof ProductUnavailableError);
        failure = error;
        return true;
      },
    );
    const response = productUnavailableResponse(failure!);
    assert.equal(response.headers.get("retry-after"), expected);
  }
});

test("eth/usd price validates the upstream shape before trusting it", async (t) => {
  const { readEthPrice, EthPriceUnavailableError } =
    await import("./product-server");
  const path = ["prices", "eth-usd"];
  withIndexer(t, "https://index.example");
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call += 1;
    return call === 1
      ? Response.json({
          usdPerEth: 4218.44,
          asOf: "2026-09-15T00:00:00.000Z",
          source: "coinbase",
        })
      : Response.json({ usdPerEth: -1, source: "coinbase" });
  });
  const price = await readEthPrice(path, new URLSearchParams(""));
  assert.equal(price.usdPerEth, 4218.44);
  await assert.rejects(
    readEthPrice(path, new URLSearchParams("")),
    EthPriceUnavailableError,
  );
});

/* The crowd launch contract: every catalogue row names its launch type,
   "instant" or "crowd". An absent one reads as unknown (the read API spreads
   it only when its row has one, and a release before the crowd lane sends
   none); any other value is a contract break and the read is unusable. */
const launchTypes = {
  accepted: ["instant", "crowd", undefined] as unknown[],
  rejected: ["Crowd", "auction", "", null, 1, true] as unknown[],
};
const exploreRow = (launchType: unknown) => ({
  id: stackBtc,
  token: stackToken,
  name: "Stack Btc 7",
  symbol: "STACK",
  launchTx: `0x${"c".repeat(64)}`,
  launchSender: `0x${"a".repeat(40)}`,
  launchBlock: 63742277,
  launchedAt: 1789483971,
  ...(launchType === undefined ? {} : { launchType }),
});

test("explore rows carry a launch type, and the crowd view carries crowd launches only", () => {
  const all = new URLSearchParams("view=all"),
    crowd = new URLSearchParams("view=crowd");
  for (const launchType of launchTypes.accepted)
    validateExploreResponse({ items: [exploreRow(launchType)] }, all);
  for (const launchType of launchTypes.rejected)
    assert.throws(
      () => validateExploreResponse({ items: [exploreRow(launchType)] }, all),
      /Invalid explore row/,
    );
  validateExploreResponse(
    { items: [exploreRow("crowd"), exploreRow("crowd")] },
    crowd,
  );
  // A misrouted or stale answer must never list an Instant launch under Crowd.
  for (const launchType of ["instant", undefined])
    assert.throws(
      () =>
        validateExploreResponse(
          { items: [exploreRow("crowd"), exploreRow(launchType)] },
          crowd,
        ),
      /Invalid explore row/,
    );
  for (const bad of [null, {}, { items: null }, { items: [null] }])
    assert.throws(() => validateExploreResponse(bad, all));
});

test("a creator's best launch carries a launch type", () => {
  const response = (launchType: unknown) => ({
    sort: "launches",
    direction: "desc",
    window: "All",
    attribution: "launch_transaction_initiator",
    total: 1,
    nextOffset: null,
    items: [
      {
        address: `0x${"a".repeat(40)}`,
        launches: 2,
        measured: 1,
        traded: 1,
        volumeWei: "1000",
        medianVolumeWei: "1000",
        bestLaunch: { ...exploreRow(launchType), volumeWei: "1000" },
        boughtOwnLaunch: false,
      },
    ],
  });
  const params = new URLSearchParams();
  for (const launchType of launchTypes.accepted)
    validateCreatorsResponse(response(launchType), params);
  for (const launchType of launchTypes.rejected)
    assert.throws(
      () => validateCreatorsResponse(response(launchType), params),
      /Invalid creator row/,
    );
});

test("a saved pool carries a launch type beside its launch", () => {
  const pool = (launchType: unknown) => {
    const saved = savedPool();
    return {
      ...saved,
      pool: {
        ...saved.pool,
        ...(launchType === undefined ? {} : { launchType }),
      },
    };
  };
  for (const launchType of launchTypes.accepted)
    validatePoolResponse(pool(launchType), stackBtc, "24h");
  for (const launchType of launchTypes.rejected)
    assert.throws(
      () => validatePoolResponse(pool(launchType), stackBtc, "24h"),
      /Invalid saved launch type/,
    );
});

test("the committed dataset serves the crowd view as its crowd launches: none, and no placeholder", async () => {
  const crowd = (await preloadedProduct(
    "explore",
    new URLSearchParams("view=crowd&limit=100"),
  )) as AnalyticsExploreResponse;
  assert.deepEqual(crowd.items, []);
  assert.equal(crowd.total, 0);
  assert.equal("message" in crowd, false);
  const all = (await preloadedProduct(
    "explore",
    new URLSearchParams("view=all&limit=100"),
  )) as AnalyticsExploreResponse;
  assert.ok(all.items.length > 0);
  assert.ok(all.items.every((row) => row.launchType === "instant"));
});

test("a wallet's own launches carry a launch type, through the proxy too", async (t) => {
  for (const launchType of launchTypes.accepted)
    validateWalletLaunches([exploreRow(launchType)]);
  for (const launchType of launchTypes.rejected)
    assert.throws(
      () => validateWalletLaunches([exploreRow(launchType)]),
      /Invalid wallet launch/,
    );
  assert.throws(() => validateWalletLaunches([null]), /Invalid wallet launch/);

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
  const address = `0x${"a".repeat(40)}`;
  let launchType: unknown = "crowd";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      coverage: { chainId: 4663 },
      window: "24h",
      wallet: { address },
      positions: [],
      trades: [],
      curve: [],
      launches: [exploreRow(launchType)],
    }),
  );
  const path = ["wallets", address],
    params = new URLSearchParams("window=24h");
  const served = await readProduct<{ launches: { launchType: string }[] }>(
    path,
    params,
  );
  assert.equal(served.launches[0].launchType, "crowd");
  launchType = "auction";
  await assert.rejects(
    readProduct(path, params),
    (error: unknown) => error instanceof ProductUnavailableError,
  );
});
const sample = () => ({
  window: "24h",
  asOf: 1790000000,
  cutoff: { block: 12345678, hash: `0x${"a".repeat(64)}`, asOf: 1790000000 },
  windowStart: 1789910400,
  volumeWei: "123456789012345678901",
  trades: 1234,
  liquidityWei: null,
  poolsLaunched: 42,
  activeTraders: 123,
  completeWindow: true,
  coverage: {
    catalogPools: 63000,
    processedPools: 62000,
    asOf: 1790000000,
    oldestAsOf: 1790000000,
    generatedAt: "2026-09-28T00:00:00.000Z",
    complete: false,
    registryExhaustive: false,
    pnlScope: "attributed_positions_all_pools",
    measuredPools: 62000,
    activeTraderScope: "attributed_wallets_in_measured_pools",
  },
});

test("stats route forwards only the contract windows", () => {
  for (const window of ["1h", "6h", "24h", "7d", "30d", "All"]) {
    const request = productRequest(["stats"], new URLSearchParams({ window }));
    assert.equal(request.endpoint, "stats");
    assert.equal(request.params.get("window"), window);
  }
  assert.throws(() =>
    productRequest(["stats"], new URLSearchParams("window=2h")),
  );
  assert.throws(() =>
    productRequest(["stats"], new URLSearchParams("sort=volume")),
  );
});

test("stats validator accepts covered figures and an incomplete rolling hour", () => {
  const complete = sample();
  validateStatsResponse(complete, "24h");
  const incomplete = {
    ...complete,
    window: "1h",
    volumeWei: null,
    trades: null,
    activeTraders: null,
    completeWindow: false,
    poolsLaunched: 0,
  };
  validateStatsResponse(incomplete, "1h");
});

test("stats validator accepts the production All response with no window start", () => {
  // GET /v1/stats?window=All on 2026-09-29, with its original values.
  const all = {
    window: "All",
    asOf: 1790657545,
    cutoff: {
      block: 75384907,
      hash: "0x2658173a7fd1debf7af7714cc5f3ec195c169bb640687025538b63433ce34bad",
      asOf: 1790657545,
    },
    windowStart: null,
    volumeWei: "459760618088033142127280",
    trades: 11512186,
    liquidityWei: null,
    poolsLaunched: 64820,
    activeTraders: 402620,
    completeWindow: true,
    coverage: {
      catalogPools: 64820,
      processedPools: 63483,
      asOf: 1790657545,
      oldestAsOf: 1790657545,
      generatedAt: "2026-09-29T04:54:11.522Z",
      complete: false,
      registryExhaustive: false,
      pnlScope: "attributed_positions_all_pools",
      measuredPools: 64820,
      activeTraderScope: "attributed_wallets_in_measured_pools",
    },
  };
  validateStatsResponse(all, "All");
  assert.throws(() => validateStatsResponse(all, "24h"));
  assert.throws(() => validateStatsResponse({ ...all, windowStart: 0 }, "All"));
  assert.throws(() =>
    validateStatsResponse({ ...sample(), windowStart: null }, "24h"),
  );
});

test("stats validator refuses missing, stale, or fabricated figures", () => {
  assert.throws(() => validateStatsResponse(sample(), "7d"));
  const invalid: unknown[] = [
    { ...sample(), volumeWei: 123 },
    { ...sample(), volumeWei: "1.5" },
    { ...sample(), volumeWei: undefined },
    { ...sample(), trades: -1 },
    { ...sample(), poolsLaunched: null },
    { ...sample(), activeTraders: "123" },
    { ...sample(), completeWindow: undefined },
    {
      ...sample(),
      coverage: { ...sample().coverage, measuredPools: undefined },
    },
    {
      ...sample(),
      coverage: { ...sample().coverage, activeTraderScope: "all_wallets" },
    },
    {
      ...sample(),
      coverage: { ...sample().coverage, activeTraderScope: undefined },
    },
  ];
  for (const value of invalid)
    assert.throws(() => validateStatsResponse(value, "24h"));
});

test("stats read treats a missing route, coverage refusal, and invalid body as no cards", async (t) => {
  const origin = process.env.INDEXER_API_URL;
  const disabled = process.env.CHAIN_REFRESH_DISABLED;
  const fixtures = process.env.PRODUCT_FIXTURES;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (origin === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = origin;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
    if (fixtures === undefined) delete process.env.PRODUCT_FIXTURES;
    else process.env.PRODUCT_FIXTURES = fixtures;
  });
  let response = Response.json(sample());
  let requested = "";
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    requested = String(input);
    return response.clone();
  });
  assert.equal((await readScreenerStats("24h")).status, 200);
  assert.equal(requested, "https://index.example/v1/stats?window=24h");
  response = Response.json({ error: "not_found" }, { status: 404 });
  assert.deepEqual(await readScreenerStats("24h"), { status: 404 });
  response = Response.json(
    { error: "stats_coverage_unavailable" },
    { status: 503 },
  );
  assert.deepEqual(await readScreenerStats("24h"), { status: 503 });
  response = Response.json({ ...sample(), poolsLaunched: undefined });
  assert.deepEqual(await readScreenerStats("24h"), { status: 503 });
  process.env.CHAIN_REFRESH_DISABLED = "1";
  process.env.PRODUCT_FIXTURES = "1";
  assert.deepEqual(await readScreenerStats("24h"), { status: 503 });
});

test("position card figures reproduce the audited HOOKR, BCTC and POTATCHI positions", () => {
  const hookr = positionCardFigures(fromWallet(audited.HOOKR))!;
  assert.equal(hookr.open, true);
  // 62.476 ETH realized on 0.409 ETH of disposed cost.
  assert.deepEqual(hookr.hero, {
    label: "Realized ROI",
    value: "+15.3K%",
    eth: null,
    tone: "up",
  });
  assert.equal(text(hookr.realized), "+62.48 ETH");
  assert.equal(hookr.holding, "8.27M");
  assert.equal(text(hookr.unrealized), "+36.24 ETH");
  assert.equal(hookr.unrealizedRoi, "+895.73%");
  assert.equal(text(hookr.invested), "4.46 ETH");
  assert.equal(text(hookr.proceeds), "62.89 ETH");
  assert.equal(hookr.multiple, null);
  assert.equal(hookr.buys, 5);
  assert.equal(hookr.sells, 55);
  // Opened 6 Aug 2026 04:22:56Z, 54 days before the cut.
  assert.equal(hookr.held, "54d");
  // A source that serves neither price leaves both cells blank.
  assert.equal(hookr.entry, null);
  assert.equal(hookr.mark, null);

  const bctc = positionCardFigures(fromWallet(audited.BCTC))!;
  assert.equal(bctc.open, false);
  // 1149.2664...%: two decimals as the site's Change rounds them.
  assert.equal(bctc.hero.value, "+1149.27%");
  assert.equal(bctc.hero.tone, "up");
  assert.equal(text(bctc.realized), "+11.38 ETH");
  assert.equal(text(bctc.invested), "0.99 ETH");
  assert.equal(text(bctc.proceeds), "12.37 ETH");
  assert.equal(bctc.multiple, "12.49x");
  assert.deepEqual(bctc.bars, { invested: 8, proceeds: 100 });
  assert.equal(bctc.holding, "0.00");
  // A closed position's hour bounds are not its hold: no cell.
  assert.equal(bctc.held, null);

  const potatchi = positionCardFigures(fromWallet(audited.POTATCHI))!;
  assert.equal(potatchi.open, false);
  assert.equal(potatchi.hero.value, "-83.35%");
  assert.equal(potatchi.hero.tone, "down");
  assert.equal(text(potatchi.realized), "-0.68 ETH");
  assert.equal(text(potatchi.invested), "0.81 ETH");
  assert.equal(text(potatchi.proceeds), "0.14 ETH");
  assert.equal(potatchi.multiple, "0.17x");
  assert.deepEqual(potatchi.bars, { invested: 100, proceeds: 16.64 });
  assert.equal(potatchi.buys, 21);
  assert.equal(potatchi.sells, 1);
});

test("position card prints every amount as the wallet page prints the same position", () => {
  // The positions table's cells: `Eth` in live-ui.tsx for the amounts, and
  // `holding` in product-wallet.tsx for the units, on the All window.
  const page = (wei: string | null, signed = false) =>
    wei === null
      ? null
      : `${signed && displayEth(wei) > 0 ? "+" : ""}${figureText(ethFigure(wei))} ETH`;
  const rows = [
    ...datasetPositions().map(({ row }) => row),
    ...Object.values(audited),
  ];
  let open = 0,
    closed = 0,
    excluded = 0;
  for (const row of rows) {
    const card = positionCardFigures(fromWallet(row));
    if (!row.supported || !row.position) {
      assert.equal(card, null);
      excluded++;
      continue;
    }
    assert.ok(card);
    if (card.open) open++;
    else closed++;
    // The page's Realized column is the window's sum, here the whole history.
    if (card.realized)
      assert.equal(text(card.realized), page(row.realizedWei, true));
    assert.equal(text(card.unrealized), page(row.unrealizedWei, true));
    assert.equal(
      card.holding,
      row.decimals === null
        ? null
        : formatTokenAmount(row.position.quantity, row.decimals),
    );
    if (card.hero.label === "Unrealized PnL")
      assert.equal(card.hero.value, page(row.unrealizedWei, true));
  }
  assert.ok(
    open && closed && excluded,
    `${open} open, ${closed} closed and ${excluded} excluded positions`,
  );
});

test("position card leaves every figure its source does not serve blank", () => {
  const row = audited.HOOKR;
  assert.equal(
    positionCardFigures(fromWallet({ ...row, supported: false })),
    null,
  );
  assert.equal(
    positionCardFigures(fromWallet({ ...row, position: null })),
    null,
  );
  const unmarked = positionCardFigures(
    fromWallet({ ...row, decimals: null, unrealizedWei: null }),
  )!;
  assert.equal(unmarked.holding, null);
  assert.equal(unmarked.unrealized, null);
  assert.equal(unmarked.unrealizedRoi, null);
  assert.equal(unmarked.hero.value, "+15.3K%");
  // Before the first sale the headline is the unrealized PnL, neutral, and
  // blank when that is not served either.
  const bought = {
    ...row,
    realizedWei: "0",
    position: {
      ...row.position!,
      investedWei: row.position!.costWei,
      realizedWei: "0",
      proceedsWei: "0",
      sells: 0,
    },
  };
  const holding = positionCardFigures(fromWallet(bought))!;
  assert.deepEqual(holding.hero, {
    label: "Unrealized PnL",
    value: "+36.24 ETH",
    eth: cardEthFigure(row.unrealizedWei!, true),
    tone: "text",
  });
  assert.equal(holding.realized, null);
  assert.equal(
    positionCardFigures(fromWallet({ ...bought, unrealizedWei: null }))!.hero
      .value,
    null,
  );
  // An open cycle's start that is not served gives no hold.
  assert.equal(
    positionCardFigures(
      fromWallet({ ...row, position: { ...row.position!, openedAt: null } }),
    )!.held,
    null,
  );
  // The single-position read's prices print exactly as served; its mark on a
  // closed position is the pool's, not the position's, and is left out.
  const priced = positionCardFigures({
    position: row,
    avgEntryPriceWei: "488980000000",
    mark: {
      sqrtPriceX96: "1",
      priceWei: "4868000000000",
      block: 1,
      timestamp: 1,
      txHash: `0x${"1".repeat(64)}`,
      valueWei: "40290106768115037953",
    },
  })!;
  assert.equal(text(priced.entry), "0.0₆4889 ETH");
  assert.equal(text(priced.mark), "0.0₅4868 ETH");
  const closedMark = positionCardFigures({
    position: audited.BCTC,
    avgEntryPriceWei: null,
    mark: {
      sqrtPriceX96: "1",
      priceWei: "4868000000000",
      block: 1,
      timestamp: 1,
      txHash: `0x${"1".repeat(64)}`,
      valueWei: "0",
    },
  })!;
  assert.equal(closedMark.mark, null);
});

test("position card with notional hidden keeps percentages, trade counts and prices only", () => {
  const priced = (row: AnalyticsWalletPosition): PositionCardSource => ({
    position: row,
    avgEntryPriceWei: "488980000000",
    mark: {
      sqrtPriceX96: "1",
      priceWei: "4868000000000",
      block: 1,
      timestamp: 1,
      txHash: `0x${"1".repeat(64)}`,
      valueWei: "40290106768115037953",
    },
  });
  const shown = positionCardFigures(priced(audited.HOOKR))!,
    hidden = positionCardFigures(priced(audited.HOOKR), false)!;
  assert.equal(shown.notional, true);
  assert.equal(hidden.notional, false);
  assert.deepEqual(hidden.hero, shown.hero);
  for (const amount of ["realized", "holding", "unrealized"] as const) {
    assert.notEqual(shown[amount], null, amount);
    assert.equal(hidden[amount], null, amount);
  }
  // Ratios, counts, the hold and the prices are not the wallet's size.
  for (const kept of [
    "unrealizedRoi",
    "multiple",
    "bars",
    "buys",
    "sells",
    "held",
    "entry",
    "mark",
    "open",
  ] as const)
    assert.deepEqual(hidden[kept], shown[kept], kept);
  // Before a first sale the headline is the unrealized ROI, not its amount.
  const bought = {
    ...audited.HOOKR,
    realizedWei: "0",
    position: {
      ...audited.HOOKR.position!,
      investedWei: audited.HOOKR.position!.costWei,
      realizedWei: "0",
      proceedsWei: "0",
      sells: 0,
    },
  };
  assert.deepEqual(positionCardFigures(fromWallet(bought), false)!.hero, {
    label: "Unrealized ROI",
    value: "+895.73%",
    eth: null,
    tone: "text",
  });
  assert.equal(
    positionCardFigures(fromWallet({ ...bought, unrealizedWei: null }), false)!
      .hero.value,
    null,
  );
});

test("a card in USD prints the page's own USD string for every amount and price it draws", () => {
  // `Money` and `Eth` in USD print formatMoney at the served rate, `Price`
  // prints usdPrice: the card converts the very wei its ETH figure holds.
  const usdPerEth = 2706.735;
  const pagePrice = (wei: string) => {
    const price = usdPrice(wei, usdPerEth);
    return price.form === "plain"
      ? price.text
      : `$0.0${subscript(price.zeros)}${price.digits}`;
  };
  const usd = (eth: CardEth | null) =>
    eth && cardMoneyText(cardMoney(eth, usdPerEth));
  const rows = [
    ...datasetPositions().map(({ row }) => row),
    ...Object.values(audited),
  ];
  let amounts = 0;
  for (const row of rows) {
    const card = positionCardFigures({
      position: row,
      avgEntryPriceWei: "488980000000",
      mark: {
        sqrtPriceX96: "1",
        priceWei: "4868000000000",
        block: 1,
        timestamp: 1,
        txHash: `0x${"1".repeat(64)}`,
        valueWei: "0",
      },
    });
    if (!card || !row.position) continue;
    // In ETH the card is unchanged: no rate, no conversion.
    for (const eth of [card.realized, card.unrealized, card.invested])
      if (eth) assert.equal(cardMoneyText(cardMoney(eth, null)), text(eth));
    if (card.realized)
      assert.equal(
        usd(card.realized),
        formatMoney(row.position.realizedWei!, "USD", usdPerEth, true),
      );
    if (card.unrealized)
      assert.equal(
        usd(card.unrealized),
        formatMoney(row.unrealizedWei!, "USD", usdPerEth, true),
      );
    assert.equal(
      usd(card.invested),
      formatMoney(row.position.investedWei, "USD", usdPerEth),
    );
    assert.equal(
      usd(card.proceeds),
      formatMoney(row.position.proceedsWei, "USD", usdPerEth),
    );
    if (card.entry) {
      assert.equal(usd(card.entry), pagePrice("488980000000"));
      assert.equal(usd(card.mark), pagePrice("4868000000000"));
    }
    amounts++;
  }
  assert.ok(amounts > 10, `${amounts} positions`);
  // The audited HOOKR position: the realized line the page's tile prints.
  const hookr = positionCardFigures(fromWallet(audited.HOOKR))!;
  assert.equal(usd(hookr.realized), "+$169,107.07");
  assert.equal(usd(hookr.unrealized), "+$98,102.45");
  assert.equal(usd(hookr.invested), "$12,058.50");
  // A price prints as `Price` does: four significant digits under a dollar.
  assert.equal(
    usd(
      positionCardFigures({
        position: audited.HOOKR,
        avgEntryPriceWei: "488980000000",
        mark: null,
      })!.entry,
    ),
    "$0.001324",
  );
  // The portfolio card's amounts convert the same way.
  const wallet = {
    realizedWei: "66223734506390192560",
    roi: 805.667,
  } as AnalyticsWalletSummary;
  const exportHero = cardExportHero(wallet)!;
  assert.equal(
    cardMoneyText(cardMoney(exportHero.eth, usdPerEth)),
    formatMoney(wallet.realizedWei!, "USD", usdPerEth, true),
  );
  assert.equal(
    cardMoneyText(cardMoney(exportHero.eth, usdPerEth)),
    "+$179,250.10",
  );
});

test("a card's line and hero sizes measure text as the card's own faces do", () => {
  const font = (file: string) =>
    fontAdvances(
      readFileSync(new URL(`../../public/fonts/${file}`, import.meta.url)),
    );
  const regular = font("Geist-Regular.ttf"),
    semibold = font("Geist-SemiBold.ttf"),
    width = (advances: Map<number, number>, text: string, size: number) =>
      ([...text].reduce((sum, g) => sum + advances.get(g.codePointAt(0)!)!, 0) *
        size) /
      1000;
  // The OPEN card's holding line that lost its closing parenthesis: 584.6 px
  // at 20 px in the card's 580 px column. Sized to fit, it ends inside it,
  // and the line beside today's figure (579.0 px) keeps the design's size.
  const line = "Still holding 8.27M HOOKR · +54.38 ETH unrealized (+1343.96%)";
  assert.equal(Math.round(width(regular, line, 20) * 10) / 10, 584.6);
  const size = cardLineSize(regular, line, 580, 20);
  assert.ok(size < 20);
  assert.ok(width(regular, line, size) <= 580);
  assert.ok(width(regular, line, size + 0.1) > 580);
  // A line that fits keeps the design's size; with no face, so does any.
  const today = "Still holding 8.27M HOOKR · +53.87 ETH unrealized (+1331.44%)";
  assert.equal(Math.round(width(regular, today, 20) * 10) / 10, 579);
  assert.equal(cardLineSize(regular, today, 580, 20), 20);
  assert.equal(cardLineSize(null, line, 580, 20), 20);
  // The export hero's table is the SemiBold face's own advances, "$" too.
  for (const hero of ["+$179,250.10", "-$1,546.02", "+66.22 ETH", "+$1.23M"])
    assert.equal(
      cardExportHeroSize(hero),
      Math.min(
        207,
        Math.floor(
          1040 / (width(semibold, hero, 1) - 0.045 * (hero.length - 1)),
        ),
      ),
      hero,
    );
});

test("a USD card converts at the rate the page showed, and only at one this server served", async (t) => {
  withIndexer(t, "https://index.example");
  let served = 2718.375,
    reads = 0,
    up = true;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return up
      ? Response.json({
          usdPerEth: served,
          asOf: new Date().toISOString(),
          source: "coinbase",
        })
      : Response.json({ error: "price_unavailable" }, { status: 503 });
  });
  t.mock.timers.enable({ apis: ["Date"], now: 1_790_830_000_000 });
  // No rate on the URL: the rate served now.
  assert.equal(await cardUsdPerEth(null), 2718.375);
  assert.equal(reads, 1);
  // The rate the page was shown, which this server passed on: no new read,
  // even once the read API has moved on.
  served = 2721.04;
  assert.equal(await cardUsdPerEth(2718.375), 2718.375);
  assert.equal(reads, 1);
  // A rate this server never served is not drawn: the card reads its own.
  assert.equal(await cardUsdPerEth(9999), 2721.04);
  assert.equal(reads, 2);
  // Past its lifetime a served rate is read again, never kept.
  t.mock.timers.tick(servedEthRateLifetimeMs + 1);
  assert.equal(await cardUsdPerEth(2718.375), 2721.04);
  assert.equal(reads, 3);
  // And with no rate served, there is none: the card falls back to ETH.
  t.mock.timers.tick(servedEthRateLifetimeMs + 1);
  up = false;
  assert.equal(await cardUsdPerEth(2721.04), null);
  assert.equal(await cardUsdPerEth(null), null);
  withIndexer(t);
  assert.equal(await cardUsdPerEth(null), null);
});

test("position card chart keeps real candles, both ends and only served levels", () => {
  assert.equal(positionCardChart([], null, null, 458, 244), null);
  assert.equal(
    positionCardChart([{ time: 0, close: "1" }], null, null, 458, 244),
    null,
  );
  // Prices past 2^53 wei are compared as integers, never as floats.
  const candles = Array.from({ length: 1000 }, (_, i) => ({
    time: 3600 * i,
    close: String(10n ** 60n + BigInt(i)),
  }));
  const chart = positionCardChart(candles, null, null, 458, 244)!;
  assert.equal(chart.points.length, 240);
  assert.deepEqual(chart.points[0], [0, 244]);
  assert.deepEqual(chart.points.at(-1), [458, 0]);
  assert.equal(chart.entryY, null);
  assert.equal(chart.markY, null);
  const levels = positionCardChart(
    candles,
    String(10n ** 60n - 999n),
    candles.at(-1)!.close,
    458,
    244,
  )!;
  assert.equal(levels.entryY, 244);
  assert.equal(levels.markY, 0);
  assert.equal(levels.points[0][1], 122);
});

test("a position card's URL carries only the options its image honours", () => {
  const scope = { pool: audited.HOOKR.poolId, launch: audited.HOOKR.launchTx };
  const query = cardQuery(
    {
      window: "7d",
      preset: "amber",
      design: "export",
      anonymous: true,
      notional: false,
      unit: "ETH",
      usdPerEth: null,
    },
    scope,
  );
  assert.equal(
    query.toString(),
    `pool=${scope.pool}&launch=${scope.launch}&theme=amber&anon=1&design=export`,
  );
  assert.equal(
    cardUrl(
      audited.HOOKR.position!.trader,
      parseCardOptions(new URLSearchParams(scope)),
      scope,
    ),
    `/cards/${audited.HOOKR.position!.trader}.png?pool=${scope.pool}&launch=${scope.launch}`,
  );
});

test("a history cursor the read API refuses crosses the proxy as invalid_cursor, not an outage", async (t) => {
  const prior = process.env.INDEXER_API_URL;
  process.env.INDEXER_API_URL = "https://index.example";
  t.after(() => {
    if (prior === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = prior;
  });
  const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
  const read = () =>
    readWalletTradeHistory(
      ["wallets", wallet, "history"],
      new URLSearchParams("kind=trades&cursor=v1cursor"),
    );
  const answer = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "invalid_cursor" }, { status: 400 }),
  );
  await assert.rejects(read, (e: unknown) => e instanceof InvalidHistoryCursorError);
  /* Any other refusal keeps the shared unavailable handling. */
  for (const reason of ["budget_exhausted", "upstream_unavailable"]) {
    answer.mock.mockImplementation(async () =>
      Response.json(
        { error: "wallet_history_unavailable", reason },
        { status: 503, headers: { "Retry-After": "30" } },
      ),
    );
    await assert.rejects(read, (e: unknown) => e instanceof ProductUnavailableError);
  }
  answer.mock.mockImplementation(async () =>
    Response.json({ error: "invalid_request" }, { status: 400 }),
  );
  await assert.rejects(read, (e: unknown) => e instanceof ProductUnavailableError);
});
