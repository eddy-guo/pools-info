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
  getStream,
  ledgerCheckpoints,
  ledgerContentHash,
  ledgerRules,
  ledgerStream,
  migrate,
  readLedgerStream,
  releaseLedgerWriter,
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
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = ledgerStream.start;
const ts = (block: number) => 1_000_000 + (block - base) * 400;
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
const other = {
  ...pool,
  id: hash(0x110),
  token: addr(0x210),
  launchTx: hash(111),
};
const W = addr(0x300),
  V = addr(0x301);

function swap(
  block: number,
  logIndex: number,
  fields: {
    side: "buy" | "sell";
    eth: bigint;
    tokens: bigint;
    initiator?: string;
    txTo?: string | null;
    txHash?: string;
    poolId?: string;
    token?: string;
    price?: bigint;
  },
): LedgerSwap {
  return {
    txHash: fields.txHash ?? hash(block * 1000 + logIndex),
    logIndex,
    block,
    blockHash: hash(block),
    timestamp: ts(block),
    poolId: fields.poolId ?? pool.id,
    token: fields.token ?? pool.token,
    initiator: fields.initiator ?? W,
    txTo: fields.txTo === undefined ? ledgerRules.router : fields.txTo,
    side: fields.side,
    ethWei: fields.eth.toString(),
    tokenRaw: fields.tokens.toString(),
    sqrtPriceX96: (fields.price ?? 1000n).toString(),
    liquidity: "5",
    tick: 1,
  };
}
function transfer(
  block: number,
  logIndex: number,
  from: string,
  to: string,
  value: bigint,
  txHash: string,
  token = pool.token,
): LedgerTransfer {
  return {
    txHash,
    logIndex,
    block,
    blockHash: hash(block),
    timestamp: ts(block),
    token,
    from,
    to,
    value: value.toString(),
  };
}
/** A wallet's own swap: the swap log and the matching manager transfer. */
function trade(
  block: number,
  side: "buy" | "sell",
  eth: bigint,
  tokens: bigint,
  wallet = W,
  extra: Partial<Parameters<typeof swap>[2]> = {},
) {
  const txHash = hash(block * 1000 + 7);
  const s = swap(block, 10, {
    side,
    eth,
    tokens,
    initiator: wallet,
    txHash,
    ...extra,
  });
  const t =
    side === "buy"
      ? transfer(block, 11, ledgerRules.manager, wallet, tokens, txHash)
      : transfer(block, 11, wallet, ledgerRules.manager, tokens, txHash);
  return { swaps: [s], transfers: [t] };
}
function batch(
  from: number,
  to: number,
  rows: { swaps?: LedgerSwap[]; transfers?: LedgerTransfer[] }[],
  fields: Partial<LedgerBatch> = {},
): LedgerBatch {
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
    swaps: rows.flatMap((r) => r.swaps ?? []),
    transfers: rows.flatMap((r) => r.transfers ?? []),
    ...fields,
  };
}
async function setup(t: test.TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = "ledger_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const discovery = await ensureDiscovery(db, 10);
  await commitBatch(db, discovery, {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool, other],
  });
  await ensureLedgerStream(db, "pass");
  return db;
}
/** Every ledger table with surrogates resolved, volatile columns dropped, in a
 * stable order: equal snapshots mean equal ledgers. */
async function snapshot(db: Client) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    wallets: await q(
      "SELECT encode(address,'hex') AS address,first_block::int AS first_block FROM agg_wallets ORDER BY address",
    ),
    positions: await q(
      "SELECT p.pool_id,encode(w.address,'hex') AS wallet,to_jsonb(x)-'pool_ref'-'wallet_ref' AS row FROM agg_positions x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2",
    ),
    walletHours: await q(
      "SELECT p.pool_id,encode(w.address,'hex') AS wallet,x.hour,to_jsonb(x)-'pool_ref'-'wallet_ref' AS row FROM agg_wallet_hours x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2,3",
    ),
    poolHours: await q(
      "SELECT p.pool_id,x.hour,to_jsonb(x)-'pool_ref' AS row FROM agg_pool_hours x JOIN indexed_pools p USING(pool_ref) ORDER BY 1,2",
    ),
    poolState: await q(
      "SELECT p.pool_id,to_jsonb(x)-'pool_ref' AS row FROM agg_pool_state x JOIN indexed_pools p USING(pool_ref) ORDER BY 1",
    ),
    liveTrades: await q(
      "SELECT encode(x.tx_hash,'hex') AS tx,x.log_index,p.pool_id,encode(w.address,'hex') AS wallet,x.attribution,x.side,x.eth_wei,x.batch_end::int AS batch_end FROM agg_live_trades x JOIN indexed_pools p USING(pool_ref) LEFT JOIN agg_wallets w USING(wallet_ref) ORDER BY x.block_number,x.log_index",
    ),
    batches: await q(
      "SELECT to_block::int AS to_block,from_block::int AS from_block,encode(content_hash,'hex') AS content_hash,swaps,transfers,launches,attributed,unattributed,unregistered_swaps FROM agg_batches ORDER BY to_block",
    ),
    // Surrogates are replaced by addresses: a wallet created twice (after a
    // walk-back) gets a new ref, and the ledger is still the same ledger.
    journal: await q(
      `SELECT j.batch_end::int AS batch_end,j."table",
         (j.key-'wallet_ref')||CASE WHEN j.key ? 'wallet_ref' THEN jsonb_build_object('wallet',encode(w.address,'hex')) ELSE '{}'::jsonb END AS key,
         CASE WHEN j.before IS NULL THEN NULL ELSE (j.before-'wallet_ref')||CASE WHEN j.before ? 'wallet_ref' THEN jsonb_build_object('wallet',encode(w.address,'hex')) ELSE '{}'::jsonb END END AS before
       FROM agg_journal j LEFT JOIN agg_wallets w ON j.key ? 'wallet_ref' AND w.wallet_ref=(j.key->>'wallet_ref')::int ORDER BY 1,2,3`,
    ),
    stream: await readLedgerStream(db),
  };
}
const count = async (db: Client, table: string) =>
  Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

test("applyLedgerBatch needs the writer lock, applies once per content hash, refuses a differing hash or a gap, and advances the cursor with the rows", async (t) => {
  const db = await setup(t);
  const first = batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]);
  await assert.rejects(applyLedgerBatch(db, first), /ledger_writer_required/);
  assert.equal(await acquireLedgerWriter(db), true);
  const applied = await applyLedgerBatch(db, first);
  assert.deepEqual(applied, {
    changed: true,
    contentHash: ledgerContentHash(first),
    swaps: 1,
    transfers: 1,
    launches: 0,
    attributed: 1,
    unattributed: 0,
    unregisteredSwaps: 0,
    positions: 1,
    newWallets: 1,
  });
  const stream = await readLedgerStream(db);
  assert.deepEqual(
    [stream.cursor, stream.hash, stream.timestamp, stream.mode],
    [base + 9, hash(base + 9), ts(base + 9), "pass"],
  );
  assert.deepEqual(await ledgerCheckpoints(db), [
    { to: base + 9, hash: hash(base + 9) },
  ]);
  const position = (
    await db.query(
      "SELECT quantity_raw,cost_wei,invested_wei,realized_wei,supported,flags,cycle_opened_at::int AS opened FROM agg_positions",
    )
  ).rows;
  assert.deepEqual(position, [
    {
      quantity_raw: "100",
      cost_wei: E.toString(),
      invested_wei: E.toString(),
      realized_wei: "0",
      supported: true,
      flags: [],
      opened: ts(base + 5),
    },
  ]);
  assert.equal(
    (await db.query("SELECT holders FROM agg_pool_state")).rows[0].holders,
    1,
  );
  // The journal holds one null pre-image per created row.
  assert.deepEqual(
    (await db.query('SELECT "table",before FROM agg_journal ORDER BY "table"'))
      .rows,
    [
      "agg_pool_hours",
      "agg_pool_state",
      "agg_positions",
      "agg_wallet_hours",
      "agg_wallets",
    ].map((table) => ({ table, before: null })),
  );
  // Replay: the same rows are a no-op; different rows for the same range are refused.
  const before = await snapshot(db);
  assert.equal((await applyLedgerBatch(db, first)).changed, false);
  assert.deepEqual(await snapshot(db), before);
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base, base + 9, [trade(base + 5, "buy", E * 2n, 100n)]),
    ),
    /ledger_batch_conflict/,
  );
  await assert.rejects(
    applyLedgerBatch(db, { ...first, hash: hash(999) }),
    /ledger_batch_conflict/,
  );
  // Contiguity: the next range starts at cursor + 1 and names the cursor's hash.
  await assert.rejects(
    applyLedgerBatch(db, batch(base + 11, base + 19, [])),
    /ledger_noncontiguous_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [], { parentHash: hash(4242) }),
    ),
    /ledger_noncontiguous_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [], { archiveHeight: base + 19 + 127 }),
    ),
    /ledger_invalid_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [trade(base + 25, "buy", E, 1n)]),
    ),
    /ledger_row_outside_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [], {
        launches: [
          {
            poolId: hash(0x999),
            token: pool.token,
            block: base + 12,
            blockHash: hash(base + 12),
            txHash: hash(5),
            logIndex: 0,
          },
        ],
      }),
    ),
    /ledger_unregistered_launch/,
  );
  assert.deepEqual(
    await snapshot(db),
    before,
    "a refused batch changes nothing",
  );
  // An unregistered pool's swap is counted, not applied; an unregistered
  // token's transfer is dropped; a registered launch is counted.
  const second = batch(
    base + 10,
    base + 19,
    [
      trade(base + 12, "sell", (E * 6n) / 10n, 40n),
      {
        swaps: [
          swap(base + 13, 3, {
            side: "buy",
            eth: E,
            tokens: 5n,
            poolId: hash(0x999),
            token: addr(0x999),
          }),
        ],
      },
      {
        transfers: [
          transfer(
            base + 14,
            1,
            ledgerRules.manager,
            V,
            9n,
            hash(77),
            addr(0x999),
          ),
        ],
      },
    ],
    {
      launches: [
        {
          poolId: other.id,
          token: other.token,
          block: base + 11,
          blockHash: hash(base + 11),
          txHash: hash(6),
          logIndex: 0,
        },
      ],
    },
  );
  const next = await applyLedgerBatch(db, second);
  assert.deepEqual(
    [
      next.changed,
      next.attributed,
      next.unregisteredSwaps,
      next.launches,
      next.newWallets,
    ],
    [true, 1, 1, 1, 0],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT swaps,transfers,launches,attributed,unattributed,unregistered_swaps FROM agg_batches WHERE to_block=$1",
        [base + 19],
      )
    ).rows,
    [
      {
        swaps: 2,
        transfers: 2,
        launches: 1,
        attributed: 1,
        unattributed: 0,
        unregistered_swaps: 1,
      },
    ],
  );
  assert.equal(await count(db, "agg_live_trades"), 2);
  assert.equal(await count(db, "agg_wallets"), 1);
  const after = (
    await db.query(
      "SELECT quantity_raw,cost_wei,realized_wei,disposed_cost_wei,proceeds_wei FROM agg_positions",
    )
  ).rows[0];
  assert.deepEqual(after, {
    quantity_raw: "60",
    cost_wei: ((E * 6n) / 10n).toString(),
    realized_wei: (E / 5n).toString(),
    disposed_cost_wei: ((E * 4n) / 10n).toString(),
    proceeds_wei: ((E * 6n) / 10n).toString(),
  });
  // The second batch journaled the first batch's rows as its pre-images.
  const preimages = (
    await db.query(
      'SELECT "table",before FROM agg_journal WHERE batch_end=$1 ORDER BY "table"',
      [base + 19],
    )
  ).rows;
  assert.deepEqual(
    preimages.map((r) => [r.table, r.before === null ? null : typeof r.before]),
    [
      ["agg_pool_hours", null],
      ["agg_pool_state", "object"],
      ["agg_positions", "object"],
      ["agg_wallet_hours", null],
    ],
  );
  assert.equal(preimages[2].before.quantity_raw, 100);
  await releaseLedgerWriter(db);
  await assert.rejects(
    applyLedgerBatch(db, batch(base + 20, base + 29, [])),
    /ledger_writer_required/,
  );
});

test("the database refuses forged identities, wrong scales, other chains and an unproven lag", async (t) => {
  const db = await setup(t);
  await acquireLedgerWriter(db);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [
      trade(base + 5, "buy", E, 100n),
      trade(base + 6, "sell", E / 2n, 50n),
    ]),
  );
  const refused = async (
    sql: string,
    pattern: RegExp = /violates check constraint/,
  ) => {
    await db.query("SAVEPOINT forged");
    await assert.rejects(db.query(sql), pattern);
    await db.query("ROLLBACK TO SAVEPOINT forged");
  };
  await db.query("BEGIN");
  await refused("UPDATE agg_positions SET realized_wei=realized_wei+1");
  await refused(
    "UPDATE agg_positions SET disposed_cost_wei=disposed_cost_wei+1",
  );
  await refused("UPDATE agg_positions SET cost_wei=cost_wei+1");
  await refused("UPDATE agg_positions SET quantity_raw=1.5");
  await refused("UPDATE agg_positions SET quantity_raw=-1");
  await refused("UPDATE agg_positions SET flags=ARRAY['unknown_basis']");
  await refused("UPDATE agg_positions SET supported=false");
  await refused(
    "UPDATE agg_positions SET supported=false,flags=ARRAY['zero_cost_inflow']",
  );
  await refused("UPDATE agg_positions SET inflow_raw=5");
  await refused("UPDATE agg_positions SET flags=ARRAY['wrapper_route']");
  await refused("UPDATE agg_positions SET cycle_opened_at=NULL");
  await refused("UPDATE agg_positions SET chain_id=1");
  await refused("UPDATE agg_wallet_hours SET realized_wei=realized_wei+1");
  await refused(
    "UPDATE agg_wallet_hours SET supported_trades=supported_trades+1",
  );
  await refused("UPDATE agg_wallet_hours SET wins=wins+1");
  await refused(
    "UPDATE agg_pool_hours SET low_sqrt_price_x96=high_sqrt_price_x96+1",
  );
  await refused("UPDATE agg_pool_hours SET buyers=buys+1");
  await refused("UPDATE agg_pool_hours SET unattributed=trades+1");
  await refused("UPDATE agg_pool_state SET holders=-1");
  await refused("UPDATE agg_batches SET archive_height=to_block+127");
  await refused("UPDATE agg_batches SET attributed=attributed+1");
  await refused("UPDATE agg_batches SET content_hash='\\x00'");
  await refused("UPDATE agg_streams SET start_block=1");
  await refused("UPDATE agg_streams SET cursor_hash=NULL");
  await refused("UPDATE agg_live_trades SET wallet_ref=NULL");
  await refused("UPDATE agg_live_trades SET attribution='unattributed'");
  await refused("UPDATE agg_wallets SET address='\\x00'");
  await refused(
    "INSERT INTO agg_journal(chain_id,stream_key,batch_end,\"table\",key,before) VALUES (4663,'ledger:agg:v1',$1,'agg_positions','1','{}')".replace(
      "$1",
      String(base + 9),
    ),
  );
  // A journal row cannot exist without its batch.
  await refused(
    `INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before) VALUES (4663,'ledger:agg:v1',${base + 99},'agg_positions','{}','{}')`,
    /foreign key/,
  );
  await db.query("ROLLBACK");
});

/** The reorg replay from the recent stream (PR 35): batches beyond a fork are
 * walked back to the newest surviving checkpoint, the replaced range is
 * recollected, and the ledger equals a fresh build of the same history. */
test("walk-back restores every pre-image in reverse order and a replaced range rebuilds to a fresh build", async (t) => {
  const db = await setup(t);
  await acquireLedgerWriter(db);
  const fresh = createClient(url);
  await fresh.connect();
  const schema = "ledger_fresh_" + randomUUID().replaceAll("-", "");
  await fresh.query(`CREATE SCHEMA "${schema}"`);
  await fresh.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await fresh.query(`DROP SCHEMA "${schema}" CASCADE`);
    await fresh.end();
  });
  await migrate(fresh);
  await commitBatch(fresh, await ensureDiscovery(fresh, 10), {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool, other],
  });
  await ensureLedgerStream(fresh, "pass");

  // A: W buys. B: W sells part, V buys through a wrapper, W gives V tokens.
  // C: V sells more than the ledger holds (excluded, zeroing V's hour in B),
  // a new wallet U appears, and a loop leaves an unattributed swap.
  const U = addr(0x302);
  const A = batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]);
  const B = batch(base + 10, base + 19, [
    trade(base + 12, "sell", (E * 6n) / 10n, 40n),
    trade(base + 14, "buy", E, 30n, V, { txTo: addr(0x400) }),
    { transfers: [transfer(base + 16, 2, W, V, 10n, hash(4444))] },
  ]);
  const loop = hash(5555);
  const C = batch(base + 20, base + 29, [
    trade(base + 22, "sell", E * 2n, 41n, V),
    trade(base + 24, "buy", E, 7n, U),
    {
      swaps: [
        swap(base + 26, 1, {
          side: "buy",
          eth: E,
          tokens: 5n,
          initiator: U,
          txHash: loop,
        }),
        swap(base + 26, 5, {
          side: "sell",
          eth: E,
          tokens: 3n,
          initiator: U,
          txHash: loop,
        }),
      ],
      transfers: [
        transfer(base + 26, 2, ledgerRules.manager, U, 5n, loop),
        transfer(base + 26, 6, U, ledgerRules.manager, 3n, loop),
      ],
    },
  ]);
  const snapshots = [];
  for (const b of [A, B, C]) {
    await applyLedgerBatch(db, b);
    snapshots.push(await snapshot(db));
  }
  const [afterA, afterB, afterC] = snapshots;
  // C excluded V: V's B-hour finances are zero now, and were journaled by C.
  const vHour = afterC.walletHours.find(
    (h) =>
      h.wallet === V.slice(2) && h.hour === Math.floor(ts(base + 14) / 3600),
  )!.row;
  assert.deepEqual(
    [vHour.spent_wei, vHour.supported_trades, vHour.buys, vHour.volume_wei],
    [0, 0, 1, Number(E)],
  );
  const journaledV = afterC.journal.find(
    (j) =>
      j.batch_end === base + 29 &&
      j.table === "agg_wallet_hours" &&
      j.key.wallet === V.slice(2) &&
      j.before?.spent_wei === Number(E),
  );
  assert.ok(journaledV, "the zeroed hour row was journaled with its pre-image");
  assert.equal(
    afterC.positions.find((p) => p.wallet === V.slice(2))!.row.supported,
    false,
  );
  assert.equal(
    afterC.positions.find((p) => p.wallet === U.slice(2))!.row.flags[0],
    "unattributed_swap_activity",
  );
  assert.equal(afterC.batches.at(-1)!.unattributed, 2);
  // Walk back C: the ledger is exactly as B left it, cursor included.
  assert.deepEqual(await walkBackLedger(db, base + 19), {
    removed: [base + 29],
  });
  assert.deepEqual(await snapshot(db), afterB);
  // Walk back B as well, then everything.
  assert.deepEqual(await walkBackLedger(db, base + 9), {
    removed: [base + 19],
  });
  assert.deepEqual(await snapshot(db), afterA);
  await assert.rejects(
    walkBackLedger(db, base + 19),
    /ledger_unknown_ancestor/,
  );
  assert.deepEqual(await walkBackLedger(db, null), { removed: [base + 9] });
  const empty = await snapshot(db);
  assert.deepEqual(
    [
      empty.wallets,
      empty.positions,
      empty.walletHours,
      empty.poolHours,
      empty.poolState,
      empty.liveTrades,
      empty.batches,
      empty.journal,
    ],
    [[], [], [], [], [], [], [], []],
  );
  assert.deepEqual(
    [empty.stream.cursor, empty.stream.hash, empty.stream.timestamp],
    [null, null, null],
  );
  // Rebuild A and B, then a fork replaces C's transactions (different block
  // hashes, a different sale) and the ledger must equal a fresh build.
  for (const b of [A, B]) await applyLedgerBatch(db, b);
  assert.deepEqual(await snapshot(db), afterB);
  await applyLedgerBatch(db, C);
  assert.deepEqual(await snapshot(db), afterC);
  const replaced = batch(
    base + 20,
    base + 29,
    [
      trade(base + 22, "sell", E * 3n, 20n, V),
      trade(base + 27, "buy", E, 3n, U),
    ],
    { hash: hash(424242) },
  );
  const forkedRows = {
    ...replaced,
    swaps: replaced.swaps.map((s) => ({
      ...s,
      blockHash: s.block === base + 29 ? hash(424242) : hash(s.block + 900000),
    })),
    transfers: replaced.transfers.map((x) => ({
      ...x,
      blockHash: hash(x.block + 900000),
    })),
  };
  await assert.rejects(
    applyLedgerBatch(db, forkedRows),
    /ledger_batch_conflict/,
  );
  assert.deepEqual(await walkBackLedger(db, base + 19), {
    removed: [base + 29],
  });
  await applyLedgerBatch(db, forkedRows);
  await assert.rejects(
    walkBackLedger(db, base + 30),
    /ledger_unknown_ancestor/,
  );
  await assert.rejects(
    walkBackLedger(db, base + 15),
    /ledger_unknown_ancestor/,
  );
  // One writer per database: the fresh build takes the lock after this one.
  await releaseLedgerWriter(db);
  assert.equal(await acquireLedgerWriter(fresh), true);
  for (const b of [A, B, forkedRows]) await applyLedgerBatch(fresh, b);
  await releaseLedgerWriter(fresh);
  const rebuilt = await snapshot(db),
    built = await snapshot(fresh);
  assert.deepEqual(rebuilt.stream, built.stream);
  assert.deepEqual(
    [rebuilt.stream.cursor, rebuilt.stream.hash],
    [base + 29, hash(424242)],
  );
  for (const table of [
    "wallets",
    "positions",
    "walletHours",
    "poolHours",
    "poolState",
    "liveTrades",
    "batches",
  ] as const)
    assert.deepEqual(rebuilt[table], built[table], table);
  assert.deepEqual(rebuilt.journal, built.journal);
  assert.equal(
    rebuilt.positions.find((p) => p.wallet === V.slice(2))!.row.supported,
    true,
  );
});

test("the live ring keeps 24 hours of trades and a batch's rows leave with it", async (t) => {
  const db = await setup(t);
  await acquireLedgerWriter(db);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]),
  );
  // 400 seconds per block: block base + 300 is more than 24 hours later.
  await applyLedgerBatch(
    db,
    batch(base + 10, base + 300, [trade(base + 299, "sell", E, 10n)]),
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT block_number::int AS block,batch_end::int AS batch_end FROM agg_live_trades ORDER BY block_number",
      )
    ).rows,
    [{ block: base + 299, batch_end: base + 300 }],
  );
  await walkBackLedger(db, base + 9);
  assert.equal(await count(db, "agg_live_trades"), 0);
  assert.equal(await count(db, "agg_journal"), 5);
  const s = await getStream(db, "discovery:v1");
  assert.equal(s.cursor, 19, "the catalog streams are untouched by the ledger");
});
