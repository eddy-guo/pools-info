// The aggregate ledger's writer (docs/AGGREGATE-LEDGER.md, design report
// section 7.2): one batch of already-validated swap, transfer and launch rows
// is applied to the agg_* tables in one transaction under the ledger writer
// lock. Application is idempotent by content hash, every row a batch changes
// has its pre-image journaled first, and walkBackLedger restores those
// pre-images in reverse batch order after a reorg or a provider fork.
import { createHash } from "node:crypto";
import { contracts } from "@pools/chain";
import {
  applyLedgerEvents,
  createLedgerState,
  ledgerKeys,
  planLedgerBatch,
  poolHourKey,
  positionKey,
  walletHourKey,
  type LedgerFlag,
  type LedgerRules,
  type LedgerSwap,
  type LedgerTransfer,
} from "@pools/core";
import { getStream, type Client, type Stream } from "./index";
import { discoveryV2Identity } from "./discovery";
import { writeLedgerTransferProvenance } from "./ledger-provenance";

export const ledgerStream = Object.freeze({
  key: "ledger:agg:v1",
  /** The first launch; nothing registered exists before it. */
  start: 23467030,
  /** The lag every batch proves against the archive height. */
  confirmations: 128,
  /** Batches whose journal is kept for walk-back. */
  journalDepth: 256,
  /** The live ring is the 24 hours ending at the cursor. */
  liveTradeSeconds: 86400,
  /** A disk bound under that window, sized from measured rows: the busiest
   * rolling 24 hours of the registered history held 1,026,761 swaps (5 to 6
   * Aug 2026, summed from agg_pool_hours after the history pass; 17 Sep's
   * held 382,835), and a ring row costs 459 bytes with its indexes freshly
   * written and 661 under the writer's insert-and-prune churn. 1,250,000 rows
   * keep the whole 24 hours on every day measured, with a fifth to spare, and
   * hold the table near 0.6 to 0.8 GB when a day that busy recurs. The old
   * recent tables had no bound and would have filled the volume. */
  liveTradeRows: 1250000,
} as const);
/** The pass's catalog stream: launches re-discovered from HyperSync, written
 * through the ordinary discovery commit so the catalog readers see exactly
 * what they see today. It advances in lockstep with the ledger stream, one
 * committed range each, and the pass rewinds it to the ledger cursor when a
 * stop landed between the two commits. */
export const ledgerLaunchStreamIdentity = Object.freeze({
  key: "launches:agg:v1",
  start: 23467030,
  registryRevision: discoveryV2Identity.registryRevision,
  registrySourceRevision: discoveryV2Identity.registrySourceRevision,
});
export async function ensureLedgerLaunchStream(db: Client): Promise<Stream> {
  const identity = ledgerLaunchStreamIdentity;
  await db.query(
    `INSERT INTO indexer_streams
      (chain_id, stream_key, kind, start_block, registry_revision, registry_source_revision)
      VALUES (4663,$1,'discovery',$2,$3,$4)
      ON CONFLICT (chain_id,stream_key) DO NOTHING`,
    [
      identity.key,
      identity.start,
      identity.registryRevision,
      identity.registrySourceRevision,
    ],
  );
  const saved = await db.query(
    "SELECT registry_revision, registry_source_revision FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1",
    [identity.key],
  );
  const current = await getStream(db, identity.key);
  if (
    current.kind !== "discovery" ||
    current.poolId !== null ||
    current.start !== identity.start ||
    saved.rows[0]?.registry_revision !== identity.registryRevision ||
    saved.rows[0]?.registry_source_revision !== identity.registrySourceRevision
  )
    throw Error("ledger_launch_stream_identity");
  return current;
}
/** Every registered pool launched at or before a block, in launch order:
 * the registry that leads a range's swap and transfer filters. */
export async function ledgerRegistry(
  db: Client,
  throughBlock: number,
): Promise<{ poolId: string; token: string; launchBlock: number }[]> {
  if (!integer(throughBlock)) throw Error("ledger_invalid_registry_block");
  const r = await db.query(
    "SELECT pool_id,token,launch_block FROM indexed_pools WHERE chain_id=4663 AND launch_block<=$1 ORDER BY launch_block,pool_id",
    [throughBlock],
  );
  return r.rows.map((row) => ({
    poolId: row.pool_id as string,
    token: row.token as string,
    launchBlock: Number(row.launch_block),
  }));
}
/** Positions created by a committed batch: its journal rows without a
 * pre-image. The pass sums them into pairs per swap. */
export async function ledgerBatchCreatedRows(db: Client, toBlock: number) {
  const r = await db.query(
    `SELECT "table",count(*)::int AS created FROM agg_journal WHERE chain_id=4663 AND stream_key=$1 AND batch_end=$2 AND before IS NULL GROUP BY "table"`,
    [ledgerStream.key, toBlock],
  );
  const created = { positions: 0, wallets: 0 };
  for (const row of r.rows) {
    if (row.table === "agg_positions") created.positions = row.created;
    if (row.table === "agg_wallets") created.wallets = row.created;
  }
  return created;
}
/** Row totals of the ledger, read once when a pass starts or resumes. */
export async function ledgerTotals(db: Client) {
  const r = await db.query(
    `SELECT (SELECT count(*) FROM agg_positions WHERE chain_id=4663)::text AS positions,
            (SELECT count(*) FROM agg_wallets)::text AS wallets,
            (SELECT count(*) FROM agg_batches WHERE chain_id=4663 AND stream_key=$1)::text AS batches,
            (SELECT coalesce(sum(swaps),0) FROM agg_batches WHERE chain_id=4663 AND stream_key=$1)::text AS swaps,
            (SELECT coalesce(sum(transfers),0) FROM agg_batches WHERE chain_id=4663 AND stream_key=$1)::text AS transfers,
            (SELECT coalesce(sum(launches),0) FROM agg_batches WHERE chain_id=4663 AND stream_key=$1)::text AS launches,
            (SELECT coalesce(sum(requests),0) FROM agg_batches WHERE chain_id=4663 AND stream_key=$1)::text AS requests,
            (SELECT coalesce(sum(bytes),0) FROM agg_batches WHERE chain_id=4663 AND stream_key=$1)::text AS bytes`,
    [ledgerStream.key],
  );
  const row = r.rows[0];
  return {
    positions: Number(row.positions),
    wallets: Number(row.wallets),
    batches: Number(row.batches),
    swaps: Number(row.swaps),
    transfers: Number(row.transfers),
    launches: Number(row.launches),
    requests: Number(row.requests),
    bytes: Number(row.bytes),
  };
}
/** The provider's head as the tip loop last read it: the block, its
 * timestamp and when it was checked, beside the cursor. */
export async function observeLedgerHead(
  db: Client,
  head: number,
  timestamp: number,
) {
  if (!integer(head) || !integer(timestamp)) throw Error("ledger_invalid_head");
  await assertLedgerWriter(db);
  const r = await db.query(
    "UPDATE agg_streams SET head_block=$2,head_timestamp=$3,checked_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
    [ledgerStream.key, head, timestamp],
  );
  if (!r.rowCount) throw Error("ledger_stream_missing");
}
/** Prune the live ring to the window ending at `through` (a cursor
 * timestamp) and to the newest `maxRows` rows. Runs inside the batch's
 * transaction; returns the rows removed by age and by count. */
export async function pruneLedgerLiveTrades(
  db: Client,
  bound: { through: number; seconds?: number; maxRows?: number },
) {
  const seconds = bound.seconds ?? ledgerStream.liveTradeSeconds,
    maxRows = bound.maxRows ?? ledgerStream.liveTradeRows;
  if (
    !integer(bound.through) ||
    !integer(seconds) ||
    !integer(maxRows) ||
    maxRows < 1
  )
    throw Error("ledger_invalid_ring_bound");
  const aged = await db.query(
    "DELETE FROM agg_live_trades WHERE chain_id=4663 AND timestamp<$1",
    [bound.through - seconds],
  );
  const counted = await db.query(
    `DELETE FROM agg_live_trades t USING (SELECT block_number,log_index FROM agg_live_trades WHERE chain_id=4663 ORDER BY block_number DESC,log_index DESC OFFSET $1 LIMIT 1) AS edge
     WHERE t.chain_id=4663 AND (t.block_number,t.log_index)<=(edge.block_number,edge.log_index)`,
    [maxRows],
  );
  return { aged: aged.rowCount ?? 0, counted: counted.rowCount ?? 0 };
}
/** Hand the stream to the tip loop once the pass reaches the confirmed cutoff. */
export async function setLedgerMode(db: Client, mode: LedgerMode) {
  if (mode !== "pass" && mode !== "tip") throw Error("ledger_invalid_mode");
  await db.query(
    "UPDATE agg_streams SET mode=$2,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
    [ledgerStream.key, mode],
  );
}
export const ledgerRules: LedgerRules = {
  manager: contracts.manager,
  router: contracts.router,
};
export type LedgerMode = "pass" | "tip";
export interface LedgerStreamState {
  start: number;
  cursor: number | null;
  hash: string | null;
  timestamp: number | null;
  head: number | null;
  headTimestamp: number | null;
  mode: LedgerMode;
}
/** A launch the caller registered in indexed_pools for this range; the ledger
 * verifies the registration and counts it into the batch's evidence. */
export interface LedgerLaunch {
  poolId: string;
  token: string;
  block: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
}
export interface LedgerBatch {
  from: number;
  to: number;
  /** The hash of block from - 1: must equal the saved cursor's hash. */
  parentHash: string;
  /** The hash of block to: becomes the cursor's hash. */
  hash: string;
  timestamp: number;
  archiveHeight: number;
  registryPools: number;
  query: unknown;
  pages: unknown;
  requests: number;
  bytes: number;
  launches: readonly LedgerLaunch[];
  swaps: readonly LedgerSwap[];
  transfers: readonly LedgerTransfer[];
}
export interface LedgerApplied {
  changed: boolean;
  contentHash: string;
  swaps: number;
  transfers: number;
  launches: number;
  attributed: number;
  unattributed: number;
  unregisteredSwaps: number;
  positions: number;
  newWallets: number;
}

const hex32 = /^0x[0-9a-f]{64}$/i;
const integer = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;
const bytes = (hex: string) => hex.slice(2).toLowerCase();
const lower = (s: string) => s.toLowerCase();
const logOrder = (
  a: { block: number; logIndex: number },
  b: { block: number; logIndex: number },
) => a.block - b.block || a.logIndex - b.logIndex;

/** SHA-256 of the canonical serialisation of what a batch consumed: its
 * range and boundary hashes, then every launch, swap and transfer row in log
 * order with its fields in a fixed order. Replaying a range must reproduce it. */
export function ledgerContentHash(batch: LedgerBatch) {
  const canonical = JSON.stringify({
    v: 1,
    from: batch.from,
    to: batch.to,
    parentHash: lower(batch.parentHash),
    hash: lower(batch.hash),
    timestamp: batch.timestamp,
    launches: [...batch.launches]
      .sort(logOrder)
      .map((l) => [
        l.block,
        l.logIndex,
        lower(l.txHash),
        lower(l.blockHash),
        lower(l.poolId),
        lower(l.token),
      ]),
    swaps: [...batch.swaps]
      .sort(logOrder)
      .map((s) => [
        s.block,
        s.logIndex,
        lower(s.txHash),
        lower(s.blockHash),
        lower(s.poolId),
        lower(s.token),
        lower(s.initiator),
        s.txTo === null ? null : lower(s.txTo),
        s.side,
        s.ethWei,
        s.tokenRaw,
        s.sqrtPriceX96,
        s.liquidity,
        s.tick,
      ]),
    transfers: [...batch.transfers]
      .sort(logOrder)
      .map((t) => [
        t.block,
        t.logIndex,
        lower(t.txHash),
        lower(t.blockHash),
        lower(t.token),
        lower(t.from),
        lower(t.to),
        t.value,
      ]),
  });
  return "0x" + createHash("sha256").update(canonical).digest("hex");
}

function streamState(row: Record<string, unknown>): LedgerStreamState {
  const n = (v: unknown) => (v === null ? null : Number(v));
  return {
    start: Number(row.start_block),
    cursor: n(row.cursor_block),
    hash: row.cursor_hash === null ? null : "0x" + String(row.cursor_hash),
    timestamp: n(row.cursor_timestamp),
    head: n(row.head_block),
    headTimestamp: n(row.head_timestamp),
    mode: row.mode as LedgerMode,
  };
}
const streamSelect =
  "SELECT start_block,cursor_block,encode(cursor_hash,'hex') AS cursor_hash,cursor_timestamp,head_block,head_timestamp,mode FROM agg_streams WHERE chain_id=4663 AND stream_key=$1";
export async function ensureLedgerStream(
  db: Client,
  mode: LedgerMode = "pass",
) {
  if (mode !== "pass" && mode !== "tip") throw Error("ledger_invalid_mode");
  await db.query(
    "INSERT INTO agg_streams(chain_id,stream_key,start_block,mode) VALUES (4663,$1,$2,$3) ON CONFLICT DO NOTHING",
    [ledgerStream.key, ledgerStream.start, mode],
  );
  return readLedgerStream(db);
}
export async function readLedgerStream(db: Client): Promise<LedgerStreamState> {
  const r = await db.query(streamSelect, [ledgerStream.key]);
  if (!r.rowCount) throw Error("ledger_stream_missing");
  return streamState(r.rows[0]);
}
/** The newest checkpoints, newest first, for reconciling the cursor against
 * the provider before extending. */
export async function ledgerCheckpoints(db: Client) {
  const r = await db.query(
    "SELECT to_block,encode(block_hash,'hex') AS hash FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 ORDER BY to_block DESC LIMIT $2",
    [ledgerStream.key, ledgerStream.journalDepth],
  );
  return r.rows.map((row) => ({
    to: Number(row.to_block),
    hash: "0x" + row.hash,
  }));
}
/** One process writes the ledger: the pass, then the tip loop. */
export async function acquireLedgerWriter(db: Client) {
  const r = await db.query(
    "SELECT pg_try_advisory_lock(4663, 19005) AS acquired",
  );
  return r.rows[0].acquired === true;
}
export async function releaseLedgerWriter(db: Client) {
  await db.query("SELECT pg_advisory_unlock(4663, 19005)");
}
/** Inside the ledger's own writers only; not exported from the package. */
export async function assertLedgerWriter(db: Client) {
  const r = await db.query(
    "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=4663 AND objid=19005 AND objsubid=2 AND granted AND pid=pg_backend_pid()",
  );
  if (!r.rowCount) throw Error("ledger_writer_required");
}

function checkBatch(batch: LedgerBatch) {
  if (
    !integer(batch.from) ||
    !integer(batch.to) ||
    batch.from > batch.to ||
    !hex32.test(batch.parentHash) ||
    !hex32.test(batch.hash) ||
    !integer(batch.timestamp) ||
    !integer(batch.archiveHeight) ||
    batch.archiveHeight < batch.to + ledgerStream.confirmations ||
    !integer(batch.registryPools) ||
    !integer(batch.requests) ||
    !integer(batch.bytes) ||
    batch.query === undefined ||
    batch.pages === undefined
  )
    throw Error("ledger_invalid_batch");
  for (const row of [...batch.launches, ...batch.swaps, ...batch.transfers])
    if (!integer(row.block) || row.block < batch.from || row.block > batch.to)
      throw Error("ledger_row_outside_batch");
  for (const l of batch.launches)
    if (
      !hex32.test(l.poolId) ||
      !hex32.test(l.txHash) ||
      !hex32.test(l.blockHash) ||
      !integer(l.logIndex)
    )
      throw Error("ledger_invalid_launch");
  const last = [...batch.swaps, ...batch.transfers, ...batch.launches].filter(
    (r) => r.block === batch.to,
  );
  if (last.some((r) => lower(r.blockHash) !== lower(batch.hash)))
    throw Error("ledger_row_outside_batch");
}

interface PoolRef {
  ref: number;
  poolId: string;
  token: string;
}
type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const big = (v: unknown) => BigInt(String(v));
const nullable = <T>(v: unknown, f: (v: unknown) => T) =>
  v === null ? null : f(v);

/** Apply one batch. Under the writer lock, in one transaction: the same
 * range with the same content hash is a no-op, a differing hash is refused
 * (`ledger_batch_conflict`), a range that does not extend the cursor is
 * refused; every touched row is journaled before it changes; the batch row
 * and the cursor advance with the rows. */
export async function applyLedgerBatch(
  db: Client,
  batch: LedgerBatch,
): Promise<LedgerApplied> {
  checkBatch(batch);
  const contentHash = ledgerContentHash(batch);
  await db.query("BEGIN");
  try {
    await assertLedgerWriter(db);
    const locked = await db.query(streamSelect + " FOR UPDATE", [
      ledgerStream.key,
    ]);
    if (!locked.rowCount) throw Error("ledger_stream_missing");
    const stream = streamState(locked.rows[0]);
    const previous = await db.query(
      "SELECT encode(content_hash,'hex') AS content_hash FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
      [ledgerStream.key, batch.to],
    );
    if (previous.rowCount) {
      if ("0x" + previous.rows[0].content_hash !== contentHash)
        throw Error("ledger_batch_conflict");
      await db.query("COMMIT");
      return {
        changed: false,
        contentHash,
        swaps: batch.swaps.length,
        transfers: batch.transfers.length,
        launches: batch.launches.length,
        attributed: 0,
        unattributed: 0,
        unregisteredSwaps: 0,
        positions: 0,
        newWallets: 0,
      };
    }
    const expectedFrom =
      stream.cursor === null ? stream.start : stream.cursor + 1;
    if (
      batch.from !== expectedFrom ||
      (stream.hash !== null && lower(batch.parentHash) !== stream.hash)
    )
      throw Error("ledger_noncontiguous_batch");
    // The registry: every pool a row names, resolved to its surrogate.
    const registry = await db.query(
      "SELECT pool_ref,pool_id,token FROM indexed_pools WHERE chain_id=4663 AND (pool_id = ANY($1::text[]) OR token = ANY($2::text[]))",
      [
        [
          ...new Set([
            ...batch.swaps.map((s) => lower(s.poolId)),
            ...batch.launches.map((l) => lower(l.poolId)),
          ]),
        ],
        [
          ...new Set([
            ...batch.transfers.map((t) => lower(t.token)),
            ...batch.launches.map((l) => lower(l.token)),
          ]),
        ],
      ],
    );
    const byPool = new Map<string, PoolRef>(),
      byToken = new Map<string, PoolRef>();
    for (const row of registry.rows) {
      const entry = {
        ref: row.pool_ref as number,
        poolId: row.pool_id as string,
        token: row.token as string,
      };
      byPool.set(entry.poolId, entry);
      byToken.set(entry.token, entry);
    }
    for (const l of batch.launches) {
      const entry = byPool.get(lower(l.poolId));
      if (!entry || entry.token !== lower(l.token))
        throw Error("ledger_unregistered_launch");
    }
    const swaps: LedgerSwap[] = [];
    let unregisteredSwaps = 0;
    for (const s of batch.swaps) {
      const entry = byPool.get(lower(s.poolId));
      if (!entry) {
        unregisteredSwaps++;
        continue;
      }
      if (entry.token !== lower(s.token))
        throw Error("ledger_swap_token_mismatch");
      swaps.push(s);
    }
    const transfers = batch.transfers.filter((t) =>
      byToken.has(lower(t.token)),
    );
    const events = planLedgerBatch(
      { swaps, transfers, registry: [...byPool.values()] },
      ledgerRules,
    );
    const keys = ledgerKeys(events);
    const attributed = events.filter((e) => e.kind === "swap").length,
      unattributed = events.filter(
        (e) => e.kind === "unattributed_swap",
      ).length;
    // The batch row first: the journal and the live trades reference it.
    await db.query(
      `INSERT INTO agg_batches(chain_id,stream_key,to_block,from_block,from_parent_hash,block_hash,to_timestamp,archive_height,registry_pools,content_hash,query,pages,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,requests,bytes)
       VALUES (4663,$1,$2,$3,decode($4,'hex'),decode($5,'hex'),$6,$7,$8,decode($9,'hex'),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        ledgerStream.key,
        batch.to,
        batch.from,
        bytes(batch.parentHash),
        bytes(batch.hash),
        batch.timestamp,
        batch.archiveHeight,
        batch.registryPools,
        bytes(contentHash),
        JSON.stringify(batch.query),
        JSON.stringify(batch.pages),
        batch.swaps.length,
        batch.transfers.length,
        batch.launches.length,
        attributed,
        unattributed,
        unregisteredSwaps,
        batch.requests,
        batch.bytes,
      ],
    );
    const poolRef = (poolId: string) => byPool.get(poolId)!.ref;
    const poolIdOf = new Map(
      [...byPool.values()].map((p) => [p.ref, p.poolId]),
    );
    // Wallets: existing refs, then new rows (journaled as created) in one statement.
    const walletRef = new Map<string, number>(),
      walletOf = new Map<number, string>();
    let newWallets = 0;
    if (keys.wallets.length) {
      const known = await db.query(
        "SELECT wallet_ref,encode(address,'hex') AS address FROM agg_wallets WHERE address = ANY(ARRAY(SELECT decode(a,'hex') FROM unnest($1::text[]) AS a))",
        [keys.wallets.map((w) => bytes(w.wallet))],
      );
      for (const row of known.rows)
        walletRef.set("0x" + row.address, row.wallet_ref);
      const fresh = keys.wallets.filter((w) => !walletRef.has(w.wallet));
      if (fresh.length) {
        const created = await db.query(
          `WITH n AS (SELECT decode(a,'hex') AS address,b AS first_block FROM unnest($1::text[],$2::bigint[]) AS x(a,b)),
           i AS (INSERT INTO agg_wallets(address,first_block) SELECT address,first_block FROM n RETURNING wallet_ref,address),
           j AS (INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before) SELECT 4663,$3,$4,'agg_wallets',jsonb_build_object('wallet_ref',wallet_ref),NULL FROM i)
           SELECT wallet_ref,encode(address,'hex') AS address FROM i`,
          [
            fresh.map((w) => bytes(w.wallet)),
            fresh.map((w) => w.firstBlock),
            ledgerStream.key,
            batch.to,
          ],
        );
        for (const row of created.rows)
          walletRef.set("0x" + row.address, row.wallet_ref);
        newWallets = created.rowCount ?? 0;
      }
      for (const [address, ref] of walletRef) walletOf.set(ref, address);
    }
    // Journal the pre-image of every row the plan can touch, and load the rows.
    const state = createLedgerState();
    const journal = [ledgerStream.key, batch.to];
    if (keys.positions.length) {
      const loaded = await db.query(
        `WITH k AS (SELECT * FROM unnest($1::int[],$2::int[]) AS k(pool_ref,wallet_ref)),
         j AS (INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
           SELECT 4663,$3,$4,'agg_positions',jsonb_build_object('pool_ref',k.pool_ref,'wallet_ref',k.wallet_ref),to_jsonb(p)
           FROM k LEFT JOIN agg_positions p ON p.chain_id=4663 AND p.pool_ref=k.pool_ref AND p.wallet_ref=k.wallet_ref
           ON CONFLICT DO NOTHING)
         SELECT p.* FROM k JOIN agg_positions p ON p.chain_id=4663 AND p.pool_ref=k.pool_ref AND p.wallet_ref=k.wallet_ref`,
        [
          keys.positions.map((k) => poolRef(k.poolId)),
          keys.positions.map((k) => walletRef.get(k.wallet)!),
          ...journal,
        ],
      );
      for (const r of loaded.rows as Row[]) {
        const poolId = poolIdOf.get(r.pool_ref as number)!,
          wallet = walletOf.get(r.wallet_ref as number)!;
        state.positions.set(positionKey(poolId, wallet), {
          poolId,
          wallet,
          quantity: big(r.quantity_raw),
          cost: big(r.cost_wei),
          invested: big(r.invested_wei),
          proceeds: big(r.proceeds_wei),
          disposedCost: big(r.disposed_cost_wei),
          realized: big(r.realized_wei),
          inflow: big(r.inflow_raw),
          outflow: big(r.outflow_raw),
          outflowCost: big(r.outflow_cost_wei),
          buys: num(r.buys),
          sells: num(r.sells),
          wrapperSwaps: num(r.wrapper_swaps),
          counterpartySwaps: num(r.counterparty_swaps),
          cycleOpenedAt: nullable(r.cycle_opened_at, num),
          cycleGain: nullable(r.cycle_gain_wei, big),
          closedCycles: nullable(r.closed_cycles, num),
          flashCycles: nullable(r.flash_cycles, num),
          shortestCycleSeconds: nullable(r.shortest_cycle_seconds, num),
          firstBlock: num(r.first_block),
          lastBlock: num(r.last_block),
          lastTimestamp: num(r.last_timestamp),
          supported: r.supported as boolean,
          flags: r.flags as LedgerFlag[],
        });
      }
    }
    if (keys.walletHours.length) {
      const loaded = await db.query(
        `WITH k AS (SELECT * FROM unnest($1::int[],$2::int[],$3::int[]) AS k(wallet_ref,pool_ref,hour)),
         j AS (INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
           SELECT 4663,$4,$5,'agg_wallet_hours',jsonb_build_object('wallet_ref',k.wallet_ref,'pool_ref',k.pool_ref,'hour',k.hour),to_jsonb(h)
           FROM k LEFT JOIN agg_wallet_hours h ON h.chain_id=4663 AND h.wallet_ref=k.wallet_ref AND h.pool_ref=k.pool_ref AND h.hour=k.hour
           ON CONFLICT DO NOTHING)
         SELECT h.* FROM k JOIN agg_wallet_hours h ON h.chain_id=4663 AND h.wallet_ref=k.wallet_ref AND h.pool_ref=k.pool_ref AND h.hour=k.hour`,
        [
          keys.walletHours.map((k) => walletRef.get(k.wallet)!),
          keys.walletHours.map((k) => poolRef(k.poolId)),
          keys.walletHours.map((k) => k.hour),
          ...journal,
        ],
      );
      for (const r of loaded.rows as Row[]) {
        const poolId = poolIdOf.get(r.pool_ref as number)!,
          wallet = walletOf.get(r.wallet_ref as number)!;
        state.walletHours.set(walletHourKey(wallet, poolId, num(r.hour)), {
          wallet,
          poolId,
          hour: num(r.hour),
          realized: big(r.realized_wei),
          disposedCost: big(r.disposed_cost_wei),
          proceeds: big(r.proceeds_wei),
          spent: big(r.spent_wei),
          volume: big(r.volume_wei),
          buys: num(r.buys),
          sells: num(r.sells),
          supportedTrades: num(r.supported_trades),
          wins: num(r.wins),
          losses: num(r.losses),
          closures: num(r.closures),
          holdSeconds: num(r.hold_seconds),
          flashClosures: nullable(r.flash_closures, num),
          best: nullable(r.best_wei, big),
        });
      }
    }
    if (keys.poolHours.length) {
      const loaded = await db.query(
        `WITH k AS (SELECT * FROM unnest($1::int[],$2::int[]) AS k(pool_ref,hour)),
         j AS (INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
           SELECT 4663,$3,$4,'agg_pool_hours',jsonb_build_object('pool_ref',k.pool_ref,'hour',k.hour),to_jsonb(h)
           FROM k LEFT JOIN agg_pool_hours h ON h.chain_id=4663 AND h.pool_ref=k.pool_ref AND h.hour=k.hour
           ON CONFLICT DO NOTHING)
         SELECT h.* FROM k JOIN agg_pool_hours h ON h.chain_id=4663 AND h.pool_ref=k.pool_ref AND h.hour=k.hour`,
        [
          keys.poolHours.map((k) => poolRef(k.poolId)),
          keys.poolHours.map((k) => k.hour),
          ...journal,
        ],
      );
      for (const r of loaded.rows as Row[]) {
        const poolId = poolIdOf.get(r.pool_ref as number)!;
        state.poolHours.set(poolHourKey(poolId, num(r.hour)), {
          poolId,
          hour: num(r.hour),
          trades: num(r.trades),
          buys: num(r.buys),
          sells: num(r.sells),
          unattributed: num(r.unattributed),
          volume: big(r.volume_wei),
          buyers: num(r.buyers),
          sellers: num(r.sellers),
          open: big(r.open_sqrt_price_x96),
          close: big(r.close_sqrt_price_x96),
          high: big(r.high_sqrt_price_x96),
          low: big(r.low_sqrt_price_x96),
          closeBlock: num(r.close_block),
          closeLogIndex: num(r.close_log_index),
        });
      }
    }
    if (keys.pools.length) {
      const loaded = await db.query(
        `WITH k AS (SELECT * FROM unnest($1::int[]) AS k(pool_ref)),
         j AS (INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
           SELECT 4663,$2,$3,'agg_pool_state',jsonb_build_object('pool_ref',k.pool_ref),to_jsonb(s)
           FROM k LEFT JOIN agg_pool_state s ON s.chain_id=4663 AND s.pool_ref=k.pool_ref
           ON CONFLICT DO NOTHING)
         SELECT s.*,encode(s.price_tx,'hex') AS price_tx_hex FROM k JOIN agg_pool_state s ON s.chain_id=4663 AND s.pool_ref=k.pool_ref`,
        [keys.pools.map(poolRef), ...journal],
      );
      for (const r of loaded.rows as Row[]) {
        const poolId = poolIdOf.get(r.pool_ref as number)!;
        state.pools.set(poolId, {
          poolId,
          trades: num(r.trades),
          volume: big(r.volume_wei),
          sqrtPriceX96: big(r.sqrt_price_x96),
          liquidity: big(r.liquidity),
          tick: num(r.tick),
          priceBlock: num(r.price_block),
          priceLogIndex: num(r.price_log_index),
          priceTx: "0x" + r.price_tx_hex,
          priceTimestamp: num(r.price_timestamp),
          firstTradeTimestamp: num(r.first_trade_timestamp),
          lastTradeTimestamp: num(r.last_trade_timestamp),
        });
      }
    }
    const applied = applyLedgerEvents(state, events);
    // A position excluded in this batch has every earlier hour row's finances
    // zeroed; the rows outside the plan's keys are journaled here first.
    const excludedPairs = applied.excluded.map(
      (p) => [walletRef.get(p.wallet)!, poolRef(p.poolId)] as const,
    );
    if (excludedPairs.length)
      await db.query(
        `INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before)
         SELECT 4663,$3,$4,'agg_wallet_hours',jsonb_build_object('wallet_ref',h.wallet_ref,'pool_ref',h.pool_ref,'hour',h.hour),to_jsonb(h)
         FROM agg_wallet_hours h JOIN unnest($1::int[],$2::int[]) AS k(wallet_ref,pool_ref) ON h.wallet_ref=k.wallet_ref AND h.pool_ref=k.pool_ref
         WHERE h.chain_id=4663 ON CONFLICT DO NOTHING`,
        [
          excludedPairs.map((k) => k[0]),
          excludedPairs.map((k) => k[1]),
          ...journal,
        ],
      );
    // Writes. Amounts travel as decimal strings inside JSON, never as numbers.
    const chunks = <T>(rows: T[]) => {
      const out: T[][] = [];
      for (let i = 0; i < rows.length; i += 1000)
        out.push(rows.slice(i, i + 1000));
      return out;
    };
    for (const chunk of chunks(
      [...applied.changed.positions].map((k) => state.positions.get(k)!),
    ))
      await db.query(
        `INSERT INTO agg_positions(chain_id,pool_ref,wallet_ref,quantity_raw,cost_wei,invested_wei,proceeds_wei,disposed_cost_wei,realized_wei,inflow_raw,outflow_raw,outflow_cost_wei,buys,sells,wrapper_swaps,counterparty_swaps,cycle_opened_at,cycle_gain_wei,closed_cycles,flash_cycles,shortest_cycle_seconds,first_block,last_block,last_timestamp,supported,flags)
         SELECT 4663,r.* FROM jsonb_to_recordset($1::jsonb) AS r(pool_ref int,wallet_ref int,quantity_raw numeric,cost_wei numeric,invested_wei numeric,proceeds_wei numeric,disposed_cost_wei numeric,realized_wei numeric,inflow_raw numeric,outflow_raw numeric,outflow_cost_wei numeric,buys int,sells int,wrapper_swaps int,counterparty_swaps int,cycle_opened_at bigint,cycle_gain_wei numeric,closed_cycles int,flash_cycles int,shortest_cycle_seconds bigint,first_block bigint,last_block bigint,last_timestamp bigint,supported boolean,flags text[])
         ON CONFLICT (chain_id,pool_ref,wallet_ref) DO UPDATE SET quantity_raw=EXCLUDED.quantity_raw,cost_wei=EXCLUDED.cost_wei,invested_wei=EXCLUDED.invested_wei,proceeds_wei=EXCLUDED.proceeds_wei,disposed_cost_wei=EXCLUDED.disposed_cost_wei,realized_wei=EXCLUDED.realized_wei,inflow_raw=EXCLUDED.inflow_raw,outflow_raw=EXCLUDED.outflow_raw,outflow_cost_wei=EXCLUDED.outflow_cost_wei,buys=EXCLUDED.buys,sells=EXCLUDED.sells,wrapper_swaps=EXCLUDED.wrapper_swaps,counterparty_swaps=EXCLUDED.counterparty_swaps,cycle_opened_at=EXCLUDED.cycle_opened_at,cycle_gain_wei=EXCLUDED.cycle_gain_wei,closed_cycles=EXCLUDED.closed_cycles,flash_cycles=EXCLUDED.flash_cycles,shortest_cycle_seconds=EXCLUDED.shortest_cycle_seconds,first_block=EXCLUDED.first_block,last_block=EXCLUDED.last_block,last_timestamp=EXCLUDED.last_timestamp,supported=EXCLUDED.supported,flags=EXCLUDED.flags`,
        [
          JSON.stringify(
            chunk.map((p) => ({
              pool_ref: poolRef(p.poolId),
              wallet_ref: walletRef.get(p.wallet)!,
              quantity_raw: p.quantity.toString(),
              cost_wei: p.cost.toString(),
              invested_wei: p.invested.toString(),
              proceeds_wei: p.proceeds.toString(),
              disposed_cost_wei: p.disposedCost.toString(),
              realized_wei: p.realized.toString(),
              inflow_raw: p.inflow.toString(),
              outflow_raw: p.outflow.toString(),
              outflow_cost_wei: p.outflowCost.toString(),
              buys: p.buys,
              sells: p.sells,
              wrapper_swaps: p.wrapperSwaps,
              counterparty_swaps: p.counterpartySwaps,
              cycle_opened_at: p.cycleOpenedAt,
              cycle_gain_wei:
                p.cycleGain === null ? null : p.cycleGain.toString(),
              closed_cycles: p.closedCycles,
              flash_cycles: p.flashCycles,
              shortest_cycle_seconds: p.shortestCycleSeconds,
              first_block: p.firstBlock,
              last_block: p.lastBlock,
              last_timestamp: p.lastTimestamp,
              supported: p.supported,
              flags: p.flags,
            })),
          ),
        ],
      );
    for (const chunk of chunks(
      [...applied.changed.walletHours].map((k) => state.walletHours.get(k)!),
    ))
      await db.query(
        `INSERT INTO agg_wallet_hours(chain_id,wallet_ref,pool_ref,hour,realized_wei,disposed_cost_wei,proceeds_wei,spent_wei,volume_wei,buys,sells,supported_trades,wins,losses,closures,hold_seconds,flash_closures,best_wei)
         SELECT 4663,r.* FROM jsonb_to_recordset($1::jsonb) AS r(wallet_ref int,pool_ref int,hour int,realized_wei numeric,disposed_cost_wei numeric,proceeds_wei numeric,spent_wei numeric,volume_wei numeric,buys int,sells int,supported_trades int,wins int,losses int,closures int,hold_seconds bigint,flash_closures int,best_wei numeric)
         ON CONFLICT (chain_id,wallet_ref,pool_ref,hour) DO UPDATE SET realized_wei=EXCLUDED.realized_wei,disposed_cost_wei=EXCLUDED.disposed_cost_wei,proceeds_wei=EXCLUDED.proceeds_wei,spent_wei=EXCLUDED.spent_wei,volume_wei=EXCLUDED.volume_wei,buys=EXCLUDED.buys,sells=EXCLUDED.sells,supported_trades=EXCLUDED.supported_trades,wins=EXCLUDED.wins,losses=EXCLUDED.losses,closures=EXCLUDED.closures,hold_seconds=EXCLUDED.hold_seconds,flash_closures=EXCLUDED.flash_closures,best_wei=EXCLUDED.best_wei`,
        [
          JSON.stringify(
            chunk.map((h) => ({
              wallet_ref: walletRef.get(h.wallet)!,
              pool_ref: poolRef(h.poolId),
              hour: h.hour,
              realized_wei: h.realized.toString(),
              disposed_cost_wei: h.disposedCost.toString(),
              proceeds_wei: h.proceeds.toString(),
              spent_wei: h.spent.toString(),
              volume_wei: h.volume.toString(),
              buys: h.buys,
              sells: h.sells,
              supported_trades: h.supportedTrades,
              wins: h.wins,
              losses: h.losses,
              closures: h.closures,
              hold_seconds: h.holdSeconds,
              flash_closures: h.flashClosures,
              best_wei: h.best === null ? null : h.best.toString(),
            })),
          ),
        ],
      );
    if (excludedPairs.length)
      await db.query(
        `UPDATE agg_wallet_hours h SET realized_wei=0,disposed_cost_wei=0,proceeds_wei=0,spent_wei=0,supported_trades=0,wins=0,losses=0,closures=0,hold_seconds=0,flash_closures=0,best_wei=NULL
         FROM unnest($1::int[],$2::int[]) AS k(wallet_ref,pool_ref) WHERE h.chain_id=4663 AND h.wallet_ref=k.wallet_ref AND h.pool_ref=k.pool_ref`,
        [excludedPairs.map((k) => k[0]), excludedPairs.map((k) => k[1])],
      );
    for (const chunk of chunks(
      [...applied.changed.poolHours].map((k) => state.poolHours.get(k)!),
    ))
      await db.query(
        `INSERT INTO agg_pool_hours(chain_id,pool_ref,hour,trades,buys,sells,unattributed,volume_wei,buyers,sellers,open_sqrt_price_x96,close_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_block,close_log_index)
         SELECT 4663,r.* FROM jsonb_to_recordset($1::jsonb) AS r(pool_ref int,hour int,trades int,buys int,sells int,unattributed int,volume_wei numeric,buyers int,sellers int,open_sqrt_price_x96 numeric,close_sqrt_price_x96 numeric,high_sqrt_price_x96 numeric,low_sqrt_price_x96 numeric,close_block bigint,close_log_index int)
         ON CONFLICT (chain_id,pool_ref,hour) DO UPDATE SET trades=EXCLUDED.trades,buys=EXCLUDED.buys,sells=EXCLUDED.sells,unattributed=EXCLUDED.unattributed,volume_wei=EXCLUDED.volume_wei,buyers=EXCLUDED.buyers,sellers=EXCLUDED.sellers,open_sqrt_price_x96=EXCLUDED.open_sqrt_price_x96,close_sqrt_price_x96=EXCLUDED.close_sqrt_price_x96,high_sqrt_price_x96=EXCLUDED.high_sqrt_price_x96,low_sqrt_price_x96=EXCLUDED.low_sqrt_price_x96,close_block=EXCLUDED.close_block,close_log_index=EXCLUDED.close_log_index`,
        [
          JSON.stringify(
            chunk.map((h) => ({
              pool_ref: poolRef(h.poolId),
              hour: h.hour,
              trades: h.trades,
              buys: h.buys,
              sells: h.sells,
              unattributed: h.unattributed,
              volume_wei: h.volume.toString(),
              buyers: h.buyers,
              sellers: h.sellers,
              open_sqrt_price_x96: h.open.toString(),
              close_sqrt_price_x96: h.close.toString(),
              high_sqrt_price_x96: h.high.toString(),
              low_sqrt_price_x96: h.low.toString(),
              close_block: h.closeBlock,
              close_log_index: h.closeLogIndex,
            })),
          ),
        ],
      );
    for (const chunk of chunks(
      [...applied.changed.pools].map((k) => state.pools.get(k)!),
    ))
      await db.query(
        `INSERT INTO agg_pool_state(chain_id,pool_ref,trades,volume_wei,holders,sqrt_price_x96,liquidity,tick,price_block,price_log_index,price_tx,price_timestamp,first_trade_timestamp,last_trade_timestamp)
         SELECT 4663,r.pool_ref,r.trades,r.volume_wei,0,r.sqrt_price_x96,r.liquidity,r.tick,r.price_block,r.price_log_index,decode(r.price_tx,'hex'),r.price_timestamp,r.first_trade_timestamp,r.last_trade_timestamp
         FROM jsonb_to_recordset($1::jsonb) AS r(pool_ref int,trades bigint,volume_wei numeric,sqrt_price_x96 numeric,liquidity numeric,tick int,price_block bigint,price_log_index int,price_tx text,price_timestamp bigint,first_trade_timestamp bigint,last_trade_timestamp bigint)
         ON CONFLICT (chain_id,pool_ref) DO UPDATE SET trades=EXCLUDED.trades,volume_wei=EXCLUDED.volume_wei,sqrt_price_x96=EXCLUDED.sqrt_price_x96,liquidity=EXCLUDED.liquidity,tick=EXCLUDED.tick,price_block=EXCLUDED.price_block,price_log_index=EXCLUDED.price_log_index,price_tx=EXCLUDED.price_tx,price_timestamp=EXCLUDED.price_timestamp,first_trade_timestamp=EXCLUDED.first_trade_timestamp,last_trade_timestamp=EXCLUDED.last_trade_timestamp`,
        [
          JSON.stringify(
            chunk.map((s) => ({
              pool_ref: poolRef(s.poolId),
              trades: s.trades,
              volume_wei: s.volume.toString(),
              sqrt_price_x96: s.sqrtPriceX96.toString(),
              liquidity: s.liquidity.toString(),
              tick: s.tick,
              price_block: s.priceBlock,
              price_log_index: s.priceLogIndex,
              price_tx: bytes(s.priceTx),
              price_timestamp: s.priceTimestamp,
              first_trade_timestamp: s.firstTradeTimestamp,
              last_trade_timestamp: s.lastTradeTimestamp,
            })),
          ),
        ],
      );
    // holders is the count of positions with a positive quantity, recomputed
    // for every pool whose positions or state changed.
    const touchedPools = new Set([
      ...applied.changed.pools,
      ...[...applied.changed.positions].map(
        (k) => state.positions.get(k)!.poolId,
      ),
    ]);
    if (touchedPools.size)
      await db.query(
        `UPDATE agg_pool_state s SET holders=(SELECT count(*) FROM agg_positions p WHERE p.chain_id=4663 AND p.pool_ref=s.pool_ref AND p.quantity_raw>0)
         WHERE s.chain_id=4663 AND s.pool_ref = ANY($1::int[])`,
        [[...touchedPools].map(poolRef)],
      );
    for (const chunk of chunks(applied.liveTrades))
      await db.query(
        `INSERT INTO agg_live_trades(chain_id,stream_key,pool_ref,wallet_ref,tx_hash,log_index,block_number,block_hash,timestamp,side,eth_wei,token_raw,sqrt_price_x96,attribution,batch_end)
         SELECT 4663,$2,r.pool_ref,r.wallet_ref,decode(r.tx_hash,'hex'),r.log_index,r.block_number,decode(r.block_hash,'hex'),r.timestamp,r.side,r.eth_wei,r.token_raw,r.sqrt_price_x96,r.attribution,$3
         FROM jsonb_to_recordset($1::jsonb) AS r(pool_ref int,wallet_ref int,tx_hash text,log_index int,block_number bigint,block_hash text,timestamp bigint,side text,eth_wei numeric,token_raw numeric,sqrt_price_x96 numeric,attribution text)`,
        [
          JSON.stringify(
            chunk.map((t) => ({
              pool_ref: poolRef(t.poolId),
              wallet_ref: t.wallet === null ? null : walletRef.get(t.wallet)!,
              tx_hash: bytes(t.txHash),
              log_index: t.logIndex,
              block_number: t.block,
              block_hash: bytes(t.blockHash),
              timestamp: t.timestamp,
              side: t.side,
              eth_wei: t.ethWei.toString(),
              token_raw: t.tokenRaw.toString(),
              sqrt_price_x96: t.sqrtPriceX96.toString(),
              attribution: t.attribution,
            })),
          ),
          ledgerStream.key,
          batch.to,
        ],
      );
    await writeLedgerTransferProvenance(
      db,
      batch.to,
      { swaps, transfers, registry: [...byPool.values()] },
      events,
      new Map([...byPool.values()].map((p) => [p.poolId, p.ref])),
    );
    // Prune: the live ring by age and size, the journal beyond the newest batches.
    await pruneLedgerLiveTrades(db, { through: batch.timestamp });
    await db.query(
      `DELETE FROM agg_journal j USING (SELECT to_block FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 ORDER BY to_block DESC OFFSET $2 LIMIT 1) AS edge
       WHERE j.chain_id=4663 AND j.stream_key=$1 AND j.batch_end<=edge.to_block`,
      [ledgerStream.key, ledgerStream.journalDepth],
    );
    // The batch's journal size, which walk-back checks before undoing it.
    await db.query(
      `UPDATE agg_batches SET journal_rows=(SELECT count(*) FROM agg_journal WHERE chain_id=4663 AND stream_key=$1 AND batch_end=$2)
       WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2`,
      [ledgerStream.key, batch.to],
    );
    await db.query(
      "UPDATE agg_streams SET cursor_block=$2,cursor_hash=decode($3,'hex'),cursor_timestamp=$4,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
      [ledgerStream.key, batch.to, bytes(batch.hash), batch.timestamp],
    );
    await db.query("COMMIT");
    return {
      changed: true,
      contentHash,
      swaps: batch.swaps.length,
      transfers: batch.transfers.length,
      launches: batch.launches.length,
      attributed,
      unattributed,
      unregisteredSwaps,
      positions: applied.changed.positions.size,
      newWallets,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

const journalTables = [
  { table: "agg_positions", keys: ["pool_ref", "wallet_ref"] },
  { table: "agg_wallet_hours", keys: ["wallet_ref", "pool_ref", "hour"] },
  { table: "agg_pool_hours", keys: ["pool_ref", "hour"] },
  { table: "agg_pool_state", keys: ["pool_ref"] },
  { table: "agg_wallets", keys: ["wallet_ref"] },
] as const;

/** Undo every batch newer than `ancestor` (null: everything), newest first:
 * each batch's pre-images are restored (a null pre-image deletes the row),
 * the batch row goes with its live trades, journal and any window refresh
 * that reflected it, and the cursor returns to the ancestor. Refused when a
 * batch to undo is older than the journal keeps, or its journal is not whole
 * (`ledger_walkback_unavailable`): written before journal sizes were kept,
 * pruned, or left out of a restored dump. */
export async function walkBackLedger(db: Client, ancestor: number | null) {
  if (ancestor !== null && !integer(ancestor))
    throw Error("ledger_invalid_ancestor");
  await db.query("BEGIN");
  try {
    await assertLedgerWriter(db);
    const locked = await db.query(streamSelect + " FOR UPDATE", [
      ledgerStream.key,
    ]);
    if (!locked.rowCount) throw Error("ledger_stream_missing");
    const stream = streamState(locked.rows[0]);
    const newest = await db.query(
      `SELECT to_block,encode(block_hash,'hex') AS hash,to_timestamp,journal_rows,
         (SELECT count(*) FROM agg_journal j WHERE j.chain_id=4663 AND j.stream_key=b.stream_key AND j.batch_end=b.to_block)::int AS journaled
       FROM agg_batches b WHERE chain_id=4663 AND stream_key=$1 ORDER BY to_block DESC LIMIT $2`,
      [ledgerStream.key, ledgerStream.journalDepth + 1],
    );
    const known = newest.rows.map((r) => ({
      to: Number(r.to_block),
      hash: r.hash as string,
      timestamp: Number(r.to_timestamp),
      whole: r.journal_rows !== null && r.journal_rows === r.journaled,
    }));
    if (
      ancestor !== null &&
      (stream.cursor === null || ancestor > stream.cursor)
    )
      throw Error("ledger_unknown_ancestor");
    const target =
      ancestor === null ? null : known.find((b) => b.to === ancestor);
    if (ancestor !== null && !target) {
      const older = await db.query(
        "SELECT 1 FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
        [ledgerStream.key, ancestor],
      );
      throw Error(
        older.rowCount
          ? "ledger_walkback_unavailable"
          : "ledger_unknown_ancestor",
      );
    }
    const undo = known.filter((b) => ancestor === null || b.to > ancestor);
    if (undo.length > ledgerStream.journalDepth || undo.some((b) => !b.whole))
      throw Error("ledger_walkback_unavailable");
    for (const b of undo) {
      const entries = await db.query(
        // The pre-image travels as jsonb text: parsed in JavaScript, a wei
        // amount beyond 2^53 would come back rounded.
        'SELECT "table",key,before::text AS before FROM agg_journal WHERE chain_id=4663 AND stream_key=$1 AND batch_end=$2',
        [ledgerStream.key, b.to],
      );
      await db.query(
        "DELETE FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
        [ledgerStream.key, b.to],
      );
      for (const { table, keys } of journalTables) {
        const where = [
          ...(table === "agg_wallets" ? [] : ["chain_id=4663"]),
          ...keys.map((k, i) => `${k}=$${i + 1}`),
        ].join(" AND ");
        for (const entry of entries.rows.filter((e) => e.table === table)) {
          const values = keys.map((k) => entry.key[k]);
          // A wallet the batch created may already stand in a window.
          if (table === "agg_wallets")
            await db.query(
              "DELETE FROM agg_wallet_windows WHERE chain_id=4663 AND wallet_ref=$1",
              values,
            );
          await db.query(`DELETE FROM ${table} WHERE ${where}`, values);
          if (entry.before !== null)
            await db.query(
              `INSERT INTO ${table} ${table === "agg_wallets" ? "OVERRIDING SYSTEM VALUE " : ""}SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,
              [entry.before],
            );
        }
      }
    }
    await db.query(
      "UPDATE agg_streams SET cursor_block=$2,cursor_hash=decode($3,'hex'),cursor_timestamp=$4,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
      [
        ledgerStream.key,
        target?.to ?? null,
        target?.hash ?? null,
        target?.timestamp ?? null,
      ],
    );
    await db.query("COMMIT");
    return { removed: undo.map((b) => b.to) };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
