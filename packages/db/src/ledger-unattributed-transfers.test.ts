// Migration 022: a transfer the ledger did not attribute to a swap excludes
// the position, in (zero_cost_inflow) or out (unattributed_outflow). The
// fold's side is in packages/core/src/ledger.test.ts; this file proves the
// database side on rows written under the old rule (an actual pre-022
// ledger, built through migrations 001 to 021 and the writer, with the rows
// the old fold wrote for the farm and the sender hand-laid, since the fold no
// longer produces them): the re-flag, the hour rows, the journal's
// pre-images, the windows rebuilt and re-ranked inside the migration and
// equal to the writer's own rebuild, a walk-back over the rewritten
// pre-images, and the writer carrying the rule forward.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
/** 400 seconds per block: blocks base+2 to base+10 share hour 278. */
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
const bought = addr(0x10001),
  farm = addr(0x10002),
  bigFarm = addr(0x10003),
  unknown = addr(0x10004),
  recipient = addr(0x10005),
  sender = addr(0x10006),
  mover = addr(0x10007);
const migration = "022_unattributed_transfers_exclude.sql";

class Rows {
  swaps: LedgerSwap[] = [];
  transfers: LedgerTransfer[] = [];
  private logs = new Map<number, number>();
  private next(block: number, n: number) {
    const i = this.logs.get(block) ?? 0;
    this.logs.set(block, i + n);
    return {
      i,
      site: {
        txHash: hash(BigInt(block) * 100000n + BigInt(i)),
        block,
        blockHash: hash(block),
        timestamp: ts(block),
      },
    };
  }
  trade(
    block: number,
    who: string,
    side: "buy" | "sell",
    eth: bigint,
    tokens: bigint,
  ) {
    const { i, site } = this.next(block, 2);
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
  /** A plain transfer between wallets, no swap in its transaction. */
  move(block: number, from: string, to: string, tokens: bigint) {
    const { i, site } = this.next(block, 1);
    this.transfers.push({
      ...site,
      logIndex: i,
      token: pool.token,
      from,
      to,
      value: tokens.toString(),
    });
    return this;
  }
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
/** A schema at migration 021, the ledger stream and the writer lock. */
async function setupBefore022(t: test.TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = "ledger_zero_cost_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await db.query(
    "CREATE TABLE pools_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const dir = new URL("../migrations/", import.meta.url);
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes(migration));
  // Under migrate()'s own lock: a sibling file's migrate() on a fresh
  // database creates the same extension at the same moment otherwise.
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(4663, 19001)");
  for (const name of names) {
    if (name >= migration) break;
    const sql = await readFile(new URL(name, dir), "utf8");
    await db.query(sql);
    await db.query(
      "INSERT INTO pools_schema_migrations(name,checksum) VALUES ($1,$2)",
      [name, createHash("sha256").update(sql).digest("hex")],
    );
  }
  await db.query("COMMIT");
  await commitBatch(db, await ensureDiscovery(db, 10), {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool],
  });
  await ensureLedgerStream(db, "tip");
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return db;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
const positions = async (db: Client) =>
  (
    await db.query(
      `SELECT '0x'||encode(w.address,'hex') AS wallet,p.quantity_raw::text AS quantity,p.proceeds_wei::text AS proceeds,
         p.realized_wei::text AS realized,p.inflow_raw::text AS inflow,p.buys,p.sells,p.supported,p.flags
       FROM agg_positions p JOIN agg_wallets w USING (wallet_ref) ORDER BY w.address`,
    )
  ).rows;
const hours = async (db: Client) =>
  (
    await db.query(
      `SELECT '0x'||encode(w.address,'hex') AS wallet,h.hour,h.realized_wei::text AS realized,h.proceeds_wei::text AS proceeds,
         h.spent_wei::text AS spent,h.volume_wei::text AS volume,h.buys,h.sells,h.supported_trades,h.wins,h.closures,
         h.hold_seconds::text AS hold,h.flash_closures AS flash,h.best_wei::text AS best
       FROM agg_wallet_hours h JOIN agg_wallets w USING (wallet_ref) ORDER BY w.address,h.hour`,
    )
  ).rows;
const journal = async (db: Client) =>
  (
    await db.query(
      `SELECT batch_end::int AS batch_end,"table",key,before FROM agg_journal ORDER BY batch_end,"table",key`,
    )
  ).rows;
const windows = async (db: Client) =>
  (
    await db.query(
      `SELECT x."window",'0x'||encode(w.address,'hex') AS wallet,x.realized_wei::text AS realized,x.net_wei::text AS net,
         x.volume_wei::text AS volume,x.disposed_cost_wei::text AS disposed,x.trades,x.supported_trades,x.wins,x.losses,
         x.closures,x.hold_seconds::text AS hold,x.flash_closures AS flash,x.best_wei::text AS best,x.last_timestamp::text AS last,
         x.supported_positions,x.excluded_positions,x.rank,x.window_start
       FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref) ORDER BY 1,2`,
    )
  ).rows;
const refreshes = async (db: Client) =>
  (
    await db.query(
      `SELECT "window",through_block::int AS through,through_timestamp::int AS through_timestamp,window_start,wallets,ranked FROM agg_window_refreshes ORDER BY "window"`,
    )
  ).rows;
const zeroed = {
  realized: "0",
  proceeds: "0",
  spent: "0",
  supported_trades: 0,
  wins: 0,
  closures: 0,
  hold: "0",
  flash: 0,
  best: null,
};

test("migration 022 excludes every position with a zero-cost inflow or an unattributed outflow, zeroes their hours and pre-images, rebuilds the windows as the writer would, and the writer carries the rule on", async (t) => {
  const db = await setupBefore022(t);
  const h = hourOf(base + 3);
  assert.equal(h, hourOf(base + 10));
  assert.equal(h + 1, hourOf(base + 11));
  // Batch 1 through the writer: the bought wallet's five round trips (ten
  // supported trades, 5,000 wei realized), and a wallet selling five tokens
  // it never bought (excluded with unknown_basis, its hour already zero).
  await applyLedgerBatch(
    db,
    batch(
      base,
      base + 9,
      new Rows()
        .roundTrips(base + 3, bought, 5, 1000n)
        .trade(base + 5, unknown, "sell", E, 5n),
    ),
  );
  // Batch 2 through the writer: one more buy for the bought wallet in the
  // next hour, so its position and hour rows have real pre-images.
  await applyLedgerBatch(
    db,
    batch(
      base + 10,
      base + 19,
      new Rows().trade(base + 12, bought, "buy", E, 10n),
    ),
  );
  // The rows the old fold wrote and the old XOR admitted: supported
  // positions carrying zero_cost_inflow whose sales were booked whole, and a
  // supported position that moved most of what it bought away with no flag
  // at all. `farm` received 100 in batch 1 and sold 40 for 1 ETH there, then
  // 60 for 3 ETH in batch 2 in the same hour, so batch 2 journaled its
  // position and hour after the first sale; `bigFarm` sold ten times in
  // batch 1 for 10 ETH, enough for the rank gate, and outranks everyone;
  // `sender` bought 100 for 1 ETH in batch 1 and sent 90 away in it (a tenth
  // of the basis kept), then sold 5 for 0.5 ETH in batch 2's hour.
  const refs = new Map<string, number>();
  for (const [address, first] of [
    [farm, base + 8],
    [bigFarm, base + 3],
    [sender, base + 6],
  ] as const) {
    const r = await db.query(
      "INSERT INTO agg_wallets(address,first_block) VALUES (decode($1,'hex'),$2) RETURNING wallet_ref",
      [address.slice(2), first],
    );
    refs.set(address, r.rows[0].wallet_ref);
  }
  const poolRef = (
    await db.query("SELECT pool_ref FROM indexed_pools WHERE pool_id=$1", [
      pool.id,
    ])
  ).rows[0].pool_ref as number;
  const position = (
    wallet: string,
    p: {
      quantity: bigint;
      cost?: bigint;
      invested?: bigint;
      proceeds: bigint;
      disposed?: bigint;
      inflow?: bigint;
      outflow?: bigint;
      outflowCost?: bigint;
      buys?: number;
      sells: number;
      cycleOpenedAt: number | null;
      closed: number;
      shortest: number | null;
      first: number;
      last: number;
      flags: string[];
    },
  ) => ({
    pool_ref: poolRef,
    wallet_ref: refs.get(wallet)!,
    quantity_raw: p.quantity.toString(),
    cost_wei: (p.cost ?? 0n).toString(),
    invested_wei: (p.invested ?? 0n).toString(),
    proceeds_wei: p.proceeds.toString(),
    disposed_cost_wei: (p.disposed ?? 0n).toString(),
    realized_wei: (p.proceeds - (p.disposed ?? 0n)).toString(),
    inflow_raw: (p.inflow ?? 0n).toString(),
    outflow_raw: (p.outflow ?? 0n).toString(),
    outflow_cost_wei: (p.outflowCost ?? 0n).toString(),
    buys: p.buys ?? 0,
    sells: p.sells,
    wrapper_swaps: 0,
    counterparty_swaps: 0,
    cycle_opened_at: p.cycleOpenedAt,
    cycle_gain_wei:
      p.cycleOpenedAt === null
        ? null
        : (p.proceeds - (p.disposed ?? 0n)).toString(),
    closed_cycles: p.closed,
    flash_cycles: 0,
    shortest_cycle_seconds: p.shortest,
    first_block: p.first,
    last_block: p.last,
    last_timestamp: ts(p.last),
    supported: true,
    flags: p.flags,
  });
  const hour = (
    wallet: string,
    x: {
      hour?: number;
      proceeds: bigint;
      disposed?: bigint;
      spent?: bigint;
      buys?: number;
      sells: number;
      wins?: number;
      closures?: number;
      hold?: number;
      best?: bigint | null;
    },
  ) => ({
    wallet_ref: refs.get(wallet)!,
    pool_ref: poolRef,
    hour: x.hour ?? h,
    realized_wei: (x.proceeds - (x.disposed ?? 0n)).toString(),
    disposed_cost_wei: (x.disposed ?? 0n).toString(),
    proceeds_wei: x.proceeds.toString(),
    spent_wei: (x.spent ?? 0n).toString(),
    volume_wei: (x.proceeds + (x.spent ?? 0n)).toString(),
    buys: x.buys ?? 0,
    sells: x.sells,
    supported_trades: (x.buys ?? 0) + x.sells,
    wins: x.wins ?? 0,
    losses: 0,
    closures: x.closures ?? 0,
    hold_seconds: x.hold ?? 0,
    flash_closures: 0,
    best_wei:
      x.best === undefined || x.best === null ? null : x.best.toString(),
  });
  const insertRows = async (table: string, rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const keys = Object.keys(row);
      await db.query(
        `INSERT INTO ${table}(chain_id,${keys.join(",")}) VALUES (4663,${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map((k) => row[k]),
      );
    }
  };
  const tenth = E / 10n;
  // Batch 2's pre-images of the farm and the sender, taken with to_jsonb
  // from the rows as the writer takes them, then the rows brought to their
  // final state.
  await insertRows("agg_positions", [
    position(farm, {
      quantity: 60n,
      proceeds: E,
      inflow: 100n,
      sells: 1,
      cycleOpenedAt: ts(base + 8),
      closed: 0,
      shortest: null,
      first: base + 8,
      last: base + 9,
      flags: ["zero_cost_inflow"],
    }),
    position(sender, {
      quantity: 10n,
      cost: tenth,
      invested: E,
      proceeds: 0n,
      outflow: 90n,
      outflowCost: 9n * tenth,
      buys: 1,
      sells: 0,
      cycleOpenedAt: ts(base + 6),
      closed: 0,
      shortest: null,
      first: base + 6,
      last: base + 7,
      flags: [],
    }),
  ]);
  await insertRows("agg_wallet_hours", [
    hour(farm, { proceeds: E, sells: 1, best: E }),
    hour(sender, { proceeds: 0n, spent: E, buys: 1, sells: 0 }),
  ]);
  await db.query(
    `INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
     SELECT 4663,$1::text,$2::bigint,'agg_positions',jsonb_build_object('pool_ref',p.pool_ref,'wallet_ref',p.wallet_ref),to_jsonb(p) FROM agg_positions p WHERE p.wallet_ref=ANY($3::int[])
     UNION ALL
     SELECT 4663,$1::text,$2::bigint,'agg_wallet_hours',jsonb_build_object('wallet_ref',h.wallet_ref,'pool_ref',h.pool_ref,'hour',h.hour),to_jsonb(h) FROM agg_wallet_hours h WHERE h.wallet_ref=$4::int`,
    [
      ledgerStream.key,
      base + 19,
      [refs.get(farm)!, refs.get(sender)!],
      refs.get(farm)!,
    ],
  );
  await db.query("DELETE FROM agg_wallet_hours WHERE wallet_ref=$1", [
    refs.get(farm)!,
  ]);
  await db.query("DELETE FROM agg_positions WHERE wallet_ref=ANY($1::int[])", [
    [refs.get(farm)!, refs.get(sender)!],
  ]);
  await insertRows("agg_positions", [
    position(farm, {
      quantity: 0n,
      proceeds: 4n * E,
      inflow: 100n,
      sells: 2,
      cycleOpenedAt: null,
      closed: 1,
      shortest: 800,
      first: base + 8,
      last: base + 10,
      flags: ["zero_cost_inflow"],
    }),
    position(bigFarm, {
      quantity: 0n,
      proceeds: 10n * E,
      inflow: 1000n,
      sells: 10,
      cycleOpenedAt: null,
      closed: 1,
      shortest: 1600,
      first: base + 3,
      last: base + 7,
      flags: ["zero_cost_inflow"],
    }),
    position(sender, {
      quantity: 5n,
      cost: tenth / 2n,
      invested: E,
      proceeds: 5n * tenth,
      disposed: tenth / 2n,
      outflow: 90n,
      outflowCost: 9n * tenth,
      buys: 1,
      sells: 1,
      cycleOpenedAt: ts(base + 6),
      closed: 0,
      shortest: null,
      first: base + 6,
      last: base + 13,
      flags: [],
    }),
  ]);
  await insertRows("agg_wallet_hours", [
    hour(farm, {
      proceeds: 4n * E,
      sells: 2,
      wins: 1,
      closures: 1,
      hold: 800,
      best: 3n * E,
    }),
    hour(bigFarm, {
      proceeds: 10n * E,
      sells: 10,
      wins: 1,
      closures: 1,
      hold: 1600,
      best: 5n * E,
    }),
    hour(sender, {
      hour: h + 1,
      proceeds: 5n * tenth,
      disposed: tenth / 2n,
      sells: 1,
      best: (9n * tenth) / 2n,
    }),
  ]);
  // Created by batch 1 (null pre-images): the farms and the sender with
  // their first hour; the sender's second hour by batch 2. Each batch's
  // journal size follows, as walk-back checks it.
  const key = (wallet: string, hourKey: number | null = null) =>
    hourKey === null
      ? { pool_ref: poolRef, wallet_ref: refs.get(wallet)! }
      : { wallet_ref: refs.get(wallet)!, pool_ref: poolRef, hour: hourKey };
  const created: [number, string, object][] = [
    [base + 9, "agg_wallets", { wallet_ref: refs.get(farm)! }],
    [base + 9, "agg_wallets", { wallet_ref: refs.get(bigFarm)! }],
    [base + 9, "agg_wallets", { wallet_ref: refs.get(sender)! }],
    [base + 9, "agg_positions", key(farm)],
    [base + 9, "agg_positions", key(bigFarm)],
    [base + 9, "agg_positions", key(sender)],
    [base + 9, "agg_wallet_hours", key(farm, h)],
    [base + 9, "agg_wallet_hours", key(bigFarm, h)],
    [base + 9, "agg_wallet_hours", key(sender, h)],
    [base + 19, "agg_wallet_hours", key(sender, h + 1)],
  ];
  for (const [end, table, k] of created)
    await db.query(
      `INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before) VALUES (4663,$1,$2,$3,$4::jsonb,NULL)`,
      [ledgerStream.key, end, table, JSON.stringify(k)],
    );
  await db.query(
    `UPDATE agg_batches b SET journal_rows=(SELECT count(*) FROM agg_journal j WHERE j.chain_id=4663 AND j.stream_key=b.stream_key AND j.batch_end=b.to_block)
     WHERE b.chain_id=4663 AND b.stream_key=$1`,
    [ledgerStream.key],
  );
  // The old board: the writer's own refresh over the old rows.
  assert.ok(await refreshLedgerWindows(db));
  const before = {
    positions: await positions(db),
    hours: await hours(db),
    journal: await journal(db),
    windows: await windows(db),
    refreshes: await refreshes(db),
  };
  const row = <T extends { wallet: string; window?: string }>(
    rows: T[],
    wallet: string,
  ) => rows.find((r) => r.wallet === wallet && (r.window ?? "All") === "All")!;
  assert.equal(row(before.positions, farm).supported, true);
  assert.equal(row(before.positions, sender).supported, true);
  assert.equal(row(before.windows, bigFarm).rank, 1);
  assert.equal(row(before.windows, bought).rank, 2);
  assert.equal(row(before.windows, farm).realized, (4n * E).toString());
  assert.equal(row(before.windows, farm).supported_trades, 2);
  assert.equal(row(before.windows, farm).rank, null);
  assert.equal(
    row(before.windows, sender).realized,
    ((9n * tenth) / 2n).toString(),
  );
  assert.equal(row(before.windows, sender).net, (-5n * tenth).toString());
  // The cursor's hour holds the bought wallet's second-batch buy and the
  // sender's sale, so 1h has two rows and no eligible wallet; every other
  // window the five.
  assert.deepEqual(
    before.refreshes.map((r) => [r.window, r.through, r.ranked, r.wallets]),
    ["1h", "24h", "30d", "6h", "7d", "All"].map((w) => [
      w,
      base + 19,
      w === "1h" ? 0 : 2,
      w === "1h" ? 2 : 5,
    ]),
  );
  const preimage = (wallet: string, table: string) =>
    before.journal.find(
      (r) =>
        r.batch_end === base + 19 &&
        r.table === table &&
        r.key.wallet_ref === refs.get(wallet) &&
        r.before !== null,
    )!;
  assert.equal(preimage(farm, "agg_positions").before.supported, true);
  assert.equal(preimage(farm, "agg_wallet_hours").before.realized_wei, 1e18);
  assert.deepEqual(preimage(sender, "agg_positions").before.flags, []);

  await migrate(db);
  assert.deepEqual(
    (
      await db.query(
        "SELECT name FROM pools_schema_migrations ORDER BY name DESC LIMIT 1",
      )
    ).rows[0].name,
    migration,
  );
  // Positions: the farms excluded with their flags as they were, the sender
  // excluded with the outflow flag it now carries, their figures untouched;
  // the bought and the unknown-basis wallets as before.
  const after = await positions(db);
  assert.deepEqual(
    after.map((p) => [p.wallet, p.supported, p.flags, p.realized]),
    [
      [bought, true, [], "5000"],
      [farm, false, ["zero_cost_inflow"], (4n * E).toString()],
      [bigFarm, false, ["zero_cost_inflow"], (10n * E).toString()],
      [unknown, false, ["unknown_basis"], E.toString()],
      [sender, false, ["unattributed_outflow"], ((9n * tenth) / 2n).toString()],
    ],
  );
  // Hours: the farms' and the sender's finances gone, counts and volume
  // kept; the others the same rows as before.
  const afterHours = await hours(db);
  for (const wallet of [farm, bigFarm, sender])
    for (const was of before.hours.filter((r) => r.wallet === wallet)) {
      const is = afterHours.find(
        (r) => r.wallet === wallet && r.hour === was.hour,
      )!;
      assert.deepEqual(is, { ...was, ...zeroed }, `${wallet} hour ${was.hour}`);
      assert.deepEqual(
        [is.buys, is.sells, is.volume],
        [was.buys, was.sells, was.volume],
      );
    }
  assert.deepEqual(
    afterHours.filter((r) => r.wallet === bought || r.wallet === unknown),
    before.hours.filter((r) => r.wallet === bought || r.wallet === unknown),
  );
  // Journal: the farm's and the sender's batch-2 pre-images carry the new
  // rule (excluded, the sender's flag added in the fold's order, the farm
  // hour's finances zero), every other row byte for byte as it was.
  const afterJournal = await journal(db);
  assert.equal(afterJournal.length, before.journal.length);
  const changed = afterJournal.filter(
    (r, i) => JSON.stringify(r) !== JSON.stringify(before.journal[i]),
  );
  assert.deepEqual(
    changed.map((r) => [r.batch_end, r.table, r.key.wallet_ref]),
    [
      [base + 19, "agg_positions", refs.get(farm)],
      [base + 19, "agg_positions", refs.get(sender)],
      [base + 19, "agg_wallet_hours", refs.get(farm)],
    ],
  );
  assert.deepEqual(changed[0].before, {
    ...preimage(farm, "agg_positions").before,
    supported: false,
  });
  assert.deepEqual(changed[1].before, {
    ...preimage(sender, "agg_positions").before,
    supported: false,
    flags: ["unattributed_outflow"],
  });
  assert.deepEqual(changed[2].before, {
    ...preimage(farm, "agg_wallet_hours").before,
    realized_wei: 0,
    disposed_cost_wei: 0,
    proceeds_wei: 0,
    spent_wei: 0,
    supported_trades: 0,
    wins: 0,
    losses: 0,
    closures: 0,
    hold_seconds: 0,
    flash_closures: 0,
    best_wei: null,
  });
  assert.equal(changed[2].before.sells, 1);
  assert.equal(changed[2].before.volume_wei, 1e18);
  // The constraints: the old rule's rows are refused from here on, and the
  // outflow flag follows its counter.
  for (const [sql, constraint] of [
    [
      "UPDATE agg_positions SET supported=true WHERE 'zero_cost_inflow'=ANY(flags)",
      "agg_positions_flags",
    ],
    [
      "UPDATE agg_positions SET supported=true WHERE 'unattributed_outflow'=ANY(flags)",
      "agg_positions_flags",
    ],
    [
      "UPDATE agg_positions SET flags='{unknown_basis}' WHERE flags='{unattributed_outflow}'",
      "agg_positions_outflow_flag",
    ],
    [
      "UPDATE agg_positions SET outflow_raw=1 WHERE outflow_raw=0 AND supported",
      "agg_positions_outflow_flag",
    ],
  ]) {
    await db.query("BEGIN");
    try {
      await assert.rejects(db.query(sql), new RegExp(constraint));
    } finally {
      await db.query("ROLLBACK");
    }
  }
  // Windows: rebuilt in the migration to the same cursor, re-ranked (the
  // bought wallet is first, the farms and the sender unranked with nothing
  // supported), their rows now counts and volume only.
  const rebuilt = await windows(db);
  assert.deepEqual(
    rebuilt
      .filter((r) => r.window === "All")
      .map((r) => [
        r.wallet,
        r.rank,
        r.realized,
        r.net,
        r.supported_trades,
        r.trades,
        r.supported_positions,
        r.excluded_positions,
      ]),
    [
      [bought, 1, "5000", (5000n - E).toString(), 11, 11, 1, 0],
      [farm, null, "0", "0", 0, 2, 0, 1],
      [bigFarm, null, "0", "0", 0, 10, 0, 1],
      [unknown, null, "0", "0", 0, 1, 0, 1],
      [sender, null, "0", "0", 0, 2, 0, 1],
    ],
  );
  assert.equal(row(rebuilt, farm).volume, (4n * E).toString());
  assert.equal(row(rebuilt, sender).volume, (15n * tenth).toString());
  const refreshedByMigration = await refreshes(db);
  assert.deepEqual(
    refreshedByMigration,
    before.refreshes.map((r) => ({
      ...r,
      ranked: r.window === "1h" ? 0 : 1,
    })),
  );
  // The writer's own rebuild reproduces the migration's rows exactly.
  const refreshed = await refreshLedgerWindows(db, { rebuild: true });
  assert.ok(refreshed);
  assert.deepEqual(await windows(db), rebuilt);
  assert.deepEqual(await refreshes(db), refreshedByMigration);
  assert.equal(await refreshLedgerWindows(db, { minIntervalMs: 0 }), null);

  // Walk-back restores the rewritten pre-images under the new constraints:
  // the farm after its first sale, excluded, its hour a count and volume;
  // the sender before its sale, excluded with the flag, its second hour gone.
  assert.deepEqual(await walkBackLedger(db, base + 9), {
    removed: [base + 19],
  });
  const walked = await positions(db);
  assert.deepEqual(
    [
      row(walked, farm).quantity,
      row(walked, farm).sells,
      row(walked, farm).realized,
      row(walked, farm).supported,
      row(walked, sender).quantity,
      row(walked, sender).sells,
      row(walked, sender).supported,
      row(walked, sender).flags,
    ],
    ["60", 1, E.toString(), false, "10", 0, false, ["unattributed_outflow"]],
  );
  const walkedHours = await hours(db);
  assert.deepEqual(row(walkedHours, farm), {
    ...row(before.hours, farm),
    ...zeroed,
    sells: 1,
    volume: E.toString(),
  });
  assert.deepEqual(
    walkedHours
      .filter((r) => r.wallet === sender)
      .map((r) => [r.hour, r.buys, r.spent, r.supported_trades]),
    [[h, 1, "0", 0]],
  );
  // The writer carries the rule forward: the farm's second sale stays out of
  // its hour and a buy into it is volume and a count only, the sender's sale
  // likewise; a wallet moving tokens away is excluded on the move and the
  // one receiving them on arrival, each hour they touched zeroed; the bought
  // wallet, which only swaps, keeps its rank.
  await applyLedgerBatch(
    db,
    batch(
      base + 10,
      base + 19,
      new Rows()
        .trade(base + 10, farm, "sell", 3n * E, 60n)
        .trade(base + 12, bought, "buy", E, 10n)
        .trade(base + 12, farm, "buy", E, 5n)
        .trade(base + 12, mover, "buy", E, 10n)
        .trade(base + 13, sender, "sell", 5n * tenth, 5n)
        .move(base + 13, mover, recipient, 3n)
        .move(base + 14, farm, recipient, 5n),
    ),
  );
  const carried = await positions(db);
  assert.deepEqual(
    carried.map((p) => [p.wallet, p.supported, p.flags, p.buys, p.sells]),
    [
      [bought, true, [], 6, 5],
      [farm, false, ["unattributed_outflow", "zero_cost_inflow"], 1, 2],
      [bigFarm, false, ["zero_cost_inflow"], 0, 10],
      [unknown, false, ["unknown_basis"], 0, 1],
      [recipient, false, ["zero_cost_inflow"], 0, 0],
      [sender, false, ["unattributed_outflow"], 1, 1],
      [mover, false, ["unattributed_outflow"], 1, 0],
    ],
  );
  const carriedHours = await hours(db);
  assert.deepEqual(
    carriedHours
      .filter((r) => r.wallet !== bought && r.wallet !== unknown)
      .map((r) => [
        r.wallet,
        r.hour,
        r.buys,
        r.sells,
        r.volume,
        r.supported_trades,
        r.realized,
        r.spent,
      ]),
    [
      [farm, h, 0, 2, (4n * E).toString(), 0, "0", "0"],
      [farm, h + 1, 1, 0, E.toString(), 0, "0", "0"],
      [bigFarm, h, 0, 10, (10n * E).toString(), 0, "0", "0"],
      [sender, h, 1, 0, E.toString(), 0, "0", "0"],
      [sender, h + 1, 0, 1, (5n * tenth).toString(), 0, "0", "0"],
      [mover, h + 1, 1, 0, E.toString(), 0, "0", "0"],
    ],
  );
  const again = await refreshLedgerWindows(db, { minIntervalMs: 0 });
  assert.ok(again);
  const board = await windows(db);
  assert.deepEqual(
    board
      .filter((r) => r.window === "All")
      .map((r) => [r.wallet, r.rank, r.realized, r.supported_positions]),
    [
      [bought, 1, "5000", 1],
      [farm, null, "0", 0],
      [bigFarm, null, "0", 0],
      [unknown, null, "0", 0],
      [sender, null, "0", 0],
      [mover, null, "0", 0],
    ],
  );
  assert.equal(
    board.some((r) => r.wallet === recipient),
    false,
    "a wallet with no swap of its own has no hour and no window row",
  );
});
