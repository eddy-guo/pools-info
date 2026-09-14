import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalyticsModel,
  exploreAnalytics,
  leaderboardAnalytics,
  walletAnalytics,
  poolAnalytics,
  searchAnalytics,
} from "./analytics";
import { foldTrades } from "./accounting";
import type { AnalyticsPublication } from "./analytics-types";
import type { CatalogPool } from "./catalog";
import type { Trade } from "./types";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const alice = address(0xaaaa),
  bob = address(0xbbbb);
function publication(
  id: number,
  owner: string,
  amounts: ["buy" | "sell", string, string, number][],
): AnalyticsPublication {
  const trades: Trade[] = amounts.map(
    ([side, ethWei, tokenRaw, timestamp], i) => ({
      id: `${id}:${i}`,
      poolId: word(id),
      trader: owner as `0x${string}`,
      txHash: word(id * 100 + i),
      logIndex: i,
      block: 100 + i,
      timestamp,
      side,
      ethWei,
      tokenRaw,
    }),
  );
  const position = foldTrades(trades);
  const market = {
    id: word(id),
    token: address(id),
    name: "Token " + id,
    symbol: "T" + id,
    decimals: 0,
    supply: "100000",
    launchBlock: 100,
    launchedAt: 100,
    launchTx: word(id * 10),
    launchSender: address(999),
    positionRecipient: address(999),
    strategy: address(9),
    creatorFees: false,
    fee: 100,
    priceWei: "2",
    volumeWei: trades.reduce((n, t) => n + BigInt(t.ethWei), 0n).toString(),
    swaps: trades.length,
    buys: position.buys,
    sells: position.sells,
    series: [
      { time: 100, wei: "1" },
      { time: 10000, wei: "2" },
    ],
    accounting: {
      executions: trades.map((trade) => ({
        trade,
        flags: [],
        matchedTransfer: null,
      })),
      wallets: [
        {
          address: owner,
          swaps: trades.length,
          buys: position.buys,
          sells: position.sells,
          volumeWei: "0",
          realizedWei: position.realizedWei,
          inventoryRaw: position.quantity,
          balanceRaw: position.quantity,
          balanceMatches: true,
          eligible: trades.length >= 10,
          flags: position.flags,
          evidenceTx: trades[0].txHash,
        },
      ],
      unattributedSwaps: 0,
      transfersChecked: trades.length,
    },
  };
  return {
    sourceKind: "rpc_capture",
    liquidityWei: null,
    holders: null,
    generatedAt: "2026-09-15T00:00:00Z",
    snapshot: {
      schemaVersion: 1,
      chainId: 4663,
      generatedAt: "2026-09-15T00:00:00Z",
      fromBlock: 100,
      toBlock: 200,
      fromTimestamp: 100,
      toTimestamp: 10000,
      blockHash: word(200),
      discoveredLaunches: 1,
      markets: [market],
      trades: trades.map((t) => ({ ...t })),
      requests: 0,
      durationMs: 0,
      reconciliation: null,
    },
  };
}
const catalog = (p: AnalyticsPublication): CatalogPool => p.snapshot.markets[0];
test("same wallet aggregates exact supported positions, excludes unknown basis and sorts before pagination", () => {
  const p1 = publication(1, alice, [
    ["buy", "90071992547409930000", "100", 1000],
    ["sell", "90071992547409930100", "100", 9000],
  ]);
  const p2 = publication(2, alice.toUpperCase().replace("0X", "0x"), [
    ["buy", "100", "100", 1000],
    ["sell", "60", "100", 9001],
  ]);
  const p3 = publication(3, alice, [["sell", "999999999999", "100", 9000]]);
  const p4 = publication(4, bob, [
    ["buy", "100", "100", 1000],
    ["sell", "150", "100", 9000],
  ]);
  const unpublished = { ...catalog(p1), id: word(5), token: address(5) };
  const model = buildAnalyticsModel(
    [...[p1, p2, p3, p4].map(catalog), unpublished],
    [p1, p2, p3, p4],
  );
  const result = leaderboardAnalytics(model, { minTrades: 0, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].address, alice);
  assert.equal(result.items[0].realizedWei, "60");
  assert.equal(result.items[0].excludedPositionCount, 1);
  assert.equal(result.items[0].supportedPositionCount, 2);
  assert.equal(
    leaderboardAnalytics(model, { minTrades: 0, limit: 1, offset: 1 }).items[0]
      .address,
    bob,
  );
  assert.equal(leaderboardAnalytics(model, { minTrades: 5 }).total, 0); // Excluded trades do not pass the gate.
  const profile = walletAnalytics(model, alice, "1h");
  assert.equal(profile.wallet.realizedWei, "60"); // Earlier buys still supply sell basis.
  assert.equal(profile.wallet.netWei, "90071992547409930160");
  assert.equal(profile.positions.length, 3);
  assert.equal(profile.positions.find((p) => !p.supported)!.position, null);
  assert.equal(profile.curve.at(-1)!.wei, "60");
  const explore = exploreAnalytics(model, { sort: "volume", limit: 1 });
  assert.equal(explore.items[0].id, word(1));
  assert.equal(explore.total, 5);
  const watchlist = exploreAnalytics(model, {
    view: "watchlist",
    ids: [word(4)],
    limit: 1,
  });
  assert.equal(watchlist.items[0].id, word(4));
  assert.equal(exploreAnalytics(model, { view: "crowd" }).items.length, 0);
  assert.equal(
    exploreAnalytics(model, { sort: "volume", offset: 4 }).items[0].processed,
    false,
  );
  assert.equal(model.coverage.processedPools, 4);
  assert.equal(model.coverage.complete, false);
  assert.equal(poolAnalytics(model, word(5)), null);
});

test("default leaderboard rank and wallet card rank agree after cross-pool trade gate", () => {
  const rounds = (
    proceeds: string,
  ): ["buy" | "sell", string, string, number][] =>
    Array.from(
      { length: 3 },
      (_, i) =>
        [
          ["buy", "100", "10", 1000 + i * 2],
          ["sell", proceeds, "10", 1001 + i * 2],
        ] as ["buy" | "sell", string, string, number][],
    ).flat();
  const one = publication(1, alice, rounds("110")),
    two = publication(2, alice, rounds("120"));
  const model = buildAnalyticsModel([catalog(one), catalog(two)], [one, two]);
  assert.equal(leaderboardAnalytics(model).items[0].supportedTradeCount, 12);
  assert.equal(walletAnalytics(model, alice).wallet.rank, 1);
  assert.equal(
    walletAnalytics(model, alice).wallet.realizedWei,
    leaderboardAnalytics(model).items[0].realizedWei,
  );
});

test("unprocessed catalog and stored-wallet search work without RPC; missing marks remain null", async () => {
  const one = publication(1, alice, [["buy", "100", "100", 1000]]);
  one.snapshot.markets[0].priceWei = null;
  const extra = {
    ...catalog(one),
    id: word(2),
    token: address(2),
    name: "Unprocessed Banana",
    symbol: "BAN",
  };
  const model = buildAnalyticsModel([catalog(one), extra], [one]);
  assert.equal(walletAnalytics(model, alice).wallet.unrealizedWei, null);
  const result = await searchAnalytics(model, "banana");
  assert(result.entries.some((e) => e.address === extra.token));
  const wallet = await searchAnalytics(model, alice, "Wallets");
  assert(wallet.entries.some((e) => e.address === alice));
  assert.equal(
    wallet.entries.find((e) => e.group === "Wallets")?.href,
    `/wallet/${alice}/?window=All`,
  );
});

test("duplicate captures cannot inflate volume, net flows or a wallet trade gate", () => {
  const p = publication(1, alice, [
    ["buy", "100", "100", 1000],
    ["sell", "150", "100", 2000],
  ]);
  p.snapshot.markets[0].accounting!.executions!.push(
    structuredClone(p.snapshot.markets[0].accounting!.executions![1]),
  );
  p.snapshot.trades.push(structuredClone(p.snapshot.trades[1]));
  const model = buildAnalyticsModel([catalog(p)], [p]);
  const result = walletAnalytics(model, alice);
  assert.equal(result.wallet.supportedTradeCount, 2);
  assert.equal(result.wallet.volumeWei, "250");
  assert.equal(result.wallet.netWei, "50");
  assert.equal(result.wallet.roi, 50);
  assert.equal(leaderboardAnalytics(model, { minTrades: 3 }).items.length, 0);
  assert.equal(exploreAnalytics(model).items[0].stats.volumeWei, "250");
});

test("mixed cutoffs stay explicit and conflicting log identities are rejected", () => {
  const old = publication(1, alice, [
    ["buy", "100", "100", 1000],
    ["sell", "150", "100", 9000],
  ]);
  const fresh = publication(2, bob, [
    ["buy", "100", "100", 1000],
    ["sell", "180", "100", 19000],
  ]);
  fresh.snapshot.toTimestamp = 20000;
  fresh.snapshot.toBlock = 300;
  fresh.snapshot.blockHash = word(300);
  const model = buildAnalyticsModel(
    [catalog(old), catalog(fresh)],
    [old, fresh],
  );
  const wallet = walletAnalytics(model, alice);
  assert.equal(wallet.coverage.asOf, 20000);
  assert.equal(wallet.wallet.asOf, 10000);
  assert.equal(wallet.wallet.oldestAsOf, 10000);
  assert.equal(wallet.wallet.completeWindow, false);
  assert.equal(wallet.wallet.realizedWei, "50");
  assert.equal(walletAnalytics(model, alice, "1h").wallet.realizedWei, "0");
  assert.equal(
    walletAnalytics(model, alice, "1h").wallet.completeWindow,
    false,
  );
  const duplicate = structuredClone(old.snapshot.trades[0]);
  duplicate.ethWei = "999";
  old.snapshot.trades.push(duplicate);
  assert.throws(
    () => buildAnalyticsModel([catalog(old)], [old]),
    /Conflicting analytics trade/,
  );
});
