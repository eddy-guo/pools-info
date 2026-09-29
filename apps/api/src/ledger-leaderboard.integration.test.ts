import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ledgerExcludingFlags,
  type AnalyticsLeaderboardResponse,
  type AnalyticsWalletResponse,
  type AnalyticsWalletSummary,
  type ExcludedPositionsByFlag,
  type SearchResponse,
  type LedgerSwap,
  type LedgerTransfer,
} from "@pools/core";
import {
  acquireLedgerWriter,
  applyLedgerBatch,
  commitBatch,
  createClient,
  ensureDiscovery,
  ensureLedgerStream,
  ledgerRules,
  ledgerStream,
  ledgerWindowPolicy,
  migrate,
  observeLedgerHead,
  refreshLedgerWindows,
  releaseLedgerWriter,
  type LedgerBatch,
} from "../../../packages/db/src/index";
import { walletSummary } from "./accounting-read";
import { createCreditBudget } from "./blockscout-client";
import { ledgerLeaderboardPolicy } from "./ledger-leaderboard";
import { createReader } from "./reader";
import { createApi } from "./server";
import {
  createContractCensus,
  createWalletCodeStore,
} from "./trader-contracts";

// The board is served from the windows the ledger's own writer folds and
// refreshes, so the fixture is trades applied through `applyLedgerBatch` and
// `refreshLedgerWindows`, and every expectation below is derived by hand
// from those trades: average-cost basis, realized = proceeds - disposed
// cost, a closure when the inventory returns to zero, hour-aligned windows.
const E = 10n ** 18n;
const hash = (n: number | bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = ledgerStream.start;
/** 400 seconds per block, nine blocks to the hour, block `base` opening hour
 * 278: `blockOf(h, i)` is the i-th block of UTC hour h. */
const ts = (block: number) => 278 * 3600 + (block - base) * 400;
const blockOf = (hour: number, i: number) => base + (hour - 278) * 9 + i;
const pools = {
  P: {
    id: hash(0x100),
    token: addr(0x200),
    name: "Pool P",
    symbol: "P",
    launchBlock: 10,
    launchTx: hash(101),
    launchSender: addr(0x201),
    launchedAt: 100,
  },
  Q: {
    id: hash(0x101),
    token: addr(0x202),
    name: "Pool Q",
    symbol: "Q",
    launchBlock: 11,
    launchTx: hash(102),
    launchSender: addr(0x201),
    launchedAt: 100,
  },
};
const wallet = (n: number) => addr(0x10000 + n);
const W = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => [n, wallet(n)]),
) as Record<number, string>;
/** The batch-sell contract: it sells what its callers pooled in one swap. */
const BATCH = wallet(15);

/** A batch's rows: each trade is a swap and its manager transfer in its own
 * transaction, initiated by the wallet through the router. */
class Rows {
  swaps: LedgerSwap[] = [];
  transfers: LedgerTransfer[] = [];
  private logs = new Map<number, number>();
  trade(
    block: number,
    who: string,
    side: "buy" | "sell",
    eth: bigint,
    tokens: bigint,
    pool = pools.P,
  ) {
    const i = this.logs.get(block) ?? 0;
    this.logs.set(block, i + 2);
    const site = {
      txHash: hash(BigInt(block) * 100000n + BigInt(i)),
      block,
      blockHash: hash(block),
      timestamp: ts(block),
    };
    this.swaps.push({
      ...site,
      logIndex: i,
      poolId: pool.id,
      token: pool.token,
      initiator: who,
      txTo: ledgerRules.router,
      side,
      ethWei: eth.toString(),
      tokenRaw: tokens.toString(),
      sqrtPriceX96: "1000",
      liquidity: "5",
      tick: 1,
    });
    this.transfers.push({
      ...site,
      logIndex: i + 1,
      token: pool.token,
      from: side === "buy" ? ledgerRules.manager : who,
      to: side === "buy" ? who : ledgerRules.manager,
      value: tokens.toString(),
    });
    return this;
  }
  /** `n` round trips in one block: buy 10 tokens for 1 ETH, sell them for
   * 1 ETH plus `gain` (negative for a loss), each closing a cycle held 0 s. */
  roundTrips(block: number, who: string, n: number, gain: bigint) {
    for (let i = 0; i < n; i++)
      this.trade(block, who, "buy", E, 10n).trade(
        block,
        who,
        "sell",
        E + gain,
        10n,
      );
    return this;
  }
  /** A plain transfer between wallets, no swap in its transaction. */
  move(block: number, from: string, to: string, tokens: bigint) {
    const i = this.logs.get(block) ?? 0;
    this.logs.set(block, i + 1);
    this.transfers.push({
      txHash: hash(BigInt(block) * 100000n + BigInt(i)),
      logIndex: i,
      block,
      blockHash: hash(block),
      timestamp: ts(block),
      token: pools.P.token,
      from,
      to,
      value: tokens.toString(),
    });
    return this;
  }
  /** A pooled sell in one transaction: each contributor sends its tokens to
   * the batch contract, which sells the lot to the manager in one swap it
   * initiates. No address's net movement covers the swap (the contract
   * nets to zero), so the ledger leaves it unattributed and excludes every
   * contributor's position with `unattributed_swap_activity`. */
  pooledSell(
    block: number,
    contributors: (readonly [string, bigint])[],
    eth: bigint,
    pool = pools.P,
  ) {
    const i = this.logs.get(block) ?? 0;
    const total = contributors.reduce((n, [, tokens]) => n + tokens, 0n);
    this.logs.set(block, i + contributors.length + 2);
    const site = {
      txHash: hash(BigInt(block) * 100000n + BigInt(i)),
      block,
      blockHash: hash(block),
      timestamp: ts(block),
    };
    contributors.forEach(([who, tokens], k) =>
      this.transfers.push({
        ...site,
        logIndex: i + k,
        token: pool.token,
        from: who,
        to: BATCH,
        value: tokens.toString(),
      }),
    );
    this.transfers.push({
      ...site,
      logIndex: i + contributors.length,
      token: pool.token,
      from: BATCH,
      to: ledgerRules.manager,
      value: total.toString(),
    });
    this.swaps.push({
      ...site,
      logIndex: i + contributors.length + 1,
      poolId: pool.id,
      token: pool.token,
      initiator: BATCH,
      txTo: BATCH,
      side: "sell",
      ethWei: eth.toString(),
      tokenRaw: total.toString(),
      sqrtPriceX96: "1000",
      liquidity: "5",
      tick: 1,
    });
    return this;
  }
}
function batch(from: number, to: number, rows: Rows): LedgerBatch {
  return {
    from,
    to,
    parentHash: hash(from - 1),
    hash: hash(to),
    timestamp: ts(to),
    archiveHeight: to + ledgerStream.confirmations,
    registryPools: 2,
    query: { fixture: [from, to] },
    pages: [],
    requests: 1,
    bytes: 0,
    launches: [],
    swaps: rows.swaps,
    transfers: rows.transfers,
  };
}
const normalized = (body: string) =>
  body.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"-"');
const tenth = E / 10n;
/** The breakdown every ledger-served row carries: one count per excluding
 * flag, zero unless named. */
const byFlag = (
  counts: Partial<ExcludedPositionsByFlag> = {},
): ExcludedPositionsByFlag => ({
  zero_cost_inflow: 0,
  unattributed_outflow: 0,
  unknown_basis: 0,
  unattributed_swap_activity: 0,
  ...counts,
});

test(
  "Postgres HTTP: MARKET_SOURCE=ledger serves the trader leaderboard from the ledger's windows, hand-checked per window, and the accounting board until the ledger has folded anything",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    // The reader's own constants are the writer's: the eligibility gate the
    // partial index carries and the ranked depth.
    assert.deepEqual(
      { ...ledgerLeaderboardPolicy },
      {
        minTrades: ledgerWindowPolicy.minTrades,
        rankedWallets: ledgerWindowPolicy.rankedWallets,
      },
    );
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema = "api_test_ledgerboard_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    await commitBatch(db, await ensureDiscovery(db, 10), {
      from: 10,
      to: 19,
      hash: hash(19),
      evidence: {},
      pools: [pools.P, pools.Q],
    });
    const readers = {
      broad: createReader(url, schema),
      ledger: createReader(url, schema, { marketSource: "ledger" }),
    };
    const bases: Record<string, string> = {};
    const servers: ReturnType<typeof createApi>[] = [];
    for (const [name, reader] of Object.entries(readers)) {
      const api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      bases[name] =
        `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      servers.push(api);
    }
    let locked = false;
    t.after(async () => {
      for (const api of servers)
        await new Promise<void>((resolve) => api.close(() => resolve()));
      for (const reader of Object.values(readers)) await reader.close();
      if (locked) await releaseLedgerWriter(db);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    const fetchText = async (source: "broad" | "ledger", path: string) => {
      const response = await fetch(bases[source] + path);
      return { status: response.status, body: await response.text() };
    };
    const get = async (source: "broad" | "ledger", path: string) => {
      const { status, body } = await fetchText(source, path);
      return { status, data: JSON.parse(body) };
    };
    const board = async (query: string) => {
      const { status, data } = await get("ledger", `/v1/leaderboard?${query}`);
      assert.equal(status, 200, `${query} ${JSON.stringify(data)}`);
      return data as AnalyticsLeaderboardResponse;
    };
    const order = (b: AnalyticsLeaderboardResponse) =>
      b.items.map((i) => [i.address, i.rank]);
    const paths = ["24h", "7d", "30d", "All"].flatMap((window) => [
      `/v1/leaderboard?window=${window}`,
      `/v1/leaderboard?window=${window}&metric=net&limit=100`,
    ]);

    // With no ledger at all, and then with a stream but no cursor, the
    // ledger source answers byte for byte as the broad source (the
    // accounting tables, empty here).
    const sameAsBroad = async () => {
      for (const path of paths) {
        const [broad, ledger] = [
          await fetchText("broad", path),
          await fetchText("ledger", path),
        ];
        assert.equal(broad.status, 200, `${path} ${broad.body}`);
        assert.equal(normalized(ledger.body), normalized(broad.body), path);
      }
    };
    await sameAsBroad();
    // Freshness (ledger-freshness.ts): the broad source has no ledger to
    // measure; the ledger source is unhealthy without one, and still so with
    // a stream the pass has not started.
    assert.deepEqual(await get("broad", "/health"), {
      status: 200,
      data: { ok: true, ledger: null },
    });
    assert.equal((await get("broad", "/v1/status")).data.ledger, null);
    const missing = { ok: false, reason: "ledger_missing", ledger: null };
    assert.deepEqual(await get("ledger", "/health"), {
      status: 503,
      data: missing,
    });
    assert.equal((await get("ledger", "/v1/status")).data.ledger, null);
    await ensureLedgerStream(db, "tip");
    await sameAsBroad();
    assert.deepEqual((await get("ledger", "/health")).data, missing);
    // The ledger writer lock is one per database; a sibling test file may
    // hold it.
    for (let i = 0; i < 600 && !locked; i++) {
      locked = await acquireLedgerWriter(db);
      if (!locked) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(locked, "ledger writer lock unavailable");

    // The cursor sits mid-hour in hour 1078, so the windows are the whole
    // hours 1055-1078 (24h), 911-1078 (7d), 359-1078 (30d) and everything
    // since hour 278 (All). Amounts in tenths of an ETH.
    const cursor1 = blockOf(1078, 4);
    const rows = new Rows()
      // W1 carries basis across the 24h boundary: 10 tokens bought for 1 ETH
      // in hour 1050 (outside 24h, inside 7d), sold for 1.5 ETH in hour 1060
      // (inside 24h), then five 0.1 ETH round trips in hour 1070.
      .trade(blockOf(1050, 0), W[1], "buy", E, 10n)
      .trade(blockOf(1060, 0), W[1], "sell", 15n * tenth, 10n)
      .roundTrips(blockOf(1070, 0), W[1], 5, tenth)
      // W2 trades inside 7d only; W3 inside 30d only; W4 in All only.
      .roundTrips(blockOf(1000, 0), W[2], 6, 2n * tenth)
      .roundTrips(blockOf(500, 0), W[3], 5, 3n * tenth)
      .roundTrips(blockOf(300, 0), W[4], 5, 4n * tenth)
      // W5 realizes the most of anyone over eight trades: under the gate.
      .roundTrips(blockOf(1072, 0), W[5], 4, E)
      // W6 has a supported position in P and sells 7 Q tokens it never
      // bought: that position is excluded, its finances never count.
      .roundTrips(blockOf(1071, 0), W[6], 5, tenth / 2n)
      .trade(blockOf(1071, 1), W[6], "sell", 9n * tenth, 7n, pools.Q)
      // W7 and W8 tie on realized: the lower address ranks first.
      .roundTrips(blockOf(1065, 0), W[7], 5, (15n * tenth) / 10n)
      .roundTrips(blockOf(1065, 1), W[8], 5, (15n * tenth) / 10n)
      // W9 closes four winning and one losing cycle.
      .roundTrips(blockOf(1074, 0), W[9], 4, tenth)
      .roundTrips(blockOf(1074, 1), W[9], 1, -2n * tenth)
      // W10 trades in hour 1055, the first hour of the 24h window.
      .roundTrips(blockOf(1055, 0), W[10], 5, (12n * tenth) / 10n)
      // W12 buys 100 tokens for 1 ETH and sends 90 to W11, which sells them
      // in ten sales of 1 ETH each: 10 ETH of proceeds on no basis of its
      // own, the most of anyone, on a position excluded on arrival; the
      // transfer excludes W12's position on departure.
      .trade(blockOf(1073, 0), W[12], "buy", E, 100n)
      .move(blockOf(1073, 1), W[12], W[11], 90n);
    for (let i = 0; i < 10; i++)
      rows.trade(blockOf(1073, 2), W[11], "sell", E, 9n);
    // W13 clears the gate on five 0.01 ETH trips in P, then buys Q and sells
    // it together with W14 through the batch contract in one transaction: no
    // address's net movement covers that swap, so the ledger leaves it
    // unattributed and excludes both Q positions
    // (unattributed_swap_activity). W13's row keeps its P figures and stands
    // last on every board; W14, with its one buy, stands on none.
    rows
      .roundTrips(blockOf(1076, 0), W[13], 5, tenth / 10n)
      .trade(blockOf(1076, 1), W[13], "buy", E, 10n, pools.Q)
      .trade(blockOf(1076, 1), W[14], "buy", 5n * tenth, 5n, pools.Q)
      .pooledSell(
        blockOf(1076, 2),
        [
          [W[13], 10n],
          [W[14], 5n],
        ],
        15n * tenth,
        pools.Q,
      );
    const applied = await applyLedgerBatch(db, batch(base, cursor1, rows));
    assert.equal(applied.unattributed, 1);
    // A committed batch is fresh: its cursor and time, an unknown lag until
    // the collector observes a head, then the lag against that head; the
    // status route carries the same object.
    const health = await get("ledger", "/health");
    assert.equal(health.status, 200, JSON.stringify(health.data));
    assert.equal(health.data.ok, true);
    assert.ok(
      health.data.ledger.ageSeconds < 60,
      health.data.ledger.ageSeconds,
    );
    assert.match(health.data.ledger.indexedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.deepEqual(
      { ...health.data.ledger, ageSeconds: 0, indexedAt: "-" },
      {
        cursorBlock: cursor1,
        cursorTimestamp: ts(cursor1),
        headBlock: null,
        headTimestamp: null,
        lagBlocks: null,
        lagSeconds: null,
        indexedAt: "-",
        checkedAt: null,
        ageSeconds: 0,
        staleAfterSeconds: 600,
        stale: false,
      },
    );
    await observeLedgerHead(db, cursor1 + 128, ts(cursor1 + 128));
    const observed = await get("ledger", "/health");
    assert.deepEqual(
      [
        observed.data.ledger.headBlock,
        observed.data.ledger.headTimestamp,
        observed.data.ledger.lagBlocks,
        observed.data.ledger.lagSeconds,
        typeof observed.data.ledger.checkedAt,
      ],
      [cursor1 + 128, ts(cursor1 + 128), 128, 128 * 400, "string"],
    );
    const status = await get("ledger", "/v1/status");
    assert.deepEqual(
      { ...status.data.ledger, ageSeconds: 0 },
      { ...observed.data.ledger, ageSeconds: 0 },
    );
    // Folded but not yet refreshed into windows: the board has nothing to
    // stand on and says so, retryably, rather than serving the old tables.
    const pending = await get("ledger", "/v1/leaderboard?window=7d");
    assert.deepEqual(pending, {
      status: 503,
      data: { error: "leaderboard_refresh_pending" },
    });
    assert.ok(await refreshLedgerWindows(db));

    // Membership and order per window: realized descending, the address
    // breaking W7/W8's tie, W5 under the gate on every board.
    const day = await board("window=24h&limit=100");
    assert.deepEqual(order(day), [
      [W[1], 1],
      [W[7], 2],
      [W[8], 3],
      [W[10], 4],
      [W[6], 5],
      [W[9], 6],
      [W[13], 7],
    ]);
    assert.deepEqual(order(await board("window=7d&limit=100")), [
      [W[2], 1],
      [W[1], 2],
      [W[7], 3],
      [W[8], 4],
      [W[10], 5],
      [W[6], 6],
      [W[9], 7],
      [W[13], 8],
    ]);
    assert.deepEqual(order(await board("window=30d&limit=100")), [
      [W[3], 1],
      [W[2], 2],
      [W[1], 3],
      [W[7], 4],
      [W[8], 5],
      [W[10], 6],
      [W[6], 7],
      [W[9], 8],
      [W[13], 9],
    ]);
    const all = await board("window=All&limit=100");
    assert.deepEqual(order(all), [
      [W[4], 1],
      [W[3], 2],
      [W[2], 3],
      [W[1], 4],
      [W[7], 5],
      [W[8], 6],
      [W[10], 7],
      [W[6], 8],
      [W[9], 9],
      [W[13], 10],
    ]);
    // W11's ten sales are trades and volume, never supported trades, wins
    // or a realized figure: a zero-cost inflow excludes the position, so it
    // stands on no board under any gate or metric; W12, which sent the
    // tokens, is excluded by the same transfer (unattributed_outflow) and
    // stands on none either, whatever the gate.
    const farm = (
      await db.query(
        `SELECT x.realized_wei::text AS realized,x.disposed_cost_wei::text AS disposed,x.volume_wei::text AS volume,x.trades,
           x.supported_trades,x.wins,x.supported_positions,x.excluded_positions,x.rank
         FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref) WHERE x."window"='24h' AND w.address=decode($1,'hex')`,
        [W[11].slice(2)],
      )
    ).rows[0];
    assert.deepEqual(farm, {
      realized: "0",
      disposed: "0",
      volume: (10n * E).toString(),
      trades: 10,
      supported_trades: 0,
      wins: 0,
      supported_positions: 0,
      excluded_positions: 1,
      rank: null,
    });
    for (const query of [
      "window=24h&limit=100",
      "window=All&limit=100",
      "window=24h&metric=net&limit=100",
      "window=24h&minTrades=0&limit=100",
      "window=24h&minTrades=1&metric=net&limit=100",
    ]) {
      const items = (await board(query)).items;
      assert.ok(
        !items.some((i) => i.address === W[11] || i.address === W[12]),
        `${query}: ${JSON.stringify(items.map((i) => i.address))}`,
      );
    }
    const sender = (
      await db.query(
        `SELECT x.realized_wei::text AS realized,x.disposed_cost_wei::text AS disposed,x.volume_wei::text AS volume,x.trades,
           x.supported_trades,x.supported_positions,x.excluded_positions,x.rank,p.flags
         FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref) JOIN agg_positions p USING (wallet_ref)
         WHERE x."window"='24h' AND w.address=decode($1,'hex')`,
        [W[12].slice(2)],
      )
    ).rows[0];
    assert.deepEqual(sender, {
      realized: "0",
      disposed: "0",
      volume: E.toString(),
      trades: 1,
      supported_trades: 0,
      supported_positions: 0,
      excluded_positions: 1,
      rank: null,
      flags: ["unattributed_outflow"],
    });
    for (const [b, total] of [
      [day, 7],
      [all, 10],
    ] as const) {
      assert.equal(b.total, total);
      assert.equal(b.nextOffset, null);
      assert.equal(b.minTrades, 10);
      assert.equal(b.metric, "realized");
    }
    // The response's fields are the accounting board's, field for field.
    assert.deepEqual(Object.keys(day).sort(), [
      "coverage",
      "items",
      "metric",
      "minTrades",
      "nextOffset",
      "total",
      "window",
    ]);
    for (const item of day.items)
      assert.deepEqual(
        Object.keys(item).sort(),
        Object.keys(walletSummary(undefined, item.address)).sort(),
      );
    assert.deepEqual(
      { ...day.coverage, generatedAt: "-" },
      {
        catalogPools: 2,
        processedPools: 2,
        asOf: ts(cursor1),
        oldestAsOf: ts(cursor1),
        generatedAt: "-",
        complete: false,
        registryExhaustive: false,
        pnlScope: "attributed_positions_all_pools",
      },
    );

    // W1's 24h row: the 1.5 ETH sale disposes the 1 ETH bought before the
    // window, so realized is 0.5 + 5 x 0.1 = 1.0 ETH over 6 ETH of disposed
    // cost, while net counts the window's own cash flows only: 7.0 ETH out
    // for 5 ETH in. Its one held cycle lasted the ten hours from the buy to
    // the sale, the five others 0 s.
    const item = (b: AnalyticsLeaderboardResponse, address: string) =>
      b.items.find((i) => i.address === address)!;
    const w1 = (rank: number, inWindow: boolean) =>
      ({
        address: W[1],
        rank,
        realizedWei: E.toString(),
        netWei: (inWindow ? 2n * E : E).toString(),
        unrealizedWei: null,
        volumeWei: (inWindow ? 12n * E : 13n * E).toString(),
        roi: 16.6666,
        wins: 6,
        losses: 0,
        winRate: 100,
        tradeCount: inWindow ? 11 : 12,
        supportedTradeCount: inWindow ? 11 : 12,
        supportedPositionCount: 1,
        excludedPositionCount: 0,
        excludedByFlag: byFlag(),
        bestWei: (5n * tenth).toString(),
        avgHold: 36000 / 6,
        last: ts(blockOf(1070, 0)),
        asOf: ts(cursor1),
        oldestAsOf: ts(cursor1),
        completeWindow: true,
      }) satisfies AnalyticsWalletSummary;
    assert.deepEqual(item(day, W[1]), w1(1, true));
    assert.deepEqual(item(all, W[1]), w1(4, false));
    // W6: five 0.05 ETH trips in P count, the excluded Q sale counts only as
    // a trade and its 0.9 ETH as volume.
    assert.deepEqual(item(day, W[6]), {
      address: W[6],
      rank: 5,
      realizedWei: ((25n * tenth) / 10n).toString(),
      netWei: ((25n * tenth) / 10n).toString(),
      unrealizedWei: null,
      volumeWei: ((1115n * tenth) / 10n).toString(),
      roi: 5,
      wins: 5,
      losses: 0,
      winRate: 100,
      tradeCount: 11,
      supportedTradeCount: 10,
      supportedPositionCount: 1,
      excludedPositionCount: 1,
      excludedByFlag: byFlag({ unknown_basis: 1 }),
      bestWei: (tenth / 2n).toString(),
      avgHold: 0,
      last: ts(blockOf(1071, 1)),
      asOf: ts(cursor1),
      oldestAsOf: ts(cursor1),
      completeWindow: true,
    } satisfies AnalyticsWalletSummary);
    // W9: 4 x 0.1 - 0.2 = 0.2 ETH over 5 ETH disposed, 4 wins to 1 loss.
    assert.deepEqual(item(day, W[9]), {
      address: W[9],
      rank: 6,
      realizedWei: (2n * tenth).toString(),
      netWei: (2n * tenth).toString(),
      unrealizedWei: null,
      volumeWei: (102n * tenth).toString(),
      roi: 4,
      wins: 4,
      losses: 1,
      winRate: 80,
      tradeCount: 10,
      supportedTradeCount: 10,
      supportedPositionCount: 1,
      excludedPositionCount: 0,
      excludedByFlag: byFlag(),
      bestWei: tenth.toString(),
      avgHold: 0,
      last: ts(blockOf(1074, 1)),
      asOf: ts(cursor1),
      oldestAsOf: ts(cursor1),
      completeWindow: true,
    } satisfies AnalyticsWalletSummary);
    // W13: the P trips alone, 0.05 ETH over 5 ETH disposed at a 100 percent
    // record; the Q buy is a trade and 1 ETH of volume on the excluded
    // position, whose exclusion the breakdown puts on the unattributed swap
    // and on nothing else; its last activity is the pooled sale's own
    // transaction.
    assert.deepEqual(item(day, W[13]), {
      address: W[13],
      rank: 7,
      realizedWei: (tenth / 2n).toString(),
      netWei: (tenth / 2n).toString(),
      unrealizedWei: null,
      volumeWei: ((1105n * tenth) / 10n).toString(),
      roi: 1,
      wins: 5,
      losses: 0,
      winRate: 100,
      tradeCount: 11,
      supportedTradeCount: 10,
      supportedPositionCount: 1,
      excludedPositionCount: 1,
      excludedByFlag: byFlag({ unattributed_swap_activity: 1 }),
      bestWei: (tenth / 10n).toString(),
      avgHold: 0,
      last: ts(blockOf(1076, 2)),
      asOf: ts(cursor1),
      oldestAsOf: ts(cursor1),
      completeWindow: true,
    } satisfies AnalyticsWalletSummary);
    // The breakdown is keyed by the fold's own excluding flags, in their
    // order, on every row.
    for (const row of day.items)
      assert.deepEqual(Object.keys(row.excludedByFlag!), [
        ...ledgerExcludingFlags,
      ]);
    // W14's one buy leaves it under every gate; its Q position is excluded
    // the same way, which its profile discloses.
    const w14 = (await get("ledger", `/v1/wallets/${W[14]}?window=24h`))
      .data as AnalyticsWalletResponse;
    assert.deepEqual(
      [
        w14.wallet.rank,
        w14.wallet.supportedPositionCount,
        w14.wallet.excludedPositionCount,
        w14.wallet.excludedByFlag,
      ],
      [null, 0, 1, byFlag({ unattributed_swap_activity: 1 })],
    );
    assert.equal(item(all, W[4]).realizedWei, (2n * E).toString());
    assert.equal(item(all, W[3]).realizedWei, (15n * tenth).toString());
    assert.equal(item(all, W[2]).realizedWei, (12n * tenth).toString());
    assert.equal(item(day, W[7]).realizedWei, item(day, W[8]).realizedWei);

    // Paging is the ranked rows in rank order, and the board ends at 100.
    const page = await board("window=All&limit=4&offset=3");
    assert.deepEqual(order(page), [
      [W[1], 4],
      [W[7], 5],
      [W[8], 6],
      [W[10], 7],
    ]);
    assert.equal(page.total, 10);
    assert.equal(page.nextOffset, 7);
    assert.deepEqual(await board("window=All&limit=25&offset=7").then(order), [
      [W[6], 8],
      [W[9], 9],
      [W[13], 10],
    ]);
    for (const query of [
      "window=7d&limit=25&offset=76",
      "window=7d&limit=100&offset=1",
      "window=All&metric=net&limit=1&offset=100",
    ])
      assert.deepEqual(await get("ledger", `/v1/leaderboard?${query}`), {
        status: 400,
        data: { error: "invalid_offset" },
      });

    // Net orders the same eligible wallets by the window's own cash flows:
    // W1's 2.0 ETH net leads its 1.0 ETH realized, and rank is the position
    // on that board.
    const net = await board("window=24h&metric=net&limit=100");
    assert.deepEqual(
      net.items.map((i) => [i.address, i.rank, i.netWei, i.realizedWei]),
      [
        [W[1], 1, (2n * E).toString(), E.toString()],
        [
          W[7],
          2,
          ((75n * tenth) / 10n).toString(),
          ((75n * tenth) / 10n).toString(),
        ],
        [
          W[8],
          3,
          ((75n * tenth) / 10n).toString(),
          ((75n * tenth) / 10n).toString(),
        ],
        [W[10], 4, (6n * tenth).toString(), (6n * tenth).toString()],
        [
          W[6],
          5,
          ((25n * tenth) / 10n).toString(),
          ((25n * tenth) / 10n).toString(),
        ],
        [W[9], 6, (2n * tenth).toString(), (2n * tenth).toString()],
        [W[13], 7, (tenth / 2n).toString(), (tenth / 2n).toString()],
      ],
    );
    assert.equal(net.total, 7);
    assert.equal(net.metric, "net");
    assert.deepEqual(
      await board("window=24h&metric=net&limit=2&offset=2").then(order),
      [
        [W[8], 3],
        [W[10], 4],
      ],
    );
    // A lower gate admits W5 at the top with its 4 ETH over eight trades; a
    // higher one keeps only W1's eleven trades.
    const eight = await board("window=24h&minTrades=8&limit=100");
    assert.deepEqual(order(eight), [
      [W[5], 1],
      [W[1], 2],
      [W[7], 3],
      [W[8], 4],
      [W[10], 5],
      [W[6], 6],
      [W[9], 7],
      [W[13], 8],
    ]);
    assert.equal(eight.total, 8);
    assert.equal(eight.minTrades, 8);
    assert.equal(item(eight, W[5]).realizedWei, (4n * E).toString());
    assert.equal(item(eight, W[5]).tradeCount, 8);
    const eleven = await board("window=24h&minTrades=11&limit=100");
    assert.deepEqual(order(eleven), [[W[1], 1]]);
    assert.equal(eleven.total, 1);
    assert.equal(eleven.nextOffset, null);

    // The broad source never reads a ledger row.
    assert.deepEqual(
      (await get("broad", "/v1/leaderboard?window=24h&limit=100")).data.items,
      [],
    );

    // One more batch moves the cursor into hour 1079: the 24h window is now
    // hours 1056-1079, W10's hour 1055 has left it, and 7d still holds W10.
    // The cutoff follows the cursor the rows were summed to.
    const cursor2 = cursor1 + 9;
    await applyLedgerBatch(db, batch(cursor1 + 1, cursor2, new Rows()));
    assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
    const later = await board("window=24h&limit=100");
    assert.deepEqual(order(later), [
      [W[1], 1],
      [W[7], 2],
      [W[8], 3],
      [W[6], 4],
      [W[9], 5],
      [W[13], 6],
    ]);
    assert.equal(later.total, 6);
    assert.equal(later.coverage.asOf, ts(cursor2));
    assert.equal(item(later, W[1]).asOf, ts(cursor2));
    assert.deepEqual(item(later, W[1]), {
      ...w1(1, true),
      asOf: ts(cursor2),
      oldestAsOf: ts(cursor2),
    });
    const week = await board("window=7d&limit=100");
    assert.equal(week.total, 8);
    assert.deepEqual(
      [item(week, W[10]).rank, item(week, W[10]).realizedWei],
      [5, (6n * tenth).toString()],
    );
  },
);

test(
  "Postgres HTTP: the trader board ranks and shows trader rows, without a wallet's own launches, and never a contract the census observed, while the profile keeps every position",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema = "api_test_ledgertraders_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    // P and Q were launched by Z (their launch sender), S by W2.
    const Z = pools.P.launchSender;
    const S = {
      ...pools.Q,
      id: hash(0x102),
      token: addr(0x203),
      name: "Pool S",
      symbol: "S",
      launchBlock: 12,
      launchTx: hash(103),
      launchSender: W[2],
    };
    await commitBatch(db, await ensureDiscovery(db, 10), {
      from: 10,
      to: 19,
      hash: hash(19),
      evidence: {},
      pools: [pools.P, pools.Q, S],
    });
    await ensureLedgerStream(db, "tip");
    const reader = createReader(url, schema, { marketSource: "ledger" });
    const api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    const store = createWalletCodeStore(url, schema);
    let locked = false;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      await store.close().catch(() => undefined);
      if (locked) await releaseLedgerWriter(db);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    for (let i = 0; i < 600 && !locked; i++) {
      locked = await acquireLedgerWriter(db);
      if (!locked) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(locked, "ledger writer lock unavailable");
    const get = async (path: string) => {
      const response = await fetch(origin + path);
      const data = await response.json();
      assert.equal(response.status, 200, `${path} ${JSON.stringify(data)}`);
      return data;
    };
    const board = async (query: string) =>
      (await get(
        `/v1/leaderboard?window=All&limit=100&${query}`,
      )) as AnalyticsLeaderboardResponse;
    const order = (b: AnalyticsLeaderboardResponse) =>
      b.items.map((i) => [i.address, i.rank]);
    const profile = async (w: string) =>
      (await get(`/v1/wallets/${w}?window=All`))
        .wallet as AnalyticsWalletSummary;
    const search = async (w: string) =>
      (await get(`/v1/search?q=${w}`)) as SearchResponse;
    const walletResult = async (w: string) =>
      (await search(w)).entries.find((entry) => entry.group === "Wallets")!;

    // A relayed round trip: another address sends each swap and `who` only
    // receives or pays the tokens, so the ledger attributes both legs to it
    // as the counterparty, as it does a contract's or a sponsored wallet's.
    const relayer = addr(0x999);
    const relayed = (
      rows: Rows,
      block: number,
      who: string,
      n: number,
      gain: bigint,
    ) => {
      const at = rows.swaps.length;
      rows.roundTrips(block, who, n, gain);
      for (const swap of rows.swaps.slice(at)) swap.initiator = relayer;
      return rows;
    };
    const rows = new Rows()
      // Z trades only the launches it sent: six round trips, 6 ETH.
      .roundTrips(blockOf(1070, 0), Z, 6, E)
      // W2 made 2.5 ETH in its own S and 0.5 ETH in P, ten trades each.
      .roundTrips(blockOf(1070, 1), W[1], 5, 2n * tenth);
    for (let i = 0; i < 5; i++)
      rows
        .trade(blockOf(1070, 2), W[2], "buy", E, 10n, S)
        .trade(blockOf(1070, 2), W[2], "sell", E + 5n * tenth, 10n, S);
    rows.roundTrips(blockOf(1070, 3), W[2], 5, tenth);
    relayed(rows, blockOf(1070, 4), W[4], 5, 3n * tenth);
    relayed(rows, blockOf(1070, 5), W[5], 5, (25n * tenth) / 10n);
    const cursor1 = blockOf(1078, 4);
    const applied = await applyLedgerBatch(db, batch(base, cursor1, rows));
    assert.equal(applied.unattributed, 0);
    assert.ok(await refreshLedgerWindows(db));

    // Z is on no board; W2 is, on its P trades alone; W4 and W5 lead.
    const first = await board("");
    assert.deepEqual(order(first), [
      [W[4], 1],
      [W[5], 2],
      [W[1], 3],
      [W[2], 4],
    ]);
    const week = (await get(
      "/v1/leaderboard?window=7d&limit=100",
    )) as AnalyticsLeaderboardResponse;
    for (const w of [W[1], W[2], W[4], W[5]]) {
      const result = await walletResult(w);
      assert.equal(result.id, `wallet:${w}`);
      assert.deepEqual(result.traderRank, {
        rank: week.items.find((item) => item.address === w)!.rank,
        window: "7d",
        metric: "realized",
        asOf: week.items[0].asOf,
      });
    }
    // A creator may also trade. The creator entry stays distinct; the
    // wallet entry receives only its trader-board rank.
    const creator = await search(W[2]);
    assert.equal(
      creator.entries.find((entry) => entry.group === "Creators")?.address,
      W[2],
    );
    assert.equal(
      creator.entries.find((entry) => entry.group === "Creators")?.traderRank,
      undefined,
    );
    // Known only from the ledger, the own-launch trader and an unrecognised
    // address all have no rank. The last still gets the existing lookup.
    assert.equal((await walletResult(Z)).traderRank, undefined);
    const unknown = await walletResult(addr(0xdead));
    assert.equal(unknown.id, `lookup:${addr(0xdead)}`);
    assert.equal(unknown.traderRank, undefined);
    const rankedSearch = await search(W[2]);
    await db.query("UPDATE agg_streams SET cursor_hash=decode($1,'hex')", [
      hash(cursor1 + 1).slice(2),
    ]);
    try {
      const unrankedSearch = await search(W[2]);
      assert.deepEqual(unrankedSearch, {
        ...rankedSearch,
        entries: rankedSearch.entries.map(
          ({ traderRank: _rank, ...entry }) => entry,
        ),
      });
    } finally {
      await db.query("UPDATE agg_streams SET cursor_hash=decode($1,'hex')", [
        hash(cursor1).slice(2),
      ]);
    }
    const w2 = first.items.find((i) => i.address === W[2])!;
    assert.deepEqual(
      [
        w2.realizedWei,
        w2.tradeCount,
        w2.supportedTradeCount,
        w2.supportedPositionCount,
      ],
      [(5n * tenth).toString(), 10, 10, 1],
    );
    // The profiles keep every position, with the board's rank.
    const z = await profile(Z);
    assert.deepEqual(
      [z.rank, z.realizedWei, z.supportedTradeCount],
      [null, (6n * E).toString(), 12],
    );
    const w2Profile = await profile(W[2]);
    assert.deepEqual(
      [
        w2Profile.rank,
        w2Profile.realizedWei,
        w2Profile.tradeCount,
        w2Profile.supportedPositionCount,
      ],
      [4, (3n * E).toString(), 20, 2],
    );
    // A wallet with no launch of its own shows the same row on both.
    const w1Profile = await profile(W[1]);
    assert.deepEqual(
      first.items.find((i) => i.address === W[1]),
      {
        ...w1Profile,
        unrealizedWei: null,
      },
    );

    // The census reads exactly the two wallets the ledger never saw send a
    // swap, and records what their code is.
    assert.deepEqual(await store.candidates(25), [W[4], W[5]]);
    const asked: string[][] = [];
    const census = createContractCensus({
      store,
      log: () => undefined,
      client: {
        budget: createCreditBudget({ dailyCap: 100000 }),
        async readCode(addresses: readonly string[]) {
          asked.push([...addresses]);
          return new Map(
            addresses.map((a) => [
              a,
              a === W[4] ? "0x6080604052" : `0xef0100${"ab".repeat(20)}`,
            ]),
          );
        },
      } as never,
    });
    const run = await census.run();
    assert.deepEqual(asked, [[W[4], W[5]]]);
    assert.deepEqual(run, {
      stopped: "done",
      observed: [
        { address: W[4], kind: "contract" },
        { address: W[5], kind: "none" },
      ],
    });
    assert.deepEqual(await store.candidates(25), []);
    const immediate = await board("");
    assert.deepEqual(order(immediate), [
      [W[5], 1],
      [W[1], 2],
      [W[2], 3],
    ]);
    assert.equal(immediate.total, 3);
    assert.deepEqual(order(await board("metric=net")), [
      [W[5], 1],
      [W[1], 2],
      [W[2], 3],
    ]);
    assert.equal((await profile(W[4])).rank, null);
    assert.equal((await profile(W[5])).rank, 1);
    assert.equal((await walletResult(W[4])).traderRank, undefined);
    const currentWeek = (await get(
      "/v1/leaderboard?window=7d&limit=100",
    )) as AnalyticsLeaderboardResponse;
    assert.deepEqual((await walletResult(W[5])).traderRank, {
      rank: currentWeek.items.find((item) => item.address === W[5])!.rank,
      window: "7d",
      metric: "realized",
      asOf: currentWeek.items[0].asOf,
    });
    const cursor2 = cursor1 + 9;
    await applyLedgerBatch(db, batch(cursor1 + 1, cursor2, new Rows()));
    assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
    const second = await board("");
    assert.deepEqual(order(second), [
      [W[5], 1],
      [W[1], 2],
      [W[2], 3],
    ]);
    assert.equal(second.total, 3);
    const net = await board("metric=net");
    assert.deepEqual(
      net.items.map((i) => i.address),
      [W[5], W[1], W[2]],
    );
    assert.equal(net.total, 3);
    const loose = await board("minTrades=0");
    assert.deepEqual(
      loose.items.map((i) => i.address),
      [W[5], W[1], W[2]],
    );
    assert.equal((await profile(W[4])).rank, null);
    await db.query(`INSERT INTO agg_wallets(address,first_block)
      SELECT decode(lpad(to_hex(131072+i),40,'0'),'hex'),0 FROM generate_series(1,101) i`);
    await db.query(`INSERT INTO agg_trader_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,
      trades,supported_trades,wins,losses,closures,hold_seconds,supported_positions,excluded_positions,window_start,refreshed_at)
      SELECT 4663,'All',w.wallet_ref,-i,-i,100,100,10,10,0,0,0,0,1,0,0,now()
      FROM generate_series(1,101) i JOIN agg_wallets w ON w.address=decode(lpad(to_hex(131072+i),40,'0'),'hex')`);
    const deepAddress = addr(131072 + 94);
    const deepBefore = (await get(
      "/v1/leaderboard?window=All&limit=25&offset=75",
    )) as AnalyticsLeaderboardResponse;
    assert(deepBefore.items.some((i) => i.address === deepAddress));
    assert((await store.candidates(200)).includes(deepAddress));
    await store.record([{ address: deepAddress, kind: "contract" }]);
    const deepAfter = (await get(
      "/v1/leaderboard?window=All&limit=25&offset=75",
    )) as AnalyticsLeaderboardResponse;
    assert(!deepAfter.items.some((i) => i.address === deepAddress));
    assert.equal(deepAfter.total, 100);
    assert.deepEqual(
      deepAfter.items.map((i) => i.rank),
      Array.from({ length: 25 }, (_, i) => i + 76),
    );
    await census.close();
  },
);
