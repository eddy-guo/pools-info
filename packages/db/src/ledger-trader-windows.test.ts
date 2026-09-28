// The trader rows (migration 025): the windows' sums without the positions
// in pools a wallet launched itself, which the trader board ranks, a
// contract never. Every figure below is derived by hand from the trades the
// fixture folds through the real writer.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const wallet = (n: number) => addr(0x10000 + n);
/** L launched P and trades only P; M launched R and trades R and Q; nobody
 * trading launched Q. */
const L = wallet(1),
  M = wallet(2),
  N = wallet(3),
  K = wallet(4),
  D = wallet(5);
const launch = (n: number, sender: string) => ({
  id: hash(0x100 + n),
  token: addr(0x200 + n),
  name: `Pool ${n}`,
  symbol: `P${n}`,
  launchBlock: 10 + n,
  launchTx: hash(101 + n),
  launchSender: sender,
  launchedAt: 100,
});
const P = launch(0, L),
  Q = launch(1, addr(0x201)),
  R = launch(2, M);

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
    pool: typeof P,
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
  /** `n` round trips in one block, each gaining `gain` wei. */
  roundTrips(
    block: number,
    who: string,
    pool: typeof P,
    n: number,
    gain: bigint,
  ) {
    for (let i = 0; i < n; i++)
      this.trade(block, who, "buy", E, 10n, pool).trade(
        block,
        who,
        "sell",
        E + gain,
        10n,
        pool,
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
async function setup(t: test.TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = "ledger_traders_" + randomUUID().replaceAll("-", "");
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
    pools: [P, Q, R],
  });
  await ensureLedgerStream(db, "tip");
  // The ledger writer lock is one per server; a sibling test file may hold it.
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return db;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
const columns = `x."window",'0x'||encode(w.address,'hex') AS wallet,x.realized_wei::text AS realized,x.net_wei::text AS net,
  x.volume_wei::text AS volume,x.disposed_cost_wei::text AS disposed,x.trades,x.supported_trades,x.wins,x.losses,
  x.closures,x.hold_seconds::text AS hold,x.flash_closures AS flash,x.best_wei::text AS best,x.last_timestamp::text AS last,
  x.supported_positions,x.excluded_positions`;
const rowsOf = async (db: Client, table: string) =>
  (
    await db.query(
      `SELECT ${columns}${table === "agg_wallet_windows" ? ",x.rank" : ""} FROM ${table} x JOIN agg_wallets w USING (wallet_ref) ORDER BY 1,2`,
    )
  ).rows;
const traders = (db: Client) => rowsOf(db, "agg_trader_windows");
const walletRows = (db: Client) => rowsOf(db, "agg_wallet_windows");
const ranks = async (db: Client, window: string) =>
  (
    await db.query(
      `SELECT '0x'||encode(w.address,'hex') AS wallet,x.rank FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
       WHERE x."window"=$1 AND x.rank IS NOT NULL ORDER BY x.rank`,
      [window],
    )
  ).rows;
const refreshes = async (db: Client) =>
  (
    await db.query(
      `SELECT "window",through_block::int AS through,window_start,wallets,ranked FROM agg_window_refreshes ORDER BY "window"`,
    )
  ).rows;
const all = <T extends { window: string; wallet: string }>(rows: T[]) =>
  Object.fromEntries(
    rows.filter((r) => r.window === "All").map((r) => [r.wallet, r]),
  );
/** The first fold: L six round trips in its own P (+100 wei each); M five
 * in its own R (+1,000) and three in Q (+7); N, K and D five each in Q (+50,
 * +40 and +30). */
const first = () =>
  new Rows()
    .roundTrips(base + 3, L, P, 6, 100n)
    .roundTrips(base + 3, M, R, 5, 1000n)
    .roundTrips(base + 4, M, Q, 3, 7n)
    .roundTrips(base + 4, N, Q, 5, 50n)
    .roundTrips(base + 4, K, Q, 5, 40n)
    .roundTrips(base + 4, D, Q, 5, 30n);

test("a trader row leaves out the wallet's own launches, the board ranks trader rows with the trade floor counted on them alone, and migration 025's fill is the writer's rebuild", async (t) => {
  const db = await setup(t);
  assert.deepEqual(
    (
      await db.query(
        `SELECT '0x'||encode(address,'hex') AS address,kind FROM wallet_code_observations`,
      )
    ).rows,
    [
      {
        address: "0x91f99c026126f60a35c4306cb288388848b48faf",
        kind: "contract",
      },
    ],
  );
  await applyLedgerBatch(db, batch(base, base + 9, first()));
  assert.ok(await refreshLedgerWindows(db));
  // The wallets' own rows keep every position: the profile is unchanged.
  const own = all(await walletRows(db));
  assert.deepEqual(
    [L, M, N].map((w) => [
      own[w].realized,
      own[w].supported_trades,
      own[w].supported_positions,
      own[w].rank,
    ]),
    [
      ["600", 12, 1, null],
      ["5021", 16, 2, null],
      ["250", 10, 1, 1],
    ],
  );
  // Trader rows: L has none, M its Q trades alone (six, under the floor of
  // ten, where its own row's sixteen would have cleared it), and a wallet
  // with no launch of its own the very row it has.
  const trader = all(await traders(db));
  assert.equal(trader[L], undefined);
  assert.deepEqual(trader[M], {
    window: "All",
    wallet: M,
    realized: "21",
    net: "21",
    volume: (6n * E + 21n).toString(),
    disposed: (3n * E).toString(),
    trades: 6,
    supported_trades: 6,
    wins: 3,
    losses: 0,
    closures: 3,
    hold: "0",
    flash: 3,
    best: "7",
    last: String(ts(base + 4)),
    supported_positions: 1,
    excluded_positions: 0,
  });
  for (const w of [N, K, D]) {
    const { rank: _rank, ...row } = own[w];
    assert.deepEqual(trader[w], row, w);
  }
  // Ranked on the trader rows: L and M, the two best by their own rows, are
  // not on the board.
  assert.deepEqual(await ranks(db, "All"), [
    { wallet: N, rank: 1 },
    { wallet: K, rank: 2 },
    { wallet: D, rank: 3 },
  ]);
  await db.query(
    `INSERT INTO wallet_code_observations(chain_id,address,kind,observed_at)
     VALUES (4663,decode($1,'hex'),'contract',now())`,
    [K.slice(2)],
  );
  await applyLedgerBatch(db, batch(base + 10, base + 11, new Rows()));
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  assert.deepEqual(await ranks(db, "All"), [
    { wallet: N, rank: 1 },
    { wallet: D, rank: 2 },
  ]);
  const writer = {
    traders: await traders(db),
    wallets: await walletRows(db),
    refreshes: await refreshes(db),
  };
  assert.equal(writer.refreshes.find((r) => r.window === "All")?.ranked, 2);
  // Migration 025's fill, run on the same rows from nothing, gives the
  // writer's trader rows, ranks and ranked counts exactly.
  const sql = await readFile(
    new URL("../migrations/025_trader_windows.sql", import.meta.url),
    "utf8",
  );
  const fillStart = sql.indexOf("DO $$");
  const fill = sql.slice(fillStart, sql.indexOf("END $$;", fillStart) + 7);
  await db.query("DELETE FROM agg_trader_windows");
  await db.query("UPDATE agg_wallet_windows SET rank=NULL");
  await db.query("UPDATE agg_window_refreshes SET ranked=0");
  await db.query("BEGIN");
  await db.query(fill);
  await db.query("COMMIT");
  assert.deepEqual(
    {
      traders: await traders(db),
      wallets: await walletRows(db),
      refreshes: await refreshes(db),
    },
    writer,
  );
});

test("the census's contracts never rank and its non-contract wallets do, from the next refresh", async (t) => {
  const db = await setup(t);
  await applyLedgerBatch(db, batch(base, base + 9, first()));
  assert.ok(await refreshLedgerWindows(db));
  const observe = (who: string, kind: string) =>
    db.query(
      `INSERT INTO wallet_code_observations(chain_id,address,kind,observed_at)
       VALUES (4663,decode($1,'hex'),$2,now())`,
      [who.slice(2), kind],
    );
  await observe(K, "contract");
  await observe(D, "none");
  await observe(N, "none");
  await assert.rejects(observe(wallet(9), "delegated"), /check/);
  // The next refresh (the cursor moved) applies them: K's rows stay, its
  // rank goes, and D keeps its place behind N.
  await applyLedgerBatch(
    db,
    batch(base + 10, base + 11, new Rows().roundTrips(base + 11, N, Q, 1, 1n)),
  );
  const refreshed = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(refreshed);
  assert.deepEqual(await ranks(db, "All"), [
    { wallet: N, rank: 1 },
    { wallet: D, rank: 2 },
  ]);
  assert.equal(refreshed.windows.find((w) => w.window === "All")!.ranked, 2);
  assert.ok(all(await traders(db))[K]);
  assert.ok(all(await walletRows(db))[K]);
  // A rebuild ranks the same.
  assert.ok(await refreshLedgerWindows(db, { rebuild: true }));
  assert.deepEqual(await ranks(db, "All"), [
    { wallet: N, rank: 1 },
    { wallet: D, rank: 2 },
  ]);
});

test("incremental refreshes, hours leaving a window and a walk-back keep every trader row equal to a rebuild", async (t) => {
  const db = await setup(t);
  await applyLedgerBatch(db, batch(base, base + 9, first()));
  assert.ok(await refreshLedgerWindows(db));
  const afterFirst = {
    traders: await traders(db),
    wallets: await walletRows(db),
  };
  // Seven hours on: M trades only its own R (so its trader row only loses
  // hours), L trades Q for the first time (its first trader row), and every
  // earlier hour leaves 1h and 6h.
  const later = base + 73;
  assert.equal(hourOf(later) - hourOf(base + 4), 7);
  await applyLedgerBatch(
    db,
    batch(
      base + 10,
      later,
      new Rows()
        .roundTrips(later, M, R, 2, 500n)
        .roundTrips(later, L, Q, 1, 3n),
    ),
  );
  const moved = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(moved);
  assert.ok(moved.windows.every((w) => w.mode === "incremental"));
  const incremental = {
    traders: await traders(db),
    wallets: await walletRows(db),
  };
  const sixHours = incremental.traders.filter((r) => r.window === "6h");
  assert.deepEqual(
    sixHours.map((r) => [r.wallet, r.realized, r.trades]),
    [[L, "3", 2]],
  );
  assert.equal(all(incremental.traders)[L].realized, "3");
  assert.equal(all(incremental.traders)[M].realized, "21");
  assert.equal(all(incremental.wallets)[M].realized, "6021");
  assert.ok(await refreshLedgerWindows(db, { rebuild: true }));
  assert.deepEqual(
    { traders: await traders(db), wallets: await walletRows(db) },
    incremental,
  );
  // Walking the later batch back takes the refresh state with it; the next
  // refresh rebuilds both row sets as they were.
  await walkBackLedger(db, base + 9);
  assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
  assert.deepEqual(
    { traders: await traders(db), wallets: await walletRows(db) },
    afterFirst,
  );
});
