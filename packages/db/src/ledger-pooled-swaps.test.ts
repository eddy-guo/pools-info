// Fold rule 2 through the database (docs/AGGREGATE-LEDGER.md, "Pooled swaps";
// migration 027): a stream created under rule 2 folds a pooled sell into each
// contributor's position, hour row and the batch's counts, keeps the swap as
// one wallet-less ring row and walks it back to the wei; the same batch on a
// rule-1 stream leaves every contributor excluded, byte for byte as before;
// a stream never changes rule, the crowd stream follows the main one; and
// 027 on rows written before it rewrites the journal's pre-images, leaves the
// unit totals null and the writer keeps them null. The fold's own side is in
// packages/core/src/ledger.test.ts.
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
  crowdLedgerStream,
  ensureDiscovery,
  ensureLedgerStream,
  ledgerRules,
  ledgerStream,
  migrate,
  readLedgerStream,
  releaseLedgerWriter,
  walkBackLedger,
  type Client,
  type LedgerBatch,
  type LedgerFoldRule,
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
const A = addr(0x901),
  B = addr(0x902),
  batchSeller = addr(0x903);

function swap(
  block: number,
  logIndex: number,
  fields: {
    side: "buy" | "sell";
    eth: bigint;
    tokens: bigint;
    initiator: string;
    txTo: string;
    txHash: string;
  },
): LedgerSwap {
  return {
    txHash: fields.txHash,
    logIndex,
    block,
    blockHash: hash(block),
    timestamp: ts(block),
    poolId: pool.id,
    token: pool.token,
    initiator: fields.initiator,
    txTo: fields.txTo,
    side: fields.side,
    ethWei: fields.eth.toString(),
    tokenRaw: fields.tokens.toString(),
    sqrtPriceX96: "1000",
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
): LedgerTransfer {
  return {
    txHash,
    logIndex,
    block,
    blockHash: hash(block),
    timestamp: ts(block),
    token: pool.token,
    from,
    to,
    value: value.toString(),
  };
}
/** A wallet's own buy through the router. */
function buy(block: number, wallet: string, eth: bigint, tokens: bigint) {
  const txHash = hash(block * 1000 + 7);
  return {
    swaps: [
      swap(block, 10, {
        side: "buy",
        eth,
        tokens,
        initiator: wallet,
        txTo: ledgerRules.router,
        txHash,
      }),
    ],
    transfers: [
      transfer(block, 11, ledgerRules.manager, wallet, tokens, txHash),
    ],
  };
}
/** The pooled sell: A's 60 and B's 40 tokens collected by the batch contract
 * and sold in one swap for 10 ETH and 7 wei (A's share 6 ETH + 4 wei, B's
 * 4 ETH + 3 wei under the remainder rule). */
const ethWei = E * 10n + 7n;
function pooledSell(block: number) {
  const txHash = hash(block * 1000 + 9);
  return {
    swaps: [
      swap(block, 90, {
        side: "sell",
        eth: ethWei,
        tokens: 100n,
        initiator: batchSeller,
        txTo: batchSeller,
        txHash,
      }),
    ],
    transfers: [
      transfer(block, 11, A, batchSeller, 60n, txHash),
      transfer(block, 12, B, batchSeller, 40n, txHash),
      transfer(block, 80, batchSeller, ledgerRules.manager, 100n, txHash),
    ],
  };
}
function batch(
  from: number,
  to: number,
  rows: { swaps: LedgerSwap[]; transfers: LedgerTransfer[] }[],
): LedgerBatch {
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
    swaps: rows.flatMap((r) => r.swaps),
    transfers: rows.flatMap((r) => r.transfers),
  };
}
async function writer(db: Client) {
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
async function schema(t: test.TestContext) {
  const db = createClient(url);
  await db.connect();
  const name = "ledger_pooled_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${name}"`);
  await db.query(`SET search_path TO "${name}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${name}" CASCADE`);
    await db.end();
  });
  return db;
}
async function setup(t: test.TestContext, rule?: LedgerFoldRule) {
  const db = await schema(t);
  await migrate(db);
  await commitBatch(db, await ensureDiscovery(db, 10), {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool],
  });
  await ensureLedgerStream(db, "pass", ledgerStream.key, rule);
  return db;
}
const positions = async (db: Client) =>
  (
    await db.query(
      `SELECT '0x'||encode(w.address,'hex') AS wallet,p.supported,p.flags,p.buys,p.sells,p.pooled_swaps,
         p.quantity_raw::text AS quantity,p.cost_wei::text AS cost,p.proceeds_wei::text AS proceeds,
         p.disposed_cost_wei::text AS disposed,p.realized_wei::text AS realized,
         p.bought_raw::text AS bought,p.sold_raw::text AS sold,p.closed_cycles
       FROM agg_positions p JOIN agg_wallets w USING (wallet_ref) ORDER BY w.address`,
    )
  ).rows;
const ring = async (db: Client) =>
  (
    await db.query(
      "SELECT attribution,wallet_ref,pooled_wallet_refs,eth_wei::text AS eth_wei,token_raw::text AS token_raw FROM agg_live_trades ORDER BY block_number,log_index",
    )
  ).rows;

test("a rule-2 stream folds a pooled sell pro rata through the writer, keeps it as one ring row and walks it back; a rule-1 stream excludes every contributor of the same batch", async (t) => {
  const bought = batch(base, base + 9, [
    buy(base + 2, A, E * 60n, 60n),
    buy(base + 3, B, E * 40n, 40n),
  ]);
  const sold = batch(base + 10, base + 19, [pooledSell(base + 15)]);
  const holding = [
    {
      wallet: A,
      supported: true,
      flags: [],
      buys: 1,
      sells: 0,
      pooled_swaps: 0,
      quantity: "60",
      cost: (E * 60n).toString(),
      proceeds: "0",
      disposed: "0",
      realized: "0",
      bought: "60",
      sold: "0",
      closed_cycles: 0,
    },
    {
      wallet: B,
      supported: true,
      flags: [],
      buys: 1,
      sells: 0,
      pooled_swaps: 0,
      quantity: "40",
      cost: (E * 40n).toString(),
      proceeds: "0",
      disposed: "0",
      realized: "0",
      bought: "40",
      sold: "0",
      closed_cycles: 0,
    },
  ];

  // Rule 2.
  const two = await setup(t, 2);
  assert.equal((await readLedgerStream(two)).foldRule, 2);
  await writer(two);
  await applyLedgerBatch(two, bought);
  assert.deepEqual(await positions(two), holding);
  const applied = await applyLedgerBatch(two, sold);
  assert.deepEqual(
    [
      applied.attributed,
      applied.pooled,
      applied.unattributed,
      applied.positions,
    ],
    [1, 1, 0, 2],
  );
  assert.deepEqual(await positions(two), [
    {
      wallet: A,
      supported: true,
      flags: ["wrapper_route"],
      buys: 1,
      sells: 1,
      pooled_swaps: 1,
      quantity: "0",
      cost: "0",
      proceeds: (E * 6n + 4n).toString(),
      disposed: (E * 60n).toString(),
      realized: (E * 6n + 4n - E * 60n).toString(),
      bought: "60",
      sold: "60",
      closed_cycles: 1,
    },
    {
      wallet: B,
      supported: true,
      flags: ["wrapper_route"],
      buys: 1,
      sells: 1,
      pooled_swaps: 1,
      quantity: "0",
      cost: "0",
      proceeds: (E * 4n + 3n).toString(),
      disposed: (E * 40n).toString(),
      realized: (E * 4n + 3n - E * 40n).toString(),
      bought: "40",
      sold: "40",
      closed_cycles: 1,
    },
  ]);
  // The batch contract is no wallet; the swap is one ring row without one.
  assert.equal(
    (await two.query("SELECT count(*)::int AS n FROM agg_wallets")).rows[0].n,
    2,
  );
  assert.deepEqual(
    (await ring(two)).map((r) => [
      r.attribution,
      r.wallet_ref,
      r.pooled_wallet_refs,
      r.eth_wei,
    ]),
    [
      ["initiator", 1, null, (E * 60n).toString()],
      ["initiator", 2, null, (E * 40n).toString()],
      // The contributors, which count as the rolling hour's active traders.
      ["pooled", null, [1, 2], ethWei.toString()],
    ],
  );
  const hour = (
    await two.query(
      "SELECT trades,buys,sells,buyers,sellers,unattributed,volume_wei::text AS volume FROM agg_pool_hours WHERE hour=$1",
      [Math.floor(ts(base + 15) / 3600)],
    )
  ).rows[0];
  assert.deepEqual(hour, {
    trades: 1,
    buys: 0,
    sells: 1,
    buyers: 0,
    sellers: 2,
    unattributed: 0,
    volume: ethWei.toString(),
  });
  assert.deepEqual(
    (
      await two.query(
        "SELECT swaps,attributed,pooled,unattributed FROM agg_batches WHERE to_block=$1",
        [base + 19],
      )
    ).rows[0],
    { swaps: 1, attributed: 1, pooled: 1, unattributed: 0 },
  );
  assert.deepEqual(
    (
      await two.query(
        `SELECT '0x'||encode(w.address,'hex') AS wallet,h.sells,h.supported_trades,h.proceeds_wei::text AS proceeds,h.realized_wei::text AS realized,h.closures,h.losses
         FROM agg_wallet_hours h JOIN agg_wallets w USING (wallet_ref) WHERE h.hour=$1 ORDER BY w.address`,
        [Math.floor(ts(base + 15) / 3600)],
      )
    ).rows,
    [
      {
        wallet: A,
        sells: 1,
        supported_trades: 1,
        proceeds: (E * 6n + 4n).toString(),
        realized: (E * 6n + 4n - E * 60n).toString(),
        closures: 1,
        losses: 1,
      },
      {
        wallet: B,
        sells: 1,
        supported_trades: 1,
        proceeds: (E * 4n + 3n).toString(),
        realized: (E * 4n + 3n - E * 40n).toString(),
        closures: 1,
        losses: 1,
      },
    ],
  );
  // A replay is the content-hash no-op; a walk-back restores the bought
  // state, unit totals and counter included, and takes the ring row with it.
  assert.equal((await applyLedgerBatch(two, sold)).changed, false);
  assert.deepEqual(await walkBackLedger(two, base + 9), {
    removed: [base + 19],
  });
  assert.deepEqual(await positions(two), holding);
  assert.equal((await ring(two)).length, 2);
  await releaseLedgerWriter(two);

  // Rule 1, the default: the same batches leave both contributors excluded,
  // the sell unapplied and the ring row unattributed.
  const one = await setup(t);
  assert.equal((await readLedgerStream(one)).foldRule, 1);
  await writer(one);
  await applyLedgerBatch(one, bought);
  const excluded = await applyLedgerBatch(one, sold);
  assert.deepEqual(
    [excluded.attributed, excluded.pooled, excluded.unattributed],
    [0, 0, 1],
  );
  assert.deepEqual(
    await positions(one),
    holding.map((p) => ({
      ...p,
      supported: false,
      flags: ["unattributed_swap_activity"],
    })),
  );
  assert.deepEqual((await ring(one)).at(-1), {
    attribution: "unattributed",
    wallet_ref: null,
    pooled_wallet_refs: null,
    eth_wei: ethWei.toString(),
    token_raw: "100",
  });
  await releaseLedgerWriter(one);
});

test("rule 2 does not credit a pooled sell whose full token leg misses PoolManager", async (t) => {
  const db = await setup(t, 2);
  await writer(db);
  const bought = batch(base, base + 9, [
    buy(base + 2, A, E * 60n, 60n),
    buy(base + 3, B, E * 40n, 40n),
  ]);
  await applyLedgerBatch(db, bought);

  const diverted = pooledSell(base + 15);
  const txHash = diverted.swaps[0].txHash;
  diverted.transfers[2] = transfer(
    base + 15,
    80,
    batchSeller,
    ledgerRules.manager,
    90n,
    txHash,
  );
  diverted.transfers.push(
    transfer(base + 15, 81, batchSeller, addr(0), 10n, txHash),
  );
  const applied = await applyLedgerBatch(
    db,
    batch(base + 10, base + 19, [diverted]),
  );
  assert.deepEqual(
    [applied.attributed, applied.pooled, applied.unattributed],
    [0, 0, 1],
  );
  assert.deepEqual(
    (await positions(db)).map((p) => ({
      wallet: p.wallet,
      supported: p.supported,
      flags: p.flags,
      sells: p.sells,
      proceeds: p.proceeds,
      sold: p.sold,
    })),
    [A, B].map((wallet) => ({
      wallet,
      supported: false,
      flags: ["unattributed_swap_activity"],
      sells: 0,
      proceeds: "0",
      sold: "0",
    })),
  );
  assert.deepEqual((await ring(db)).at(-1), {
    attribution: "unattributed",
    wallet_ref: null,
    pooled_wallet_refs: null,
    eth_wei: ethWei.toString(),
    token_raw: "100",
  });
  await releaseLedgerWriter(db);
});

test("rule 2 keeps a pooled buy unattributed when its tokens fan out to two wallets", async (t) => {
  const db = await setup(t, 2);
  await writer(db);
  const block = base + 5;
  const txHash = hash(block * 1000 + 9);
  const applied = await applyLedgerBatch(
    db,
    batch(base, base + 9, [
      {
        swaps: [
          swap(block, 90, {
            side: "buy",
            eth: E * 3n,
            tokens: 30n,
            initiator: batchSeller,
            txTo: batchSeller,
            txHash,
          }),
        ],
        transfers: [
          transfer(block, 10, ledgerRules.manager, batchSeller, 30n, txHash),
          transfer(block, 11, batchSeller, A, 10n, txHash),
          transfer(block, 12, batchSeller, B, 20n, txHash),
        ],
      },
    ]),
  );
  assert.deepEqual(
    [applied.attributed, applied.pooled, applied.unattributed],
    [0, 0, 1],
  );
  assert.deepEqual(
    (await positions(db)).map((p) => [p.wallet, p.supported, p.flags]),
    [
      [A, false, ["unattributed_swap_activity"]],
      [B, false, ["unattributed_swap_activity"]],
    ],
  );
  assert.equal((await ring(db))[0].attribution, "unattributed");
  await releaseLedgerWriter(db);
});

test("a stream keeps the rule it was created under, the crowd stream follows the main stream's, and a rule the stream is not folded under is refused", async (t) => {
  const db = await setup(t, 2);
  // The rule is the stream's: asking for the other one is refused, asking
  // for the same or none reads it back.
  await assert.rejects(
    ensureLedgerStream(db, "pass", ledgerStream.key, 1),
    /ledger_fold_rule_mismatch/,
  );
  assert.equal(
    (await ensureLedgerStream(db, "pass", ledgerStream.key, 2)).foldRule,
    2,
  );
  assert.equal((await ensureLedgerStream(db, "pass")).foldRule, 2);
  assert.equal((await readLedgerStream(db)).foldRuleSince, null);
  // The crowd stream shares the ledger and inherits its rule.
  const crowd = await ensureLedgerStream(db, "pass", crowdLedgerStream.key);
  assert.equal(crowd.foldRule, 2);
  await assert.rejects(
    ensureLedgerStream(db, "pass", crowdLedgerStream.key, 1),
    /ledger_fold_rule_mismatch/,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT stream_key,fold_rule FROM agg_streams ORDER BY stream_key",
      )
    ).rows,
    [
      { stream_key: "ledger:agg:v1", fold_rule: 2 },
      { stream_key: "ledger:crowd:v1", fold_rule: 2 },
    ],
  );
  // A database whose main stream folds under rule 1 (every existing ledger)
  // creates its crowd stream under rule 1 too.
  const old = await setup(t);
  assert.equal(
    (await ensureLedgerStream(old, "pass", crowdLedgerStream.key)).foldRule,
    1,
  );
  await assert.rejects(
    ensureLedgerStream(old, "pass", ledgerStream.key, 3 as LedgerFoldRule),
    /ledger_invalid_fold_rule/,
  );
});

const migration = "027_pooled_swaps.sql";
test("migration 027 on a ledger written before it: rule 1 recorded, pre-images gain the counter, unit totals read null and stay null through the writer, and a walk-back restores the rewritten pre-image", async (t) => {
  const db = await schema(t);
  await db.query(
    "CREATE TABLE pools_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const dir = new URL("../migrations/", import.meta.url);
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes(migration));
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(4663, 19001)");
  for (const name of names) {
    if (name === migration) continue;
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
  // The pre-027 writer's rows, hand-laid: the stream, a first batch that
  // bought 60 tokens for A, and a second batch that bought 40 more, with the
  // first batch's row as the second's pre-image and the journal whole.
  await db.query(
    "INSERT INTO agg_streams(chain_id,stream_key,start_block,mode,cursor_block,cursor_hash,cursor_timestamp) VALUES (4663,$1,$2,'tip',$3,decode($4,'hex'),$5)",
    [
      ledgerStream.key,
      base,
      base + 19,
      hash(base + 19).slice(2),
      ts(base + 19),
    ],
  );
  for (const [from, to] of [
    [base, base + 9],
    [base + 10, base + 19],
  ])
    await db.query(
      `INSERT INTO agg_batches(chain_id,stream_key,to_block,from_block,from_parent_hash,block_hash,to_timestamp,archive_height,registry_pools,content_hash,query,pages,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,requests,bytes,journal_rows)
       VALUES (4663,$1,$2,$3,decode($4,'hex'),decode($5,'hex'),$6,$7,1,decode($8,'hex'),'{}','[]',1,1,0,1,0,0,1,0,1)`,
      [
        ledgerStream.key,
        to,
        from,
        hash(from - 1).slice(2),
        hash(to).slice(2),
        ts(to),
        to + 128,
        hash(to * 7).slice(2),
      ],
    );
  const walletRef = (
    await db.query(
      "INSERT INTO agg_wallets(address,first_block) VALUES (decode($1,'hex'),$2) RETURNING wallet_ref",
      [A.slice(2), base + 2],
    )
  ).rows[0].wallet_ref as number;
  const poolRef = (
    await db.query("SELECT pool_ref FROM indexed_pools WHERE pool_id=$1", [
      pool.id,
    ])
  ).rows[0].pool_ref as number;
  const insertPosition = (quantity: bigint, cost: bigint, buys: number) =>
    db.query(
      `INSERT INTO agg_positions(chain_id,pool_ref,wallet_ref,quantity_raw,cost_wei,invested_wei,proceeds_wei,disposed_cost_wei,realized_wei,inflow_raw,outflow_raw,outflow_cost_wei,buys,sells,wrapper_swaps,counterparty_swaps,cycle_opened_at,cycle_gain_wei,closed_cycles,flash_cycles,first_block,last_block,last_timestamp,supported,flags)
       VALUES (4663,$1,$2,$3,$4,$4,0,0,0,0,0,0,$5,0,0,0,$6,0,0,0,$7,$8,$9,true,'{}')`,
      [
        poolRef,
        walletRef,
        quantity.toString(),
        cost.toString(),
        buys,
        ts(base + 2),
        base + 2,
        base + 12,
        ts(base + 12),
      ],
    );
  await insertPosition(60n, E * 60n, 1);
  await db.query(
    `INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
     SELECT 4663,$1,$2,'agg_positions',jsonb_build_object('pool_ref',pool_ref,'wallet_ref',wallet_ref),to_jsonb(p) FROM agg_positions p`,
    [ledgerStream.key, base + 19],
  );
  await db.query("DELETE FROM agg_positions");
  await insertPosition(100n, E * 100n, 2);
  await db.query(
    `INSERT INTO agg_wallet_hours(chain_id,wallet_ref,pool_ref,hour,realized_wei,disposed_cost_wei,proceeds_wei,spent_wei,volume_wei,buys,sells,supported_trades,wins,losses,closures,hold_seconds,flash_closures)
     VALUES (4663,$1,$2,$3,0,0,0,$4,$4,2,0,2,0,0,0,0,0)`,
    [
      walletRef,
      poolRef,
      Math.floor(ts(base + 2) / 3600),
      (E * 100n).toString(),
    ],
  );
  await db.query(
    `INSERT INTO agg_pool_hours(chain_id,pool_ref,hour,trades,buys,sells,unattributed,volume_wei,buyers,sellers,open_sqrt_price_x96,close_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_block,close_log_index)
     VALUES (4663,$1,$2,2,2,0,0,$3,1,0,1000,1000,1000,1000,$4,10)`,
    [
      poolRef,
      Math.floor(ts(base + 2) / 3600),
      (E * 100n).toString(),
      base + 12,
    ],
  );
  await db.query(
    `INSERT INTO agg_pool_state(chain_id,pool_ref,trades,volume_wei,holders,sqrt_price_x96,liquidity,tick,price_block,price_log_index,price_tx,price_timestamp,first_trade_timestamp,last_trade_timestamp)
     VALUES (4663,$1,2,$2,1,1000,5,1,$3,10,decode($4,'hex'),$5,$6,$5)`,
    [
      poolRef,
      (E * 100n).toString(),
      base + 12,
      hash(1).slice(2),
      ts(base + 12),
      ts(base + 2),
    ],
  );
  await db.query(
    "INSERT INTO agg_active_trader_counts(chain_id,through_block,through_timestamp,instant_traders,all_traders) VALUES (4663,$1,$2,1,1) ON CONFLICT (chain_id) DO UPDATE SET through_block=EXCLUDED.through_block,through_timestamp=EXCLUDED.through_timestamp,instant_traders=1,all_traders=1",
    [base + 19, ts(base + 19)],
  );
  const preImageBefore = (
    await db.query(
      `SELECT before FROM agg_journal WHERE "table"='agg_positions'`,
    )
  ).rows[0].before;
  assert.equal("pooled_swaps" in preImageBefore, false);

  // 027.
  const sql = await readFile(new URL(migration, dir), "utf8");
  await db.query(sql);
  await db.query(
    "INSERT INTO pools_schema_migrations(name,checksum) VALUES ($1,$2)",
    [migration, createHash("sha256").update(sql).digest("hex")],
  );
  await migrate(db); // nothing left to apply, and the checksum agrees
  assert.deepEqual(
    (await db.query("SELECT fold_rule,fold_rule_since FROM agg_streams")).rows,
    [{ fold_rule: 1, fold_rule_since: null }],
  );
  const preImage = (
    await db.query(
      `SELECT before FROM agg_journal WHERE "table"='agg_positions'`,
    )
  ).rows[0].before;
  assert.deepEqual(preImage, { ...preImageBefore, pooled_swaps: 0 });
  assert.deepEqual(
    (
      await db.query(
        "SELECT pooled_swaps,bought_raw,sold_raw,quantity_raw::text AS quantity FROM agg_positions",
      )
    ).rows,
    [{ pooled_swaps: 0, bought_raw: null, sold_raw: null, quantity: "100" }],
  );
  assert.deepEqual(
    (await db.query("SELECT pooled FROM agg_batches ORDER BY to_block")).rows,
    [{ pooled: 0 }, { pooled: 0 }],
  );

  // The writer folds on: a later sale leaves the unknown totals null rather
  // than counting from here, and the pooled sell stays unattributed on this
  // rule-1 stream.
  await writer(db);
  const sellTx = hash(9999);
  await applyLedgerBatch(
    db,
    batch(base + 20, base + 29, [
      {
        swaps: [
          swap(base + 25, 10, {
            side: "sell",
            eth: E * 3n,
            tokens: 30n,
            initiator: A,
            txTo: ledgerRules.router,
            txHash: sellTx,
          }),
        ],
        transfers: [
          transfer(base + 25, 11, A, ledgerRules.manager, 30n, sellTx),
        ],
      },
    ]),
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT sells,pooled_swaps,bought_raw,sold_raw,quantity_raw::text AS quantity,supported FROM agg_positions",
      )
    ).rows,
    [
      {
        sells: 1,
        pooled_swaps: 0,
        bought_raw: null,
        sold_raw: null,
        quantity: "70",
        supported: true,
      },
    ],
  );
  // Walking back past the hand-laid batch restores its rewritten pre-image
  // under the new constraints.
  await walkBackLedger(db, base + 9);
  assert.deepEqual(
    (
      await db.query(
        "SELECT buys,pooled_swaps,bought_raw,quantity_raw::text AS quantity,flags FROM agg_positions",
      )
    ).rows,
    [{ buys: 1, pooled_swaps: 0, bought_raw: null, quantity: "60", flags: [] }],
  );
  await releaseLedgerWriter(db);
});
