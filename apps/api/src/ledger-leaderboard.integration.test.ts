import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type {
  AnalyticsLeaderboardResponse,
  AnalyticsWalletSummary,
  LedgerSwap,
  LedgerTransfer,
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
  refreshLedgerWindows,
  releaseLedgerWriter,
  type LedgerBatch,
} from "../../../packages/db/src/index";
import { walletSummary } from "./accounting-read";
import { ledgerLeaderboardPolicy } from "./ledger-leaderboard";
import { createReader } from "./reader";
import { createApi } from "./server";

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
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, wallet(n)]),
) as Record<number, string>;

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
    await ensureLedgerStream(db, "tip");
    await sameAsBroad();
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
    const applied = await applyLedgerBatch(db, batch(base, cursor1, rows));
    assert.equal(applied.unattributed, 0);
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
    ]);
    assert.deepEqual(order(await board("window=7d&limit=100")), [
      [W[2], 1],
      [W[1], 2],
      [W[7], 3],
      [W[8], 4],
      [W[10], 5],
      [W[6], 6],
      [W[9], 7],
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
      [day, 6],
      [all, 9],
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
      bestWei: tenth.toString(),
      avgHold: 0,
      last: ts(blockOf(1074, 1)),
      asOf: ts(cursor1),
      oldestAsOf: ts(cursor1),
      completeWindow: true,
    } satisfies AnalyticsWalletSummary);
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
    assert.equal(page.total, 9);
    assert.equal(page.nextOffset, 7);
    assert.deepEqual(await board("window=All&limit=25&offset=7").then(order), [
      [W[6], 8],
      [W[9], 9],
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
      ],
    );
    assert.equal(net.total, 6);
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
    ]);
    assert.equal(eight.total, 7);
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
    ]);
    assert.equal(later.total, 5);
    assert.equal(later.coverage.asOf, ts(cursor2));
    assert.equal(item(later, W[1]).asOf, ts(cursor2));
    assert.deepEqual(item(later, W[1]), {
      ...w1(1, true),
      asOf: ts(cursor2),
      oldestAsOf: ts(cursor2),
    });
    const week = await board("window=7d&limit=100");
    assert.equal(week.total, 7);
    assert.deepEqual(
      [item(week, W[10]).rank, item(week, W[10]).realizedWei],
      [5, (6n * tenth).toString()],
    );
  },
);
