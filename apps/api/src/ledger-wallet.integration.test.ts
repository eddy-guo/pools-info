import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type {
  AnalyticsLeaderboardResponse,
  AnalyticsWalletPosition,
  AnalyticsWalletResponse,
  AnalyticsWalletSummary,
  LedgerSwap,
  LedgerTransfer,
  PricePoint,
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
  migrate,
  migrateLedgerTransferProvenance,
  refreshLedgerWindows,
  registerLedgerTransferCounterparties,
  releaseLedgerWriter,
  type LedgerBatch,
} from "../../../packages/db/src/index";
import { walletSummary } from "./accounting-read";
import { createReader } from "./reader";
import { createApi } from "./server";

// The wallet page is served from the positions the ledger's own writer folds
// and the windows it refreshes, so the fixture is trades applied through
// `applyLedgerBatch` and `refreshLedgerWindows`, and every expectation below
// is derived by hand from those trades: average-cost basis, realized =
// proceeds - disposed cost, hour-aligned windows, a held position marked
// at the pool's latest sqrt price (2^192 / sqrt^2 wei per raw unit), and the
// realized curve as one point per hour with a sale, at the hour's end.
const E = 10n ** 18n;
const hash = (n: number | bigint): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, "0")}`;
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
    decimals: 18,
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
    decimals: 18,
  },
  // R's decimals are unknown: the pass never read them.
  R: {
    id: hash(0x102),
    token: addr(0x203),
    name: "Pool R",
    symbol: "R",
    launchBlock: 12,
    launchTx: hash(103),
    launchSender: addr(0x10001),
    launchedAt: 100,
  },
};
const wallet = (n: number) => addr(0x10000 + n);
const W = Object.fromEntries(
  [1, 2, 3, 4, 6, 7, 8, 9].map((n) => [n, wallet(n)]),
) as Record<number, `0x${string}`>;
const WRAPPER = wallet(10);
/** A sqrt price of 2^68: 2^192 / 2^136 = 2^56 wei per raw unit. */
const sqrtQ = (2n ** 68n).toString();

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
    pool: (typeof pools)[keyof typeof pools] = pools.P,
    sqrtPriceX96 = "1000",
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
      sqrtPriceX96,
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
  /** A plain transfer of P between wallets, no swap in its transaction. */
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
  /** One transfer transaction fans inventory out through a known wrapper while
   * preserving the receiver's exact net amount. The gross legs are what the
   * provenance table retains; the financial fold still sees only the net. */
  distribute(
    block: number,
    from: string,
    receiver: string,
    wrapper: string,
    tokens: bigint,
  ) {
    const i = this.logs.get(block) ?? 0,
      txHash = hash(BigInt(block) * 100000n + BigInt(i)),
      via = tokens / 2n,
      direct = tokens - via;
    this.logs.set(block, i + 3);
    const site = {
      txHash,
      block,
      blockHash: hash(block),
      timestamp: ts(block),
      token: pools.P.token,
    };
    this.transfers.push(
      { ...site, logIndex: i, from, to: receiver, value: direct.toString() },
      { ...site, logIndex: i + 1, from, to: wrapper, value: via.toString() },
      {
        ...site,
        logIndex: i + 2,
        from: wrapper,
        to: receiver,
        value: via.toString(),
      },
    );
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
    registryPools: 3,
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

/** The curve's point for hour `h`: its cumulative realized at the hour's
 * end, or at the cutoff when the hour is still open there. */
const at = (hour: number, wei: bigint, asOf = Infinity): PricePoint => ({
  time: Math.min((hour + 1) * 3600, asOf),
  wei: wei.toString(),
});

test(
  "Postgres HTTP: MARKET_SOURCE=ledger serves the wallet page's header, window figures, positions and realized curve from the ledger, hand-checked, and the accounting profile until the ledger has folded anything",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema = "api_test_ledgerwallet_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    await commitBatch(db, await ensureDiscovery(db, 10), {
      from: 10,
      to: 19,
      hash: hash(19),
      evidence: {},
      pools: [pools.P, pools.Q, pools.R],
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
    const profile = async (address: string, window: string) => {
      const { status, data } = await get(
        "ledger",
        `/v1/wallets/${address}?window=${window}`,
      );
      assert.equal(status, 200, `${address} ${window} ${JSON.stringify(data)}`);
      return data as AnalyticsWalletResponse;
    };
    const board = async (window: string) => {
      const { status, data } = await get(
        "ledger",
        `/v1/leaderboard?window=${window}&limit=100`,
      );
      assert.equal(status, 200, `${window} ${JSON.stringify(data)}`);
      return data as AnalyticsLeaderboardResponse;
    };
    const paths = ["24h", "7d", "30d", "All"].flatMap((window) => [
      `/v1/wallets/${W[1]}?window=${window}`,
      `/v1/wallets/${W[3]}?window=${window}`,
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
    await migrateLedgerTransferProvenance(db, "d".repeat(64), null);
    await registerLedgerTransferCounterparties(
      db,
      JSON.stringify({
        version: 1,
        chainId: 4663,
        entries: [
          {
            address: W[7],
            class: "farm",
            label: "Fixture distribution farm",
            validFromBlock: base,
            validThroughBlock: null,
            evidence: {
              kind: "signed_protocol_statement",
              authority: "Fixture protocol",
              source: "https://protocol.invalid/evidence/farm",
              sha256: "e".repeat(64),
            },
          },
          {
            address: WRAPPER,
            class: "wrapper",
            label: "Fixture wrapper",
            validFromBlock: base,
            validThroughBlock: null,
            evidence: {
              kind: "verified_contract_source",
              authority: "Fixture protocol",
              source: "https://protocol.invalid/evidence/wrapper",
              sha256: "f".repeat(64),
            },
          },
        ],
      }),
    );

    // The cursor sits mid-hour in hour 1078, so the windows are the whole
    // hours 1055-1078 (24h), 911-1078 (7d), 359-1078 (30d) and everything
    // since hour 278 (All). Amounts in tenths of an ETH.
    const cursor1 = blockOf(1078, 4);
    const rows = new Rows()
      // W1 carries basis across the 24h boundary in P: 10 tokens bought for
      // 1 ETH in hour 1050 (outside 24h, inside 7d), sold for 1.5 ETH in
      // hour 1060 (inside 24h), then five 0.1 ETH round trips in hour 1070.
      // In Q it holds 40 tokens bought for 2 ETH in hour 1075, the pool's
      // last swap leaving the price at 2^56 wei per raw unit.
      .trade(blockOf(1050, 0), W[1], "buy", E, 10n)
      .trade(blockOf(1060, 0), W[1], "sell", 15n * tenth, 10n)
      .roundTrips(blockOf(1070, 0), W[1], 5, tenth)
      .trade(blockOf(1075, 0), W[1], "buy", 2n * E, 40n, pools.Q, sqrtQ)
      // W2 holds 10 R tokens bought for 1 ETH in hour 1000: inside 7d, out
      // of 24h, and R's price cannot be stated without its decimals.
      .trade(blockOf(1000, 0), W[2], "buy", E, 10n, pools.R)
      // W4 closes one 0.1 ETH round trip in each of the 48 hours 1030-1077,
      // 23 of them inside the 24h window (hours 1055-1078).
      // W6 has a supported position in P and, three hours later, sells 7 Q
      // tokens it never bought: that position is excluded, its finances
      // never served and its hour drawn nowhere.
      .roundTrips(blockOf(1071, 0), W[6], 5, tenth / 2n)
      .trade(blockOf(1074, 1), W[6], "sell", 9n * tenth, 7n, pools.Q)
      // W8 buys 100 P for 1 ETH and sends 90 to W7, which sells them in ten
      // sales of 1 ETH each in hour 1073: the transfer excludes W7's
      // position on arrival (zero_cost_inflow) and W8's on departure
      // (unattributed_outflow), so W7's 10 ETH of proceeds is volume only.
      .trade(blockOf(1073, 0), W[8], "buy", E, 100n)
      .distribute(blockOf(1073, 1), W[8], W[7], WRAPPER, 90n);
    for (let i = 0; i < 10; i++)
      rows.trade(blockOf(1073, 3), W[7], "sell", E, 9n);
    for (let hour = 1030; hour < 1078; hour++)
      rows.roundTrips(blockOf(hour, 2), W[4], 1, tenth);
    // W9 loses 1,000 wei on one round trip in each of the 679 hours 400-1078,
    // the last in the cursor's own hour: more hours than the curve serves
    // unsampled, and a curve that runs below zero.
    for (let hour = 400; hour <= 1078; hour++)
      rows.roundTrips(blockOf(hour, 3), W[9], 1, -1000n);
    const applied = await applyLedgerBatch(db, batch(base, cursor1, rows));
    assert.equal(applied.unattributed, 0);
    assert.deepEqual(
      (
        await db.query(
          `SELECT DISTINCT encode(to_address,'hex') AS address,to_class,classification_version
           FROM agg_transfer_provenance
           WHERE to_address IN (decode($1,'hex'),decode($2,'hex'))
           ORDER BY address`,
          [W[7].slice(2), WRAPPER.slice(2)],
        )
      ).rows,
      [
        {
          address: W[7].slice(2),
          to_class: "farm",
          classification_version: 2,
        },
        {
          address: WRAPPER.slice(2),
          to_class: "wrapper",
          classification_version: 2,
        },
      ].sort((a, b) => a.address.localeCompare(b.address)),
    );
    // Folded but not yet refreshed into windows: the page has nothing to
    // stand on and says so, retryably, rather than serving the old tables.
    assert.deepEqual(await get("ledger", `/v1/wallets/${W[1]}?window=24h`), {
      status: 503,
      data: { error: "wallet_refresh_pending" },
    });
    assert.ok(await refreshLedgerWindows(db));

    // Following's refresh gate reads a wallet's newest activity from its All
    // window row, the header's own `last`; a wallet the ledger never saw is
    // absent, and a deployment on the broad source has no signal at all.
    assert.equal(await readers.broad.walletActivity!([W[1]]), null);
    const activity = await readers.ledger.walletActivity!([
      W[1],
      W[3],
      wallet(99),
    ]);
    // W[3]'s All row has no timed trade, so like an unseen wallet it gives
    // no signal rather than a zero.
    assert.equal((await profile(W[3], "All")).wallet!.last, null);
    assert.deepEqual(
      activity,
      new Map([[W[1], (await profile(W[1], "All")).wallet!.last]]),
    );
    assert.ok(activity!.get(W[1])! > 0);
    // The registry the explorer's trades are checked against names each
    // token's pool.
    assert.deepEqual(
      (await readers.ledger.registeredTokens!(0)).map((r) => [
        r.poolId,
        r.token,
      ]),
      [pools.P, pools.Q, pools.R].map((p) => [p.id, p.token]),
    );

    // The response's fields are the accounting reader's, field for field,
    // on the profile, its summary and each position.
    const day = await profile(W[1], "24h");
    assert.deepEqual(Object.keys(day).sort(), [
      "coverage",
      "curve",
      "curveSampled",
      "launches",
      "launchesTruncated",
      "positionRealizationsIncluded",
      "positions",
      "positionsTruncated",
      "trades",
      "tradesTruncated",
      "wallet",
      "window",
    ]);
    assert.deepEqual(
      Object.keys(day.wallet).sort(),
      Object.keys(walletSummary(undefined, W[1])).sort(),
    );
    const positionKeys = [
      "asOf",
      "decimals",
      "flags",
      "launchTx",
      "netWei",
      "poolId",
      "position",
      "realizedWei",
      "supported",
      "symbol",
      "throughBlock",
      "token",
      "unrealizedWei",
      "volumeWei",
    ];
    for (const p of day.positions)
      assert.deepEqual(Object.keys(p).sort(), positionKeys);
    assert.deepEqual(
      { ...day.coverage, generatedAt: "-" },
      {
        catalogPools: 3,
        processedPools: 3,
        asOf: ts(cursor1),
        oldestAsOf: ts(cursor1),
        generatedAt: "-",
        complete: false,
        registryExhaustive: false,
        pnlScope: "attributed_positions_all_pools",
      },
    );
    assert.equal(day.window, "24h");
    // What the ledger does not keep is served empty, never from the frozen
    // tables: no row per sale.
    assert.deepEqual([day.trades, day.tradesTruncated], [[], false]);
    for (const p of day.curve)
      assert.deepEqual(Object.keys(p).sort(), ["time", "wei"]);
    assert.deepEqual(
      [day.positionRealizationsIncluded, day.positionsTruncated],
      [false, false],
    );
    // Launches are catalog data whoever serves the page: W1 sent R's launch.
    assert.deepEqual(
      [day.launches.map((l) => l.id), day.launchesTruncated],
      [[pools.R.id], false],
    );

    // W1's 24h summary: the 1.5 ETH sale disposes the 1 ETH bought before the
    // window, so realized is 0.5 + 5 x 0.1 = 1.0 ETH over 6 ETH of disposed
    // cost, while net counts the window's own cash flows: 7.0 ETH out for
    // 5 ETH in, less the 2 ETH into Q. Its one held cycle lasted the ten
    // hours from the buy to the sale, the five others 0 s. Unrealized is
    // the Q holding's mark: 40 units at 2^56 wei less their 2 ETH cost, P's
    // flat position marking at zero.
    const unrealizedQ = 40n * 2n ** 56n - 2n * E;
    const w1 = (rank: number, inWindow: boolean) =>
      ({
        address: W[1],
        rank,
        realizedWei: E.toString(),
        netWei: (inWindow ? 0n : -E).toString(),
        unrealizedWei: unrealizedQ.toString(),
        volumeWei: (inWindow ? 14n * E : 15n * E).toString(),
        roi: 16.6666,
        wins: 6,
        losses: 0,
        winRate: 100,
        tradeCount: inWindow ? 12 : 13,
        supportedTradeCount: inWindow ? 12 : 13,
        supportedPositionCount: 2,
        excludedPositionCount: 0,
        bestWei: (5n * tenth).toString(),
        avgHold: 36000 / 6,
        last: ts(blockOf(1075, 0)),
        asOf: ts(cursor1),
        oldestAsOf: ts(cursor1),
        completeWindow: true,
      }) satisfies AnalyticsWalletSummary;
    assert.deepEqual(day.wallet, w1(2, true));
    const all = await profile(W[1], "All");
    assert.deepEqual(all.wallet, w1(2, false));
    const week = await profile(W[1], "7d");
    assert.deepEqual(week.wallet, w1(2, false));
    assert.deepEqual((await profile(W[1], "30d")).wallet, w1(2, false));
    // W1's curve: zero at the window's first hour, the 0.5 ETH sale of hour
    // 1060 at that hour's end, the five trips of hour 1070 at its end, and
    // the header's figure at the cutoff; the hour 1050 buy draws no point
    // but opens the All curve, whose window has no start of its own.
    const w1curve = (start: number) => [
      { time: start * 3600, wei: "0" },
      at(1060, 5n * tenth),
      at(1070, E),
      { time: ts(cursor1), wei: E.toString() },
    ];
    assert.deepEqual([day.curve, day.curveSampled], [w1curve(1055), false]);
    assert.deepEqual(week.curve, w1curve(911));
    assert.deepEqual(all.curve, w1curve(1050));
    // The headline is the board's row to the wei, on every window: the same
    // row, the mark being the page's own addition.
    for (const window of ["24h", "7d", "30d", "All"]) {
      const row = (await board(window)).items.find((i) => i.address === W[1])!;
      assert.deepEqual(
        { ...(await profile(W[1], window)).wallet, unrealizedWei: null },
        row,
        window,
      );
    }

    // W1's positions, in pool order: P with the window's own realized, net
    // and volume summed from its hours (the 1.0 ETH realized, 2.0 ETH net and
    // 12 ETH volume of the 24h hours 1060 and 1070; 1.0, 1.0 and 13 over
    // all) and the fold's whole state; Q held at its mark.
    const positionP = (inWindow: boolean) =>
      ({
        poolId: pools.P.id,
        token: pools.P.token,
        symbol: "P",
        decimals: 18,
        launchTx: pools.P.launchTx,
        asOf: ts(cursor1),
        throughBlock: cursor1,
        supported: true,
        flags: [],
        realizedWei: E.toString(),
        unrealizedWei: "0",
        netWei: (inWindow ? 2n * E : E).toString(),
        volumeWei: (inWindow ? 12n * E : 13n * E).toString(),
        position: {
          poolId: pools.P.id,
          trader: W[1],
          quantity: "0",
          costWei: "0",
          realizedWei: E.toString(),
          investedWei: (6n * E).toString(),
          proceedsWei: (7n * E).toString(),
          buys: 6,
          sells: 6,
          flags: [],
          realizations: [],
        },
      }) satisfies AnalyticsWalletPosition;
    const positionQ = {
      poolId: pools.Q.id,
      token: pools.Q.token,
      symbol: "Q",
      decimals: 18,
      launchTx: pools.Q.launchTx,
      asOf: ts(cursor1),
      throughBlock: cursor1,
      supported: true,
      flags: [],
      realizedWei: "0",
      unrealizedWei: unrealizedQ.toString(),
      netWei: (-2n * E).toString(),
      volumeWei: (2n * E).toString(),
      position: {
        poolId: pools.Q.id,
        trader: W[1],
        quantity: "40",
        costWei: (2n * E).toString(),
        realizedWei: "0",
        investedWei: (2n * E).toString(),
        proceedsWei: "0",
        buys: 1,
        sells: 0,
        flags: [],
        realizations: [],
      },
    } satisfies AnalyticsWalletPosition;
    assert.deepEqual(day.positions, [positionP(true), positionQ]);
    assert.deepEqual(all.positions, [positionP(false), positionQ]);
    // The positions' window figures sum to the summary's.
    const sum = (r: AnalyticsWalletResponse, key: "realizedWei" | "netWei") =>
      r.positions.reduce((s, p) => s + BigInt(p[key] ?? 0n), 0n).toString();
    for (const r of [day, all]) {
      assert.equal(sum(r, "realizedWei"), r.wallet.realizedWei);
      assert.equal(sum(r, "netWei"), r.wallet.netWei);
    }

    // W2 has no hour in the 24h window: the window reads as no activity with
    // the wallet's lifetime position count and last activity, no rank, and
    // the R holding unmarked without its decimals, so unrealized is unknown
    // on the position and on the wallet. Its one 7d trade is under the
    // gate: the same figures, no rank, with the window's cash flow.
    const w2 = (inWindow: boolean) =>
      ({
        address: W[2],
        rank: null,
        realizedWei: "0",
        netWei: inWindow ? (-E).toString() : "0",
        unrealizedWei: null,
        volumeWei: inWindow ? E.toString() : "0",
        roi: null,
        wins: 0,
        losses: 0,
        winRate: null,
        tradeCount: inWindow ? 1 : 0,
        supportedTradeCount: inWindow ? 1 : 0,
        supportedPositionCount: 1,
        excludedPositionCount: 0,
        bestWei: null,
        avgHold: null,
        last: ts(blockOf(1000, 0)),
        asOf: ts(cursor1),
        oldestAsOf: ts(cursor1),
        completeWindow: true,
      }) satisfies AnalyticsWalletSummary;
    const w2day = await profile(W[2], "24h");
    assert.deepEqual(w2day.wallet, w2(false));
    assert.deepEqual((await profile(W[2], "7d")).wallet, w2(true));
    // A supported position with no sale draws the flat zero line the header
    // reads, from the window's start, or the buy's hour on All.
    assert.deepEqual(w2day.curve, [
      { time: 1055 * 3600, wei: "0" },
      { time: ts(cursor1), wei: "0" },
    ]);
    assert.deepEqual((await profile(W[2], "All")).curve, [
      { time: 1000 * 3600, wei: "0" },
      { time: ts(cursor1), wei: "0" },
    ]);
    assert.deepEqual(w2day.positions, [
      {
        poolId: pools.R.id,
        token: pools.R.token,
        symbol: "R",
        decimals: null,
        launchTx: pools.R.launchTx,
        asOf: ts(cursor1),
        throughBlock: cursor1,
        supported: true,
        flags: [],
        realizedWei: "0",
        unrealizedWei: null,
        netWei: "0",
        volumeWei: "0",
        position: {
          poolId: pools.R.id,
          trader: W[2],
          quantity: "10",
          costWei: E.toString(),
          realizedWei: "0",
          investedWei: E.toString(),
          proceedsWei: "0",
          buys: 1,
          sells: 0,
          flags: [],
          realizations: [],
        },
      } satisfies AnalyticsWalletPosition,
    ]);

    // W6: five 0.05 ETH trips in P count; the excluded Q position keeps its
    // counts and its 0.9 ETH of volume and serves no finance, the sale
    // counting as a trade on the summary but not a supported one.
    const w6 = await profile(W[6], "24h");
    assert.deepEqual(w6.wallet, {
      address: W[6],
      rank: 3,
      realizedWei: ((25n * tenth) / 10n).toString(),
      netWei: ((25n * tenth) / 10n).toString(),
      unrealizedWei: "0",
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
      last: ts(blockOf(1074, 1)),
      asOf: ts(cursor1),
      oldestAsOf: ts(cursor1),
      completeWindow: true,
    } satisfies AnalyticsWalletSummary);
    const excluded = w6.positions.find((p) => p.poolId === pools.Q.id)!;
    assert.equal(excluded.supported, false);
    assert.ok(excluded.flags.includes("unknown_basis"), excluded.flags.join());
    assert.deepEqual(
      [
        excluded.realizedWei,
        excluded.netWei,
        excluded.unrealizedWei,
        excluded.volumeWei,
        excluded.position,
      ],
      [null, null, null, (9n * tenth).toString(), null],
    );
    assert.equal(w6.positions.length, 2);
    // The excluded sale's hour 1074 is on the wallet's hour rows and on no
    // point of its curve, which ends where the header does.
    assert.deepEqual(
      (
        await db.query(
          `SELECT h.hour FROM agg_wallet_hours h JOIN agg_wallets w USING (wallet_ref)
           WHERE w.address=decode($1,'hex') AND h.sells>0 ORDER BY h.hour`,
          [W[6].slice(2)],
        )
      ).rows.map((r) => r.hour),
      [1071, 1074],
    );
    assert.deepEqual(w6.curve, [
      { time: 1055 * 3600, wei: "0" },
      at(1071, (25n * tenth) / 10n),
      { time: ts(cursor1), wei: w6.wallet.realizedWei! },
    ]);

    // W7: the header the board would rank by, had it a supported trade:
    // ten trades and 10 ETH of volume, no supported trade, no realized or
    // disposed figure and so no ROI (never a percent of a zero basis), no
    // rank; the one position excluded with the flag and no finance served.
    const w7 = await profile(W[7], "24h");
    assert.deepEqual(w7.wallet, {
      address: W[7],
      rank: null,
      realizedWei: "0",
      netWei: "0",
      unrealizedWei: null,
      volumeWei: (10n * E).toString(),
      roi: null,
      wins: 0,
      losses: 0,
      winRate: null,
      tradeCount: 10,
      supportedTradeCount: 0,
      supportedPositionCount: 0,
      excludedPositionCount: 1,
      bestWei: null,
      avgHold: null,
      last: ts(blockOf(1073, 3)),
      asOf: ts(cursor1),
      oldestAsOf: ts(cursor1),
      completeWindow: true,
    } satisfies AnalyticsWalletSummary);
    assert.deepEqual(
      w7.positions.map((p) => [
        p.poolId,
        p.supported,
        p.flags,
        p.realizedWei,
        p.netWei,
        p.unrealizedWei,
        p.volumeWei,
        p.position,
      ]),
      [
        [
          pools.P.id,
          false,
          ["zero_cost_inflow", "wrapper_counterparty"],
          null,
          null,
          null,
          (10n * E).toString(),
          null,
        ],
      ],
    );
    // Ten sales on an excluded position draw nothing: no supported position,
    // no curve, as the accounting reader serves one.
    assert.deepEqual([w7.curve, w7.curveSampled], [[], false]);
    // W8 sent ninety of the hundred away without a sale: the ledger never
    // saw where their 0.9 ETH of basis went, so its position is excluded
    // too (unattributed_outflow) and its buy is a trade and volume only;
    // no loss is booked for the move.
    const w8 = await profile(W[8], "24h");
    assert.deepEqual(
      [
        w8.wallet.supportedPositionCount,
        w8.wallet.excludedPositionCount,
        w8.wallet.tradeCount,
        w8.wallet.supportedTradeCount,
        w8.wallet.realizedWei,
        w8.wallet.netWei,
        w8.wallet.volumeWei,
        w8.wallet.roi,
        w8.positions[0].supported,
        w8.positions[0].flags,
        w8.positions[0].position,
      ],
      [
        0,
        1,
        1,
        0,
        "0",
        "0",
        E.toString(),
        null,
        false,
        ["unattributed_outflow", "wrapper_counterparty", "farm_counterparty"],
        null,
      ],
    );
    assert.deepEqual(w8.curve, []);

    // W4's 48 hours of round trips: the 23 inside the 24h window realize
    // 2.3 ETH, all of them 4.8, and the one P position carries the same
    // figures; it leads both boards.
    const w4day = await profile(W[4], "24h");
    assert.deepEqual(
      [w4day.wallet.rank, w4day.wallet.realizedWei, w4day.wallet.tradeCount],
      [1, (23n * tenth).toString(), 46],
    );
    assert.deepEqual(
      [
        w4day.positions.length,
        w4day.positions[0].realizedWei,
        w4day.positions[0].volumeWei,
      ],
      [1, (23n * tenth).toString(), (23n * 21n * tenth).toString()],
    );
    const w4all = await profile(W[4], "All");
    assert.deepEqual(
      [
        w4all.wallet.rank,
        w4all.wallet.realizedWei,
        w4all.wallet.wins,
        w4all.positions[0].realizedWei,
      ],
      [1, (48n * tenth).toString(), 48, (48n * tenth).toString()],
    );
    // One point per hour, each at its hour's end: the 23 window hours from
    // 1055, and all 48 from 1030 on All, ending on the header's figure.
    const w4curve = (from: number, to: number, asOf: number) => [
      { time: from * 3600, wei: "0" },
      ...Array.from({ length: to - from + 1 }, (_, i) =>
        at(from + i, BigInt(i + 1) * tenth),
      ),
      { time: asOf, wei: (BigInt(to - from + 1) * tenth).toString() },
    ];
    assert.deepEqual(
      [w4day.curve, w4day.curveSampled],
      [w4curve(1055, 1077, ts(cursor1)), false],
    );
    assert.deepEqual(
      [w4all.curve, w4all.curveSampled],
      [w4curve(1030, 1077, ts(cursor1)), false],
    );

    // W9's 679 losing hours: the 24 in the window unsampled, its hour 1078
    // point at the cutoff since that hour is still open there; the 30d
    // window and All hold every hour, more than the ~500 the curve serves,
    // so every other hour and the last are kept, as the accounting reader
    // samples its sales, and the response says so. Its rank is the last
    // eligible one: a loss on every window.
    const w9day = await profile(W[9], "24h");
    assert.deepEqual(
      [w9day.wallet.rank, w9day.wallet.realizedWei, w9day.wallet.tradeCount],
      [4, "-24000", 48],
    );
    assert.deepEqual(
      [w9day.curve, w9day.curveSampled],
      [
        [
          { time: 1055 * 3600, wei: "0" },
          ...Array.from({ length: 24 }, (_, i) =>
            at(1055 + i, BigInt(-1000 * (i + 1)), ts(cursor1)),
          ),
          { time: ts(cursor1), wei: "-24000" },
        ],
        false,
      ],
    );
    assert.equal(w9day.curve.at(-2)!.time, ts(cursor1));
    const w9sampled = (start: number) => [
      { time: start * 3600, wei: "0" },
      ...Array.from({ length: 340 }, (_, j) =>
        at(400 + 2 * j, BigInt(-1000 * (2 * j + 1)), ts(cursor1)),
      ),
      { time: ts(cursor1), wei: "-679000" },
    ];
    const w9month = await profile(W[9], "30d");
    assert.deepEqual(w9month.wallet.realizedWei, "-679000");
    assert.deepEqual(
      [w9month.curve, w9month.curveSampled],
      [w9sampled(359), true],
    );
    const w9all = await profile(W[9], "All");
    assert.deepEqual(
      [w9all.wallet.rank, w9all.wallet.realizedWei, w9all.curveSampled],
      [4, "-679000", true],
    );
    assert.deepEqual(w9all.curve, w9sampled(400));
    assert.deepEqual(
      [(await profile(W[9], "7d")).curve.length, w9all.curve.length],
      [170, 342],
    );

    // A wallet the ledger has never seen: the empty profile the accounting
    // reader serves for one it has no row for, under the ledger's coverage.
    const w3 = await profile(W[3], "All");
    assert.deepEqual(w3.wallet, walletSummary(undefined, W[3]));
    assert.deepEqual([w3.positions, w3.trades, w3.curve], [[], [], []]);
    assert.deepEqual(
      { ...w3.coverage, generatedAt: "-" },
      { ...day.coverage, generatedAt: "-" },
    );

    // The broad source never reads a ledger row.
    assert.deepEqual(
      (await get("broad", `/v1/wallets/${W[1]}?window=24h`)).data.wallet,
      walletSummary(undefined, W[1]),
    );

    // One more batch moves the cursor into hour 1079: the 24h window is now
    // hours 1056-1079 and W4's hour 1055 trip has left it (22 remain), on
    // the summary and on the position alike, with the cutoff following the
    // cursor.
    const cursor2 = cursor1 + 9;
    await applyLedgerBatch(db, batch(cursor1 + 1, cursor2, new Rows()));
    assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
    const later = await profile(W[4], "24h");
    assert.deepEqual(
      [
        later.coverage.asOf,
        later.wallet.asOf,
        later.wallet.realizedWei,
        later.wallet.tradeCount,
        later.positions[0].realizedWei,
        later.positions[0].asOf,
      ],
      [
        ts(cursor2),
        ts(cursor2),
        (22n * tenth).toString(),
        44,
        (22n * tenth).toString(),
        ts(cursor2),
      ],
    );
    assert.deepEqual((await profile(W[1], "24h")).wallet, {
      ...w1(2, true),
      asOf: ts(cursor2),
      oldestAsOf: ts(cursor2),
    });
    // The curve follows the window: hour 1055's point has left it, the
    // leading zero sits on hour 1056 and the end on the new cutoff, and
    // W9's hour 1078, closed now, sits at its own end.
    assert.deepEqual(later.curve, w4curve(1056, 1077, ts(cursor2)));
    const w9later = await profile(W[9], "24h");
    assert.deepEqual(w9later.curve, [
      { time: 1056 * 3600, wei: "0" },
      ...Array.from({ length: 23 }, (_, i) =>
        at(1056 + i, BigInt(-1000 * (i + 1))),
      ),
      { time: ts(cursor2), wei: "-23000" },
    ]);
    assert.equal(w9later.curve.at(-2)!.time, 1079 * 3600);
  },
);
