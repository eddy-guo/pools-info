import pg from "pg";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  commitBroadGroupInTransaction,
  snapshotBroadCommit,
  type BroadPoolCommit,
} from "./broad";

export type Client = pg.Client;
export function createClient(url = process.env.DATABASE_URL): Client {
  if (!url || url.includes("user:password@host"))
    throw Error("DATABASE_URL is required");
  return new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    query_timeout: 35000,
    application_name: "pools-indexer",
  });
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function migrate(db: Client) {
  // Transaction-scoped lock also serializes concurrent first-time deployments.
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(4663, 19001)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS pools_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(name, dir), "utf8");
      const checksum = digest(sql);
      const prior = await db.query(
        "SELECT checksum FROM pools_schema_migrations WHERE name=$1",
        [name],
      );
      if (prior.rowCount) {
        if (prior.rows[0].checksum !== checksum)
          throw Error("Applied migration changed; add a new migration");
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO pools_schema_migrations(name, checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
export async function acquireWriter(db: Client) {
  const result = await db.query(
    "SELECT pg_try_advisory_lock(4663, 19002) AS acquired",
  );
  return result.rows[0].acquired === true;
}
/** Wait for a prior deployment to finish. Call on a connection that does not
 * already hold the writer lock; after success no further acquisitions are made. */
export async function waitForWriter(
  db: Client,
  {
    signal,
    timeoutMs = 180000,
    pollMs = 1000,
  }: {
    signal?: AbortSignal;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<boolean> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1
  )
    throw Error("Invalid writer wait options");
  const deadline = performance.now() + timeoutMs;
  while (!signal?.aborted && performance.now() < deadline) {
    const acquired = await acquireWriter(db);
    if (acquired) {
      // Cancellation can race a successful query. Release precisely the one
      // acquisition performed here, leaving no cancelled replacement writer.
      if (signal?.aborted || performance.now() >= deadline) {
        await db.query("SELECT pg_advisory_unlock(4663, 19002)");
        return false;
      }
      return true;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0 || signal?.aborted) return false;
    try {
      await sleep(Math.min(pollMs, remaining), undefined, { signal });
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
  }
  return false;
}
export interface Stream {
  key: string;
  kind: "discovery" | "pool" | "broad";
  poolId: string | null;
  start: number;
  cursor: number | null;
  hash: string | null;
}
function stream(row: Record<string, unknown>): Stream {
  return {
    key: String(row.stream_key),
    kind: row.kind as Stream["kind"],
    poolId: row.pool_id as string | null,
    start: Number(row.start_block),
    cursor: row.cursor_block === null ? null : Number(row.cursor_block),
    hash: row.cursor_hash as string | null,
  };
}
export async function ensureDiscovery(db: Client, start: number) {
  if (!Number.isSafeInteger(start) || start < 0)
    throw Error("Invalid discovery start");
  await db.query(
    "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block) VALUES (4663,'discovery:v1','discovery',$1) ON CONFLICT DO NOTHING",
    [start],
  );
  const current = await getStream(db, "discovery:v1");
  if (current.start !== start)
    throw Error(
      "INDEXER_START_BLOCK differs from saved start; preserve coverage and use the original value",
    );
  return current;
}
export async function getStream(db: Client, key: string): Promise<Stream> {
  const r = await db.query(
    "SELECT * FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1",
    [key],
  );
  if (!r.rowCount) throw Error("Stream not found");
  return stream(r.rows[0]);
}
export async function nextPool(
  db: Client,
): Promise<(Stream & { token: string }) | null> {
  const r = await db.query(
    "SELECT s.*, p.token FROM indexer_streams s JOIN indexed_pools p ON p.chain_id=s.chain_id AND p.pool_id=s.pool_id WHERE s.chain_id=4663 AND s.kind='pool' ORDER BY s.attempted_at, s.stream_key LIMIT 1",
  );
  return r.rowCount ? { ...stream(r.rows[0]), token: r.rows[0].token } : null;
}
export async function markAttempt(db: Client, key: string) {
  await db.query(
    "UPDATE indexer_streams SET attempted_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
    [key],
  );
}
/** Preserve oldest-attempted scheduling while grouping only contiguous peers. */
export async function nextPoolGroup(
  db: Client,
  limit: number,
): Promise<(Stream & { token: string })[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw Error("Invalid pool selection limit");
  const rows = await db.query(
    `WITH seed AS (
      SELECT coalesce(s.cursor_block + 1, s.start_block) AS next_block
      FROM indexer_streams s
      JOIN indexed_pools p ON p.chain_id=s.chain_id AND p.pool_id=s.pool_id
      WHERE s.chain_id=4663 AND s.kind='pool'
      ORDER BY s.attempted_at, s.stream_key LIMIT 1
    ) SELECT s.*, p.token FROM indexer_streams s
      JOIN indexed_pools p ON p.chain_id=s.chain_id AND p.pool_id=s.pool_id
      WHERE s.chain_id=4663 AND s.kind='pool'
      AND coalesce(s.cursor_block + 1, s.start_block)=(SELECT next_block FROM seed)
      ORDER BY s.attempted_at, s.stream_key LIMIT $1`,
    [limit],
  );
  return rows.rows.map((r) => ({ ...stream(r), token: r.token }));
}
export interface PoolRecord {
  id: string;
  token: string;
  name: string;
  symbol: string;
  launchBlock: number;
  launchTx: string;
  launchSender: string;
  launchedAt: number;
  /** Creator-supplied text from verified factory logs. Never safe to hotlink. */
  imageUrl?: string;
  description?: string;
  externalUrl?: string;
}
export interface EventRecord {
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  transactionSender: string | null;
  kind: "swap" | "transfer";
  payload: unknown;
}
export interface Batch {
  from: number;
  to: number;
  hash: string;
  evidence: unknown;
  pools?: PoolRecord[];
  token?: string;
  events?: EventRecord[];
}
/** Save one batch atomically, preserving the existing replay contract. */
export async function commitBatch(
  db: Client,
  expected: Stream,
  batch: Batch,
): Promise<boolean> {
  await db.query("BEGIN");
  try {
    const changed = await commitBatchInTransaction(db, expected, batch);
    await db.query("COMMIT");
    return changed;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export function candidateStreamKey(registryRevision: string, poolId: string) {
  if (
    !/^[a-z0-9-]{1,80}$/.test(registryRevision) ||
    !/^0x[0-9a-f]{64}$/i.test(poolId)
  )
    throw Error("Invalid candidate identity");
  return `candidate:${registryRevision}:${poolId.toLowerCase()}`;
}

/** Persist one already-verified candidate's exact range, not intervening history.
 * Caller must hold the normal writer lock and freshly verify canonical evidence.
 * This database boundary does not perform chain verification or schedule rechecks.
 */
export async function commitCandidateBatch(
  db: Client,
  registryRevision: string,
  batch: Batch,
): Promise<{ changed: boolean; stream: Stream }> {
  if (
    batch.pools?.length !== 1 ||
    batch.token ||
    batch.events?.length ||
    !Number.isSafeInteger(batch.from) ||
    !Number.isSafeInteger(batch.to) ||
    batch.from < 0 ||
    batch.to < batch.from ||
    batch.to - batch.from >= 32
  )
    throw Error("Invalid candidate batch");
  const key = candidateStreamKey(registryRevision, batch.pools[0].id);
  await db.query("BEGIN");
  try {
    await db.query(
      "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block) VALUES (4663,$1,'discovery',$2) ON CONFLICT (chain_id,stream_key) DO NOTHING",
      [key, batch.from],
    );
    const current = await getStream(db, key);
    if (
      current.kind !== "discovery" ||
      current.poolId !== null ||
      current.start !== batch.from ||
      (current.cursor !== null && current.cursor !== batch.to)
    )
      throw Error("Candidate range differs from saved source");
    const changed = await commitBatchInTransaction(db, current, batch);
    const saved = await getStream(db, key);
    await db.query("COMMIT");
    return { changed, stream: saved };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Save a complete shared-range pool group in one transaction. All per-pool
 * evidence, events and contiguous cursors succeed together or none advance.
 * Discovery remains separate; this does not assert global market coverage. */
export async function commitPoolGroup(
  db: Client,
  entries: { expected: Stream; batch: Batch }[],
): Promise<boolean[]>;
export async function commitPoolGroup(
  db: Client,
  entry: BroadPoolCommit,
): Promise<boolean>;
export async function commitPoolGroup(
  db: Client,
  entries: { expected: Stream; batch: Batch }[] | BroadPoolCommit,
): Promise<boolean[] | boolean> {
  if (!Array.isArray(entries)) {
    if (entries.mode !== "broad") throw Error("Invalid pool commit group");
    const { expected, group, serialized } = snapshotBroadCommit(entries);
    await db.query("BEGIN");
    try {
      const changed = await commitBroadGroupInTransaction(
        db,
        expected,
        group,
        serialized,
      );
      await db.query("COMMIT");
      return changed;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
  const first = entries[0]?.batch;
  if (
    !first ||
    entries.length > 200 ||
    new Set(entries.map((e) => e.expected.key)).size !== entries.length ||
    entries.some(
      ({ expected, batch }) =>
        expected.kind !== "pool" ||
        !expected.poolId ||
        !batch.token ||
        (batch.pools?.length ?? 0) > 0 ||
        batch.from !== first.from ||
        batch.to !== first.to ||
        batch.hash !== first.hash,
    )
  )
    throw Error("Invalid pool commit group");
  // Deterministic lock order also covers overlapping groups. Keep the returned
  // replay flags aligned with input order, not lock order.
  const ordered = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.expected.key.localeCompare(b.expected.key));
  await db.query("BEGIN");
  try {
    const changed: boolean[] = new Array(entries.length);
    for (const { expected, batch, index } of ordered)
      changed[index] = await commitBatchInTransaction(db, expected, batch);
    await db.query("COMMIT");
    return changed;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function commitBatchInTransaction(
  db: Client,
  expected: Stream,
  batch: Batch,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(batch.from) ||
    !Number.isSafeInteger(batch.to) ||
    batch.from < 0 ||
    batch.to < batch.from ||
    !/^0x[0-9a-f]{64}$/i.test(batch.hash)
  )
    throw Error("Invalid batch boundary");
  for (const e of batch.events ?? []) {
    if (
      !Number.isSafeInteger(e.block) ||
      !Number.isSafeInteger(e.timestamp) ||
      e.timestamp < 0 ||
      !/^0x[0-9a-f]{64}$/i.test(e.txHash) ||
      !/^0x[0-9a-f]{64}$/i.test(e.blockHash) ||
      (e.transactionSender !== null &&
        !/^0x[0-9a-f]{40}$/i.test(e.transactionSender)) ||
      e.block < batch.from ||
      e.block > batch.to ||
      !Number.isSafeInteger(e.logIndex) ||
      e.logIndex < 0
    )
      throw Error("Event outside batch");
  }
  const contentHash = digest(JSON.stringify(batch));
  const locked = await db.query(
    "SELECT * FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
    [expected.key],
  );
  if (!locked.rowCount) throw Error("Stream disappeared");
  const current = stream(locked.rows[0]);
  if (current.kind === "broad")
    throw Error("Broad streams require the broad group transaction");
  const previous = await db.query(
    "SELECT from_block,block_hash,content_hash FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
    [expected.key, batch.to],
  );
  if (previous.rowCount) {
    const p = previous.rows[0];
    if (
      Number(p.from_block) !== batch.from ||
      p.block_hash !== batch.hash ||
      p.content_hash !== contentHash
    )
      throw Error("Conflicting replay");
    return false;
  }
  if (
    current.cursor !== expected.cursor ||
    current.hash !== expected.hash ||
    batch.from !==
      (current.cursor === null ? current.start : current.cursor + 1)
  )
    throw Error("Stale checkpoint or noncontiguous batch");
  if (current.kind === "discovery" && (batch.events?.length || batch.token))
    throw Error("Discovery batch has pool events");
  if (current.kind === "pool" && (batch.pools?.length || !batch.token))
    throw Error("Invalid pool batch");
  if (current.kind === "pool") {
    const identity = await db.query(
      "SELECT token FROM indexed_pools WHERE chain_id=4663 AND pool_id=$1",
      [current.poolId],
    );
    if (
      !identity.rowCount ||
      identity.rows[0].token !== batch.token?.toLowerCase()
    )
      throw Error("Pool token mismatch");
  }
  await db.query(
    "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES (4663,$1,$2,$3,$4,$5,$6)",
    [
      expected.key,
      batch.from,
      batch.to,
      batch.hash,
      contentHash,
      JSON.stringify(batch.evidence),
    ],
  );
  for (const p of batch.pools ?? []) {
    if (p.launchBlock < batch.from || p.launchBlock > batch.to)
      throw Error("Launch outside batch");
    const inserted = await db.query(
      "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch,image_url,description,external_url) VALUES (4663,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (chain_id,pool_id) DO NOTHING RETURNING pool_id",
      [
        p.id.toLowerCase(),
        p.token.toLowerCase(),
        p.name,
        p.symbol,
        p.launchBlock,
        p.launchTx.toLowerCase(),
        p.launchSender.toLowerCase(),
        p.launchedAt,
        expected.key,
        batch.to,
        p.imageUrl ?? null,
        p.description ?? null,
        p.externalUrl ?? null,
      ],
    );
    if (inserted.rowCount) {
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block) VALUES (4663,$1,'pool',$2,$3)",
        ["pool:" + p.id.toLowerCase(), p.id.toLowerCase(), p.launchBlock],
      );
    } else {
      const existing = await db.query(
        "SELECT * FROM indexed_pools WHERE chain_id=4663 AND pool_id=$1 FOR UPDATE",
        [p.id.toLowerCase()],
      );
      const identity = existing.rows[0];
      if (
        !identity ||
        identity.token !== p.token.toLowerCase() ||
        Number(identity.launch_block) !== p.launchBlock ||
        identity.launch_tx !== p.launchTx.toLowerCase() ||
        identity.launch_sender !== p.launchSender.toLowerCase() ||
        Number(identity.launched_at) !== p.launchedAt
      )
        throw Error("Conflicting launch identity");
      for (const [column, value] of [
        ["image_url", p.imageUrl],
        ["description", p.description],
        ["external_url", p.externalUrl],
      ] as const) {
        if (
          value !== undefined &&
          identity[column] !== null &&
          identity[column] !== value
        )
          throw Error("Conflicting launch metadata");
      }
      // Matching observations add provenance, never restart a pool's history.
      const history = await getStream(db, "pool:" + p.id.toLowerCase());
      if (
        history.kind !== "pool" ||
        history.poolId !== p.id.toLowerCase() ||
        history.start !== p.launchBlock
      )
        throw Error("Invalid existing pool stream");
    }
    await db.query(
      "INSERT INTO pool_launch_sources(chain_id,pool_id,stream_key,batch_end,image_url,description,external_url) VALUES (4663,$1,$2,$3,$4,$5,$6) ON CONFLICT (chain_id,pool_id,stream_key,batch_end) DO NOTHING",
      [
        p.id.toLowerCase(),
        expected.key,
        batch.to,
        p.imageUrl ?? null,
        p.description ?? null,
        p.externalUrl ?? null,
      ],
    );
  }
  // Parameterized bulk insert preserves exact amounts in JSON as decimal strings.
  const rows = (batch.events ?? []).map((e) => ({
    tx_hash: e.txHash.toLowerCase(),
    log_index: e.logIndex,
    block_number: e.block,
    block_hash: e.blockHash,
    timestamp: e.timestamp,
    kind: e.kind,
    transaction_sender: e.transactionSender?.toLowerCase() ?? null,
    payload: e.payload,
  }));
  if (rows.length)
    await db.query(
      `INSERT INTO indexed_events(chain_id,stream_key,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,kind,transaction_sender,payload)
      SELECT 4663,$1,$2,$3,$4,x.tx_hash,x.log_index,x.block_number,x.block_hash,x.timestamp,x.kind,x.transaction_sender,x.payload
      FROM jsonb_to_recordset($5::jsonb) AS x(tx_hash text,log_index integer,block_number bigint,block_hash text,timestamp bigint,kind text,transaction_sender text,payload jsonb)`,
      [
        expected.key,
        batch.to,
        current.poolId,
        batch.token,
        JSON.stringify(rows),
      ],
    );
  await db.query(
    "UPDATE indexer_streams SET cursor_block=$2,cursor_hash=$3,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
    [expected.key, batch.to, batch.hash],
  );
  return true;
}
export async function checkpoints(
  db: Client,
  key: string,
): Promise<{ to: number; hash: string }[]> {
  const r = await db.query(
    "SELECT to_block,block_hash FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 ORDER BY to_block DESC LIMIT 256",
    [key],
  );
  return r.rows.map((r) => ({ to: Number(r.to_block), hash: r.block_hash }));
}
export async function rewind(
  db: Client,
  expected: Stream,
  ancestor: number | null,
) {
  await db.query("BEGIN");
  try {
    await db.query(
      "SELECT 1 FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
      [expected.key],
    );
    const current = await getStream(db, expected.key);
    if (current.cursor !== expected.cursor || current.hash !== expected.hash)
      throw Error("Stale rewind");
    let hash: string | null = null;
    if (ancestor !== null) {
      const r = await db.query(
        "SELECT block_hash FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
        [expected.key, ancestor],
      );
      if (!r.rowCount || ancestor > (current.cursor ?? -1))
        throw Error("Unknown ancestor");
      hash = r.rows[0].block_hash;
    }
    // Launch-source removal preserves pools observed by another valid batch;
    // the database trigger deletes pool history only when its final source goes.
    await db.query(
      "DELETE FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND ($2::bigint IS NULL OR to_block>$2)",
      [expected.key, ancestor],
    );
    await db.query(
      "UPDATE indexer_streams SET cursor_block=$2,cursor_hash=$3,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
      [expected.key, ancestor, hash],
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
export async function status(db: Client) {
  const s = await db.query(
    "SELECT stream_key,kind,start_block::text,cursor_block::text,updated_at FROM indexer_streams WHERE chain_id=4663 ORDER BY stream_key LIMIT 100",
  );
  const counts = await db.query(
    "SELECT (SELECT count(*)::text FROM indexed_pools) AS pools,(SELECT count(*)::text FROM indexed_events WHERE kind='swap') AS swaps,(SELECT count(*)::text FROM indexed_events WHERE kind='transfer') AS transfers",
  );
  return { counts: counts.rows[0], streams: s.rows, streamLimit: 100 };
}
export { ensureDiscoveryV2, discoveryV2Identity } from "./discovery";
export {
  ensureBroadStream,
  broadStreamIdentity,
  broadRangeCheckpoint,
  resolveBroadPools,
  type BroadPoolCommit,
  type BroadPoolEventGroup,
  type BroadIndexedSwap,
} from "./broad";
export {
  ensureRecentStreams,
  recentStream,
  recentResumeBatchBlocks,
  observeRecentHead,
  knownRecentPools,
  commitRecentBatch,
  recentCheckpoints,
  rewindRecent,
  type RecentStream,
  type RecentBatch,
  type RecentEvent,
} from "./recent";

export { rebuildBroadMarket } from "./market-rollups";
