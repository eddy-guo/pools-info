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
