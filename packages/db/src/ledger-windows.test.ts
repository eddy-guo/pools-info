import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LedgerSwap, LedgerTransfer } from "@pools/core";
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
  walkBackLedger,
  type Client,
  type LedgerBatch,
} from "./index";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated test Postgres instance; DATABASE_URL is never used by these tests",
  );
const E = 10n ** 18n;
const hash = (n: number | bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = ledgerStream.start;
/** 400 seconds per block: nine blocks to the hour. */
const ts = (block: number) => 1_000_000 + (block - base) * 400;
const hourOf = (block: number) => Math.floor(ts(block) / 3600);
const pool = {
  id: hash(0x100),
  token: addr(0x200),
  name: "Pool",
  symbol: "P",
  launchBlock: 10,
  launchTx: hash(101),
  launchSender: addr(0x201),
  launchedAt: 100,
};
const wallet = (n: number) => addr(0x10000 + n);

/** A batch's rows: each trade is a swap and its manager transfer in its own
 * transaction, log indexes counted per block. */
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
  ) {
    const i = this.logs.get(block) ?? 0;
    this.logs.set(block, i + 2);
    const txHash = hash(BigInt(block) * 100000n + BigInt(i));
    const site = {
      txHash,
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
  /** `n` buy-and-sell round trips in one block, each closing a cycle held
   * 0 seconds, gaining `profit` wei per trip. */
  roundTrips(block: number, who: string, n: number, profit: bigint) {
    for (let i = 0; i < n; i++)
      this.trade(block, who, "buy", E, 10n).trade(
        block,
        who,
        "sell",
        E + profit,
        10n,
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
    registryPools: 1,
    query: { fixture: [from, to] },
    pages: [],
    requests: 1,
    bytes: 0,
    launches: [],
    swaps: rows.swaps,
    transfers: rows.transfers,
  };
}
async function setup(t: test.TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = "ledger_windows_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  await commitBatch(db, await ensureDiscovery(db, 10), {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool],
  });
  await ensureLedgerStream(db, "tip");
  // The ledger writer lock is one per server; a sibling test file may hold it.
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return db;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
/** Every window row with the wallet's address, amounts as text; the start a
 * row was summed from and the refresh time are left out, since an
 * incremental row keeps its own start while a rebuilt row takes the current. */
async function windows(db: Client) {
  const r = await db.query(
    `SELECT x."window",'0x'||encode(w.address,'hex') AS wallet,x.realized_wei::text AS realized,x.net_wei::text AS net,
       x.volume_wei::text AS volume,x.disposed_cost_wei::text AS disposed,x.trades,x.supported_trades,x.wins,x.losses,
       x.closures,x.hold_seconds::text AS hold,x.flash_closures AS flash,x.best_wei::text AS best,x.last_timestamp::text AS last,
       x.supported_positions,x.excluded_positions,x.rank
     FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref) ORDER BY 1,2`,
  );
  return r.rows;
}
async function refreshes(db: Client) {
  return (
    await db.query(
      `SELECT "window",through_block::int AS through,window_start,wallets,ranked FROM agg_window_refreshes ORDER BY "window"`,
    )
  ).rows;
}
const ranks = async (db: Client, window: string) =>
  (
    await db.query(
      `SELECT '0x'||encode(w.address,'hex') AS wallet,x.rank FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
       WHERE x."window"=$1 AND x.rank IS NOT NULL ORDER BY x.rank`,
      [window],
    )
  ).rows;

test("a first refresh builds every window from the hour rows and ranks the eligible top by realized, the address breaking ties", async (t) => {
  const db = await setup(t);
  // 102 eligible wallets (ten trades each), realized 5 x i wei, wallets 1 and
  // 2 tied at the top; wallet 103 realized the most over nine trades and is
  // not eligible.
  const rows = new Rows();
  for (let i = 1; i <= 102; i++)
    rows.roundTrips(base + 3, wallet(i), 5, BigInt(i <= 2 ? 1000 : i));
  rows
    .roundTrips(base + 4, wallet(103), 4, E)
    .trade(base + 4, wallet(103), "buy", E, 10n);
  await applyLedgerBatch(db, batch(base, base + 9, rows));
  const refreshed = await refreshLedgerWindows(db);
  assert.ok(refreshed);
  assert.deepEqual(
    refreshed.windows.map((w) => [w.window, w.mode, w.wallets, w.ranked]),
    ledgerWindowPolicy.windows.map((w) => [w, "rebuilt", 103, 100]),
  );
  assert.equal(refreshed.throughBlock, base + 9);
  const cursorHour = hourOf(base + 9);
  assert.deepEqual(
    await refreshes(db),
    [
      ["1h", cursorHour],
      ["24h", cursorHour - 23],
      ["30d", Math.max(0, cursorHour - 719)],
      ["6h", cursorHour - 5],
      ["7d", Math.max(0, cursorHour - 167)],
      ["All", 0],
    ].map(([window, start]) => ({
      window,
      through: base + 9,
      window_start: start,
      wallets: 103,
      ranked: 100,
    })),
  );
  // Ranks: realized descending, the tie broken by address, the top 100 only.
  const all = await ranks(db, "All");
  assert.equal(all.length, 100);
  assert.deepEqual(all.slice(0, 3), [
    { wallet: wallet(1), rank: 1 },
    { wallet: wallet(2), rank: 2 },
    { wallet: wallet(102), rank: 3 },
  ]);
  assert.deepEqual(all.slice(-2), [
    { wallet: wallet(6), rank: 99 },
    { wallet: wallet(5), rank: 100 },
  ]);
  for (const outside of [wallet(4), wallet(3), wallet(103)])
    assert.ok(!all.some((r) => r.wallet === outside));
  // One wallet's figures, summed from its hour rows and its position.
  const rowOf = (w: string) =>
    windows(db).then((x) => x.filter((r) => r.wallet === w));
  const [w5] = (await rowOf(wallet(5))).filter((r) => r.window === "All");
  assert.deepEqual(w5, {
    window: "All",
    wallet: wallet(5),
    realized: "25",
    net: "25",
    volume: (10n * E + 25n).toString(),
    disposed: (5n * E).toString(),
    trades: 10,
    supported_trades: 10,
    wins: 5,
    losses: 0,
    closures: 5,
    hold: "0",
    flash: 5,
    best: "5",
    last: String(ts(base + 3)),
    supported_positions: 1,
    excluded_positions: 0,
    rank: 100,
  });
  // Nothing new: not due, whatever the interval.
  assert.equal(await refreshLedgerWindows(db, { minIntervalMs: 0 }), null);
  assert.equal(await refreshLedgerWindows(db, { force: true }), null);
});

test("later refreshes recompute only the wallets that changed or left a window, and equal a rebuild", async (t) => {
  const db = await setup(t);
  const first = new Rows();
  for (let i = 1; i <= 12; i++)
    first.roundTrips(base + 3, wallet(i), 5, BigInt(i) * 1000n);
  await applyLedgerBatch(db, batch(base, base + 9, first));
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  // Two hours on: wallet 1 trades again, wallet 13 appears, wallet 2 sells
  // more than the ledger holds (its position is excluded, its finances gone).
  const second = new Rows()
    .roundTrips(base + 20, wallet(1), 3, 7n)
    .roundTrips(base + 20, wallet(13), 5, 1n)
    .trade(base + 21, wallet(2), "sell", E, 5n);
  await applyLedgerBatch(db, batch(base + 10, base + 29, second));
  const incremental = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(incremental);
  for (const w of incremental.windows) {
    assert.equal(w.mode, "incremental", w.window);
    // The touched wallets, and on the short windows the ones whose hour left.
    assert.ok(w.recomputed >= 3 && w.recomputed <= 13, `${w.window}`);
  }
  // The cursor (base + 29) sits in the hour after the second batch's trades,
  // so 1h holds nobody and recomputed every wallet whose hour left it.
  assert.equal(hourOf(base + 29), hourOf(base + 21) + 1);
  const oneHour = incremental.windows.find((w) => w.window === "1h")!;
  assert.equal(oneHour.recomputed, 13);
  assert.deepEqual(
    incremental.windows.map((w) => w.wallets),
    [0, 13, 13, 13, 13, 13],
  );
  const [excluded] = (await windows(db)).filter(
    (r) => r.window === "All" && r.wallet === wallet(2),
  );
  assert.deepEqual(
    [
      excluded.realized,
      excluded.supported_trades,
      excluded.trades,
      excluded.excluded_positions,
      excluded.rank,
    ],
    ["0", 0, 11, 1, null],
  );
  const afterSecond = await windows(db);
  assert.ok(await refreshLedgerWindows(db, { rebuild: true }));
  assert.deepEqual(await windows(db), afterSecond);
  // Two days on: every earlier hour leaves the timed windows but 7d and 30d.
  const later = base + 30 + 432;
  const third = new Rows().roundTrips(later, wallet(3), 5, 9n);
  await applyLedgerBatch(db, batch(base + 30, later + 1, third));
  const moved = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(moved);
  assert.deepEqual(
    moved.windows.map((w) => [w.window, w.mode, w.wallets]),
    [
      ["1h", "incremental", 1],
      ["6h", "incremental", 1],
      ["24h", "incremental", 1],
      ["7d", "incremental", 13],
      ["30d", "incremental", 13],
      ["All", "incremental", 13],
    ],
  );
  const afterThird = await windows(db);
  assert.ok(await refreshLedgerWindows(db, { rebuild: true }));
  assert.deepEqual(await windows(db), afterThird);
  assert.deepEqual(await ranks(db, "24h"), [{ wallet: wallet(3), rank: 1 }]);
});

test("hours leaving a window come off the rows of wallets the batches did not touch, and every case equals a rebuild", async (t) => {
  const db = await setup(t);
  // Hour h0 (blocks base+2..10) and h0+3 (base+29..37); nine blocks an hour.
  const h0 = hourOf(base + 2);
  assert.deepEqual([hourOf(base + 10), hourOf(base + 29)], [h0, h0 + 3]);
  const first = new Rows()
    // 1: its best sale three hours later, so h0's sums come off.
    .roundTrips(base + 3, wallet(1), 1, 5n)
    // 2: its best sale in h0, so it is summed again.
    .roundTrips(base + 3, wallet(2), 1, 90n)
    // 3: an unfolded closure three hours later (flash stays unknown).
    .roundTrips(base + 3, wallet(3), 1, 5n)
    // 4: an unfolded closure in h0, the only one (flash becomes known).
    .roundTrips(base + 3, wallet(4), 1, 5n)
    // 5: only h0, so it leaves the window.
    .roundTrips(base + 3, wallet(5), 1, 5n);
  await applyLedgerBatch(db, batch(base, base + 10, first));
  const second = new Rows();
  for (const w of [1, 2, 3, 4]) second.roundTrips(base + 30, wallet(w), 2, 50n);
  await applyLedgerBatch(db, batch(base + 11, base + 37, second));
  const hourRow = async (w: number, block: number) =>
    `wallet_ref=(SELECT wallet_ref FROM agg_wallets WHERE address=decode('${wallet(w).slice(2)}','hex')) AND hour=${hourOf(block)}`;
  await db.query(
    `UPDATE agg_wallet_hours SET flash_closures=NULL WHERE ${await hourRow(3, base + 30)}`,
  );
  await db.query(
    `UPDATE agg_wallet_hours SET flash_closures=NULL WHERE ${await hourRow(4, base + 3)}`,
  );
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  // Three hours on: 6h starts after h0; wallet 9 is the only one touched.
  const later = base + 38 + 18;
  assert.equal(hourOf(later), h0 + 6);
  await applyLedgerBatch(
    db,
    batch(base + 38, later, new Rows().roundTrips(later, wallet(9), 1, 1n)),
  );
  const moved = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(moved);
  const sixHours = moved.windows.find((w) => w.window === "6h")!;
  assert.deepEqual(
    [sixHours.mode, sixHours.recomputed, sixHours.subtracted, sixHours.wallets],
    ["incremental", 6, 2, 5],
  );
  const rows = Object.fromEntries(
    (await windows(db))
      .filter((r) => r.window === "6h")
      .map((r) => [r.wallet, [r.trades, r.best, r.flash]]),
  );
  assert.deepEqual(rows, {
    [wallet(1)]: [4, "50", 2],
    [wallet(2)]: [4, "50", 2],
    [wallet(3)]: [4, "50", null],
    [wallet(4)]: [4, "50", 2],
    [wallet(9)]: [2, "1", 1],
  });
  const incremental = await windows(db);
  assert.ok(await refreshLedgerWindows(db, { rebuild: true }));
  assert.deepEqual(await windows(db), incremental);
});

test("a refresh is not due inside its interval unless the cursor's hour moved, and needs the writer lock", async (t) => {
  const db = await setup(t);
  await applyLedgerBatch(
    db,
    batch(base, base + 3, new Rows().roundTrips(base + 3, wallet(1), 1, 1n)),
  );
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  // Same hour, inside the interval: not due; forced: refreshed.
  await applyLedgerBatch(
    db,
    batch(
      base + 4,
      base + 6,
      new Rows().roundTrips(base + 6, wallet(2), 1, 1n),
    ),
  );
  assert.equal(hourOf(base + 6), hourOf(base + 3));
  assert.equal(
    await refreshLedgerWindows(db, { minIntervalMs: 3_600_000 }),
    null,
  );
  assert.ok(
    await refreshLedgerWindows(db, { minIntervalMs: 3_600_000, force: true }),
  );
  // The next hour: due inside the interval.
  await applyLedgerBatch(
    db,
    batch(
      base + 7,
      base + 12,
      new Rows().roundTrips(base + 12, wallet(3), 1, 1n),
    ),
  );
  assert.notEqual(hourOf(base + 12), hourOf(base + 6));
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 3_600_000 }));
  await db.query("SELECT pg_advisory_unlock(4663, 19005)");
  await assert.rejects(
    refreshLedgerWindows(db, { force: true }),
    /ledger_writer_required/,
  );
});

test("a walk-back takes the refresh state with its batch and the windows of the wallets it deletes, and the next refresh rebuilds", async (t) => {
  const db = await setup(t);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, new Rows().roundTrips(base + 3, wallet(1), 5, 3n)),
  );
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  const afterA = await windows(db);
  await applyLedgerBatch(
    db,
    batch(
      base + 10,
      base + 19,
      new Rows()
        .roundTrips(base + 12, wallet(9), 5, 4n)
        .roundTrips(base + 12, wallet(1), 1, 1n),
    ),
  );
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  assert.ok((await windows(db)).some((r) => r.wallet === wallet(9)));
  // The refresh reflected batch B; walking B back removes wallet 9 (a window
  // row still names it) and the refresh state that pointed at B.
  await walkBackLedger(db, base + 9);
  assert.deepEqual(await refreshes(db), []);
  assert.ok(!(await windows(db)).some((r) => r.wallet === wallet(9)));
  const rebuilt = await refreshLedgerWindows(db, { minIntervalMs: 3_600_000 });
  assert.ok(rebuilt);
  assert.ok(rebuilt.windows.every((w) => w.mode === "rebuilt"));
  assert.deepEqual(await windows(db), afterA);
});

test("a window's flash closures are unknown while it holds a closure from before the fold, and a batch without a journal size forces a rebuild", async (t) => {
  const db = await setup(t);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, new Rows().roundTrips(base + 3, wallet(1), 5, 3n)),
  );
  // Hour rows restored from before migration 020 carry no flash count.
  await db.query("UPDATE agg_wallet_hours SET flash_closures=NULL");
  const later = base + 10 + 432;
  await applyLedgerBatch(
    db,
    batch(base + 10, later, new Rows().roundTrips(later, wallet(1), 2, 1n)),
  );
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  const flash = async () =>
    Object.fromEntries(
      (await windows(db)).map((r) => [r.window, [r.closures, r.flash]]),
    );
  assert.deepEqual(await flash(), {
    "1h": [2, 2],
    "6h": [2, 2],
    "24h": [2, 2],
    "7d": [7, null],
    "30d": [7, null],
    All: [7, null],
  });
  // A batch without a journal size (committed before migration 020) cannot
  // name the wallets it changed: the next refresh rebuilds.
  await applyLedgerBatch(
    db,
    batch(
      later + 1,
      later + 2,
      new Rows().roundTrips(later + 2, wallet(2), 1, 1n),
    ),
  );
  await db.query("UPDATE agg_batches SET journal_rows=NULL WHERE to_block=$1", [
    later + 2,
  ]);
  const refreshed = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(refreshed);
  assert.ok(refreshed.windows.every((w) => w.mode === "rebuilt"));
});
