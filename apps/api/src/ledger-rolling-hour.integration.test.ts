import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type {
  AnalyticsExploreResponse,
  AnalyticsPoolRow,
  CreatorsResponse,
  LedgerSwap,
  LedgerTransfer,
} from "@pools/core";
import {
  acquireLedgerWriter,
  applyLedgerBatch,
  commitBatch,
  createClient,
  ensureLedgerLaunchStream,
  ensureLedgerStream,
  ledgerRules,
  ledgerStream,
  migrate,
  releaseLedgerWriter,
  type LedgerBatch,
} from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createApi } from "./server";
import { ledgerCut, ledgerHour } from "./ledger-market";

// 1h is the rolling hour ending at the ledger's cursor, read from its live
// ring: production served every 1h figure as null (the screener's default
// volume order answered no rows at all) because whole hours cannot answer
// it. The trades below are folded through the ledger's own writer, which
// writes the ring and the pool hours from the same swaps, and every
// expectation is derived by hand from them.
const E = 10n ** 18n,
  e30 = 10n ** 30n;
const hash = (n: number | bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = ledgerStream.start;
// One block a minute from the start of UTC hour H-6, so hour H-6+k is
// blocks base+60k through base+60k+59. The cursor is block base+390, half an
// hour into hour H: the rolling hour runs from block base+330 (its start,
// inclusive) through the cursor, and the UTC hour holding its start opens at
// block base+300.
const H = 500000;
const ts = (block: number) => (H - 6) * 3600 + (block - base) * 60;
const cursor = base + 390,
  asOf = ts(cursor),
  start = asOf - 3600;
assert.equal(start, ts(base + 330));
// The ledger commits in batches whose ends straddle the rolling hour's
// start and its UTC hour's start, so the ring is read across a batch that
// holds swaps on both sides of each bound.
const batchEnds = [
  base + 100,
  ...[125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375].map(
    (n) => base + n,
  ),
  cursor,
];

const sender = addr(0x301),
  trader = addr(0x401);
const pool = (n: number, launch: number, name: string) => ({
  id: hash(0x100 + n),
  token: addr(0x200 + n),
  name,
  symbol: name,
  launchBlock: base + launch,
  launchTx: hash(0x500 + n),
  launchSender: sender,
  launchedAt: ts(base + launch),
  decimals: 18,
});
// A trades in the hour before the window and inside the window's own UTC
// hour before its start (the price the window opens at), exactly at its
// start, and in the newest hour. B last traded five hours back. C launched
// inside the window. D's last trade before the window is three hours back,
// so its opening price is that hour's close. E never traded.
const pools = {
  A: pool(1, 1, "A"),
  B: pool(2, 2, "B"),
  C: pool(3, 340, "C"),
  D: pool(4, 3, "D"),
  E: pool(5, 4, "E"),
};
type Trade = [
  block: number,
  pool: typeof pools.A,
  side: "buy" | "sell",
  eth: bigint,
  sqrt: bigint,
];
const trades: Trade[] = [
  [base + 10, pools.A, "buy", E, 1000n * e30],
  [base + 100, pools.B, "buy", E, 900n * e30],
  [base + 200, pools.D, "buy", E, 700n * e30],
  [base + 305, pools.A, "buy", 2n * E, 1100n * e30],
  [base + 330, pools.A, "sell", 3n * E, 1050n * e30],
  [base + 345, pools.C, "buy", E, 500n * e30],
  [base + 350, pools.C, "buy", E, 450n * e30],
  [base + 360, pools.D, "buy", E, 650n * e30],
  [base + 385, pools.A, "buy", 4n * E, 1200n * e30],
];
/** wei per whole token: currency0 is ETH, currency1 the token. */
const price = (sqrt: bigint) => ((2n ** 192n * E) / (sqrt * sqrt)).toString();
const change = (latest: bigint, baseline: bigint) =>
  Number(
    ((baseline * baseline - latest * latest) * 10000n) / (latest * latest),
  ) / 100;

function batch(from: number, to: number): LedgerBatch {
  const swaps: LedgerSwap[] = [],
    transfers: LedgerTransfer[] = [];
  for (const [block, p, side, eth, sqrt] of trades) {
    if (block < from || block > to) continue;
    const site = {
      txHash: hash(BigInt(block) * 100n),
      block,
      blockHash: hash(block),
      timestamp: ts(block),
    };
    swaps.push({
      ...site,
      logIndex: 0,
      poolId: p.id,
      token: p.token,
      initiator: trader,
      txTo: ledgerRules.router,
      side,
      ethWei: eth.toString(),
      tokenRaw: "1000",
      sqrtPriceX96: sqrt.toString(),
      liquidity: "5",
      tick: 1,
    });
    transfers.push({
      ...site,
      logIndex: 1,
      token: p.token,
      from: side === "buy" ? ledgerRules.manager : trader,
      to: side === "buy" ? trader : ledgerRules.manager,
      value: "1000",
    });
  }
  return {
    from,
    to,
    parentHash: hash(from - 1),
    hash: hash(to),
    timestamp: ts(to),
    archiveHeight: to + ledgerStream.confirmations,
    registryPools: 5,
    query: { fixture: [from, to] },
    pages: [],
    requests: 1,
    bytes: 0,
    launches: [],
    swaps,
    transfers,
  };
}

test(
  "Postgres HTTP: MARKET_SOURCE=ledger serves 1h as the rolling hour in the ledger's live ring, hand-checked, and no 1h figure while the ring does not hold that hour",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema = "api_test_rollinghour_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    // The ledger's launch lane registers every pool below the cursor.
    await commitBatch(db, await ensureLedgerLaunchStream(db), {
      from: base,
      to: cursor,
      hash: hash(cursor),
      evidence: {},
      pools: Object.values(pools),
    });
    const reader = createReader(url, schema, { marketSource: "ledger" });
    const api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    let locked = false;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      if (locked) await releaseLedgerWriter(db);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    const get = async <T>(path: string) => {
      const response = await fetch(origin + path);
      const body = await response.json();
      assert.equal(response.status, 200, `${path} ${JSON.stringify(body)}`);
      return body as T;
    };
    const explore = (query: string) =>
      get<AnalyticsExploreResponse>(`/v1/explore?${query}&limit=100`);
    const ids = (r: AnalyticsExploreResponse) =>
      r.items.map(
        (row) => Object.entries(pools).find(([, p]) => p.id === row.id)![0],
      );

    await ensureLedgerStream(db, "tip");
    // The ledger writer lock is one per database; a sibling test file may
    // hold it.
    for (let i = 0; i < 600 && !locked; i++) {
      locked = await acquireLedgerWriter(db);
      if (!locked) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(locked, "ledger writer lock unavailable");
    let from = base;
    for (const to of batchEnds) {
      await applyLedgerBatch(db, batch(from, to));
      from = to + 1;
    }

    // The screener's default order: every covered launch, ranked on the
    // rolling hour's volume. A counts its trade exactly at the start and its
    // newest one, 3 + 4 ETH; its 2 ETH trade five minutes into the start's
    // UTC hour is the price the hour opened at, not part of it.
    const byVolume = await explore("window=1h&sort=volume");
    assert.equal(byVolume.total, 5);
    assert.deepEqual(ids(byVolume), ["A", "C", "D", "B", "E"]);
    const row = (r: AnalyticsExploreResponse, key: keyof typeof pools) =>
      r.items.find((item) => item.id === pools[key].id)! as AnalyticsPoolRow;
    assert.deepEqual(row(byVolume, "A").stats, {
      priceWei: price(1200n * e30),
      volumeWei: (7n * E).toString(),
      liquidityWei: null,
      change: change(1200n * e30, 1100n * e30),
      trades: 2,
      holders: null,
      completeWindow: true,
    });
    // C launched inside the hour: its volume is complete, and no change
    // since launch is labelled with the hour.
    assert.deepEqual(row(byVolume, "C").stats, {
      priceWei: price(450n * e30),
      volumeWei: (2n * E).toString(),
      liquidityWei: null,
      change: null,
      trades: 2,
      holders: null,
      completeWindow: true,
    });
    // D's hour opened at the close of its last hour with a trade, three
    // hours back, since it has no trade in the start's own UTC hour.
    assert.deepEqual(row(byVolume, "D").stats, {
      priceWei: price(650n * e30),
      volumeWei: E.toString(),
      liquidityWei: null,
      change: change(650n * e30, 700n * e30),
      trades: 1,
      holders: null,
      completeWindow: true,
    });
    // B traded before the hour and not inside it: a proven zero, unmoved.
    assert.deepEqual(row(byVolume, "B").stats, {
      priceWei: price(900n * e30),
      volumeWei: "0",
      liquidityWei: null,
      change: 0,
      trades: 0,
      holders: null,
      completeWindow: true,
    });
    // E never traded: zero flow is proven, nothing else is invented.
    assert.deepEqual(row(byVolume, "E").stats, {
      priceWei: null,
      volumeWei: "0",
      liquidityWei: null,
      change: null,
      trades: 0,
      holders: null,
      completeWindow: false,
    });
    for (const item of byVolume.items) {
      assert.equal(item.marketCoverage!.source, "aggregate_ledger");
      assert.equal(item.marketCoverage!.windowStart, start);
      assert.deepEqual(item.marketCoverage!.cutoff, {
        block: cursor,
        hash: hash(cursor),
        asOf,
      });
    }

    // Every other order ranks the same figures over the whole catalog.
    assert.deepEqual(ids(await explore("window=1h&sort=trades")), [
      "A",
      "C",
      "D",
      "B",
      "E",
    ]);
    assert.deepEqual(ids(await explore("window=1h&sort=change")), [
      "D",
      "B",
      "A",
    ]);
    assert.deepEqual(
      ids(await explore("window=1h&sort=change&direction=asc")),
      ["A", "B", "D"],
    );
    assert.deepEqual(ids(await explore("window=1h&view=gainers")), ["D"]);
    assert.deepEqual(ids(await explore("window=1h&view=gainers&sort=volume")), [
      "D",
    ]);
    const launchOrder = await explore("window=1h&sort=launch");
    assert.deepEqual(ids(launchOrder), ["C", "E", "D", "B", "A"]);
    for (const item of launchOrder.items)
      assert.deepEqual(
        item.stats,
        byVolume.items.find((other) => other.id === item.id)!.stats,
      );

    // The hour is the rolling one, not the newest hour's thirty minutes: 6h
    // is still whole hours (H-5 through H), so A's 2 ETH trade counts there.
    const sixHours = row(await explore("window=6h&sort=volume"), "A");
    assert.equal(sixHours.stats.volumeWei, (9n * E).toString());
    assert.equal(sixHours.stats.trades, 3);
    assert.equal(sixHours.marketCoverage!.windowStart, (H - 5) * 3600);

    // The pool page reads the same hour.
    const page = await get<{ market: Record<string, any> }>(
      `/v1/pools/${pools.A.id}?window=1h`,
    );
    assert.equal(page.market.volumeWei, (7n * E).toString());
    assert.equal(page.market.trades, 2);
    assert.equal(page.market.change, change(1200n * e30, 1100n * e30));
    assert.equal(page.market.coverage.windowStart, start);
    assert.equal(page.market.coverage.completeWindow, true);
    const dPage = await get<{ market: Record<string, any> }>(
      `/v1/pools/${pools.D.id}?window=1h`,
    );
    assert.equal(dPage.market.change, change(650n * e30, 700n * e30));
    assert.equal(dPage.market.trades, 1);

    // The creators aggregate measures each launch by the same rule.
    const creators = await get<CreatorsResponse>(
      "/v1/creators?window=1h&sort=volume",
    );
    assert.equal(creators.items.length, 1);
    assert.equal(creators.items[0].address, sender);
    assert.equal(creators.items[0].measured, 5);
    assert.equal(creators.items[0].traded, 3);
    assert.equal(creators.items[0].volumeWei, (10n * E).toString());

    await db.query(
      "DELETE FROM agg_live_trades WHERE chain_id=4663 AND block_number<$1",
      [base + 300],
    );
    const quiet = await explore("window=1h&sort=volume");
    assert.equal(quiet.total, 5);
    assert.deepEqual(ids(quiet), ids(byVolume));
    for (const item of quiet.items)
      assert.deepEqual(
        item.stats,
        byVolume.items.find((other) => other.id === item.id)!.stats,
      );
    const quietPage = await get<{ market: Record<string, any> }>(
      `/v1/pools/${pools.A.id}?window=1h`,
    );
    assert.equal(quietPage.market.volumeWei, page.market.volumeWei);
    assert.equal(quietPage.market.change, page.market.change);
    const quietCreators = await get<CreatorsResponse>(
      "/v1/creators?window=1h&sort=volume",
    );
    assert.deepEqual(quietCreators.items, creators.items);

    await db.query(
      "DELETE FROM agg_live_trades WHERE chain_id=4663 AND block_number<=$1",
      [base + 305],
    );
    const query = (sql: string, values?: unknown[]) => db.query(sql, values);
    const boundary = await ledgerCut(query);
    assert.ok(boundary);
    const count = await db.query(
      "SELECT count(*)::integer AS rows FROM agg_live_trades WHERE chain_id=4663",
    );
    assert.equal(count.rows[0].rows, 5);
    assert.equal(await ledgerHour(query, boundary, count.rows[0].rows), null);
    // Whole-hour windows never read the ring.
    assert.equal(
      row(await explore("window=6h&sort=volume"), "A").stats.volumeWei,
      (9n * E).toString(),
    );
  },
);
