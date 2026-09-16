import { createHash } from "node:crypto";
import {
  hypersyncRecentStream,
  isHyperSyncRecentEvidence,
  verifyHyperSyncRecentLaunches,
  verifyHyperSyncRecentSwaps,
  type HyperSyncRecentLaunchEvidence,
  type HyperSyncRecentSwapEvidence,
} from "@pools/chain";
import type { Client, PoolRecord } from "./index";
export interface RecentStream {
  key: "discovery" | "swaps";
  start: number;
  cursor: number | null;
  hash: string | null;
  timestamp: number | null;
}
export interface RecentEvent {
  poolId: string;
  token: string;
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  transactionSender: string;
  amount0: string;
  amount1: string;
  ethWei: string;
  tokenRaw: string;
  side: "buy" | "sell";
}
/** Evidence provenance of a recent batch (migration 016). The JSON-RPC
 * collector retains logs, receipts and headers; the HyperSync collector
 * retains logs, transactions and blocks. Same rows, same stream. */
export const recentBatchSources = Object.freeze({
  rpc: "recent:rpc:v1",
  hypersync: hypersyncRecentStream,
} as const);
export type RecentBatchSource =
  (typeof recentBatchSources)[keyof typeof recentBatchSources];
export interface RecentBatch {
  from: number;
  to: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  evidence: unknown;
  /** Omitted means the JSON-RPC collector, as for every batch before 016. */
  source?: RecentBatchSource;
  pools?: PoolRecord[];
  events?: RecentEvent[];
  observedSwaps?: number;
  unregisteredSwaps?: number;
  unsupportedSwaps?: number;
}
const hash = (v: string) => /^0x[\da-f]{64}$/.test(v),
  address = (v: string) => /^0x[\da-f]{40}$/.test(v),
  integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const sameIdentity = (a: PoolRecord, b: PoolRecord) =>
  a.token.toLowerCase() === b.token.toLowerCase() &&
  a.launchTx.toLowerCase() === b.launchTx.toLowerCase() &&
  a.launchBlock === b.launchBlock &&
  a.launchSender.toLowerCase() === b.launchSender.toLowerCase() &&
  a.launchedAt === b.launchedAt;
function rowStream(r: Record<string, unknown>): RecentStream {
  return {
    key: r.stream_key as RecentStream["key"],
    start: Number(r.start_block),
    cursor: r.cursor_block === null ? null : Number(r.cursor_block),
    hash: r.cursor_hash as string | null,
    timestamp: r.cursor_timestamp === null ? null : Number(r.cursor_timestamp),
  };
}
export async function recentStream(
  db: Client,
  key: RecentStream["key"],
): Promise<RecentStream> {
  const r = await db.query(
    "SELECT * FROM recent_streams WHERE chain_id=4663 AND stream_key=$1",
    [key],
  );
  if (!r.rowCount) throw Error("Recent stream missing");
  return rowStream(r.rows[0]);
}
export async function ensureRecentStreams(db: Client, start: number) {
  if (!integer(start)) throw Error("Invalid recent start");
  await db.query("BEGIN");
  try {
    const prior = (
      await db.query(
        "SELECT * FROM recent_streams WHERE chain_id=4663 ORDER BY stream_key FOR UPDATE",
      )
    ).rows;
    if (prior.length !== 0 && prior.length !== 2)
      throw Error("Inconsistent recent streams");
    if (!prior.length)
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block) VALUES(4663,'discovery',$1),(4663,'swaps',$1)",
        [start],
      );
    else if (prior[0].start_block !== prior[1].start_block)
      throw Error("Inconsistent recent streams");
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
/** A restart sizing hint only. Normal canonical reconciliation still runs. */
export async function recentResumeBatchBlocks(
  db: Client,
  configuredMax: number,
) {
  if (
    !Number.isSafeInteger(configuredMax) ||
    configuredMax < 1 ||
    configuredMax > 2000
  )
    throw Error("Invalid recent batch maximum");
  const result = await db.query(
    `SELECT (b.to_block-b.from_block+1)::text AS width
     FROM recent_streams s JOIN recent_batches b
       ON b.chain_id=s.chain_id AND b.stream_key=s.stream_key
       AND b.to_block=s.cursor_block AND b.block_hash=s.cursor_hash
     WHERE s.chain_id=4663 AND s.stream_key='swaps'`,
  );
  const width = Number(result.rows[0]?.width);
  if (!Number.isSafeInteger(width) || width < 1 || width > 2000)
    return configuredMax;
  return Math.min(configuredMax, Math.max(10, width));
}
export async function observeRecentHead(
  db: Client,
  head: number,
  timestamp: number,
) {
  if (!integer(head) || !integer(timestamp)) throw Error("Invalid recent head");
  await db.query(
    "UPDATE recent_streams SET head_block=$1,head_timestamp=$2,checked_at=clock_timestamp() WHERE chain_id=4663",
    [head, timestamp],
  );
}
export async function knownRecentPools(
  db: Client,
  poolIds?: readonly string[],
): Promise<PoolRecord[]> {
  const ids = poolIds && [...new Set(poolIds.map((id) => id.toLowerCase()))];
  if (ids && (ids.length > 10000 || ids.some((id) => !hash(id))))
    throw Error("Invalid recent registry selection");
  if (ids?.length === 0) return [];
  // Production callers select only markets observed in this bounded block
  // batch. Total catalog size must not limit live ingestion or its memory use.
  const selected = ids ? " AND pool_id=ANY($1::text[])" : "";
  const rows = (
    await db.query(
      `SELECT pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,image_url,description,external_url FROM indexed_pools WHERE chain_id=4663${selected}
    UNION ALL SELECT pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,image_url,description,external_url FROM recent_pools WHERE chain_id=4663${selected} LIMIT 20001`,
      ids ? [ids] : [],
    )
  ).rows;
  if (rows.length > 20000) throw Error("Recent registry exceeds budget");
  const pools = new Map<string, PoolRecord>();
  for (const r of rows) {
    const p: PoolRecord = {
      id: r.pool_id,
      token: r.token,
      name: r.name,
      symbol: r.symbol,
      launchBlock: Number(r.launch_block),
      launchTx: r.launch_tx,
      launchSender: r.launch_sender,
      launchedAt: Number(r.launched_at),
      ...(r.image_url === null ? {} : { imageUrl: r.image_url }),
      ...(r.description === null ? {} : { description: r.description }),
      ...(r.external_url === null ? {} : { externalUrl: r.external_url }),
    };
    if (pools.has(p.id) && !sameIdentity(pools.get(p.id)!, p))
      throw Error("Conflicting recent pool identity");
    const existing = pools.get(p.id);
    // Prefer historical claims when available; a matching recent observation
    // can fill fields a legacy collector did not retain.
    pools.set(p.id, existing ? { ...p, ...existing } : p);
  }
  if (pools.size > 10000) throw Error("Recent registry exceeds budget");
  return [...pools.values()];
}
export async function commitRecentBatch(
  db: Client,
  expected: RecentStream,
  b: RecentBatch,
) {
  if (
    !integer(b.from) ||
    !integer(b.to) ||
    b.to < b.from ||
    b.to - b.from >= 2000 ||
    !hash(b.hash) ||
    !hash(b.parentHash) ||
    !integer(b.timestamp) ||
    (b.events?.length ?? 0) > 10000 ||
    (b.pools?.length ?? 0) > 250 ||
    [
      b.observedSwaps ?? 0,
      b.unregisteredSwaps ?? 0,
      b.unsupportedSwaps ?? 0,
    ].some((n) => !integer(n)) ||
    (b.source !== undefined &&
      !Object.values(recentBatchSources).includes(b.source))
  )
    throw Error("Invalid recent batch");
  if (
    (expected.key === "discovery" && b.events?.length) ||
    (expected.key === "swaps" && b.pools?.length)
  )
    throw Error("Invalid recent batch kind");
  // The label and the evidence variant must agree; a HyperSync batch is then
  // re-derived from its retained rows before anything is written.
  const hypersync = b.source === recentBatchSources.hypersync;
  if (hypersync !== isHyperSyncRecentEvidence(b.evidence))
    throw Error("Invalid recent batch");
  if (hypersync && expected.key === "discovery")
    verifyHyperSyncRecentLaunches({
      fromBlock: b.from,
      toBlock: b.to,
      blockHash: b.hash,
      fromBlockParentHash: b.parentHash,
      toTimestamp: b.timestamp,
      pools: b.pools ?? [],
      evidence: b.evidence as HyperSyncRecentLaunchEvidence,
    });
  // ABI decoders can return checksummed addresses. Persist a canonical identity
  // just like the historical writer, without altering the original evidence.
  if (b.pools)
    b = {
      ...b,
      pools: b.pools.map((p) => ({
        ...p,
        id: p.id.toLowerCase(),
        token: p.token.toLowerCase(),
        launchTx: p.launchTx.toLowerCase(),
        launchSender: p.launchSender.toLowerCase(),
      })),
    };
  for (const e of b.events ?? [])
    if (
      !hash(e.poolId) ||
      !address(e.token) ||
      !hash(e.txHash) ||
      !hash(e.blockHash) ||
      !address(e.transactionSender) ||
      !integer(e.logIndex) ||
      !integer(e.block) ||
      e.block < b.from ||
      e.block > b.to ||
      !integer(e.timestamp) ||
      e.timestamp > b.timestamp ||
      !/^-?\d+$/.test(e.amount0) ||
      !/^-?\d+$/.test(e.amount1) ||
      !/^[1-9]\d*$/.test(e.ethWei) ||
      !/^[1-9]\d*$/.test(e.tokenRaw) ||
      BigInt(e.ethWei) >= 1n << 256n ||
      BigInt(e.tokenRaw) >= 1n << 256n ||
      BigInt(e.ethWei) !==
        (e.side === "buy" ? -BigInt(e.amount0) : BigInt(e.amount0)) ||
      BigInt(e.tokenRaw) !==
        (e.side === "buy" ? BigInt(e.amount1) : -BigInt(e.amount1)) ||
      !["buy", "sell"].includes(e.side)
    )
      throw Error("Invalid recent event");
  const body = JSON.stringify(b);
  if (Buffer.byteLength(body) > 16 * 1024 * 1024)
    throw Error("Recent evidence exceeds budget");
  const checksum = createHash("sha256").update(body).digest("hex");
  await db.query("BEGIN");
  try {
    const row = (
      await db.query(
        "SELECT * FROM recent_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
        [expected.key],
      )
    ).rows[0];
    if (!row) throw Error("Recent stream missing");
    const s = rowStream(row);
    const prior = (
      await db.query(
        "SELECT content_hash FROM recent_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
        [s.key, b.to],
      )
    ).rows[0];
    if (prior) {
      if (prior.content_hash !== checksum)
        throw Error("Conflicting recent replay");
      await db.query("COMMIT");
      return false;
    }
    if (
      s.cursor !== expected.cursor ||
      s.hash !== expected.hash ||
      b.from !== (s.cursor === null ? s.start : s.cursor + 1) ||
      (s.hash !== null && b.parentHash !== s.hash)
    )
      throw Error("Noncontiguous recent checkpoint");
    if (s.key === "swaps") {
      const d = await recentStream(db, "discovery");
      if (d.cursor === null || b.to > d.cursor)
        throw Error("Recent swaps exceed discovery coverage");
    }
    const known = new Map(
      (
        await knownRecentPools(db, [
          ...(b.pools ?? []).map((p) => p.id),
          ...(b.events ?? []).map((e) => e.poolId),
        ])
      ).map((p) => [p.id, p]),
    );
    for (const p of b.pools ?? []) {
      if (
        !hash(p.id) ||
        !address(p.token) ||
        !hash(p.launchTx) ||
        !address(p.launchSender) ||
        !integer(p.launchBlock) ||
        p.launchBlock < b.from ||
        p.launchBlock > b.to ||
        !integer(p.launchedAt) ||
        p.launchedAt > b.timestamp
      )
        throw Error("Invalid recent launch");
      if (known.has(p.id) && !sameIdentity(known.get(p.id)!, p))
        throw Error("Conflicting recent pool identity");
      known.set(p.id, p);
    }
    for (const e of b.events ?? []) {
      const p = known.get(e.poolId);
      if (!p || p.token !== e.token || p.launchBlock > e.block)
        throw Error("Unregistered recent pool");
    }
    if (hypersync && s.key === "swaps") {
      // Resolve every observed id, registered and unregistered alike, against
      // the registry this transaction sees: a registered pool counted as
      // unregistered, or a row the retained logs do not support, is refused.
      const evidence = b.evidence as HyperSyncRecentSwapEvidence;
      const observed = [
        ...new Set([
          ...(Array.isArray(evidence.logs) ? evidence.logs : []).map((l) =>
            String(l.topic1).toLowerCase(),
          ),
          ...(Array.isArray(evidence.unregistered?.poolIds)
            ? evidence.unregistered.poolIds
            : []),
        ]),
      ];
      if (observed.some((id) => !hash(id))) throw Error("Invalid recent batch");
      verifyHyperSyncRecentSwaps(
        {
          fromBlock: b.from,
          toBlock: b.to,
          blockHash: b.hash,
          fromBlockParentHash: b.parentHash,
          toTimestamp: b.timestamp,
          events: b.events ?? [],
          observedSwaps: b.observedSwaps ?? 0,
          unregisteredSwaps: b.unregisteredSwaps ?? 0,
          unsupportedSwaps: b.unsupportedSwaps ?? 0,
          evidence,
        },
        await knownRecentPools(db, observed),
      );
    }
    await db.query(
      `INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence,observed_swaps,unregistered_swaps,unsupported_swaps,source)
      VALUES(4663,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        s.key,
        b.from,
        b.to,
        b.hash,
        b.timestamp,
        checksum,
        JSON.stringify(b.evidence),
        b.observedSwaps ?? 0,
        b.unregisteredSwaps ?? 0,
        b.unsupportedSwaps ?? 0,
        b.source ?? recentBatchSources.rpc,
      ],
    );
    for (const p of b.pools ?? [])
      await db.query(
        `INSERT INTO recent_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch,image_url,description,external_url)
      VALUES(4663,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(chain_id,pool_id) DO NOTHING`,
        [
          p.id,
          p.token,
          p.name,
          p.symbol,
          p.launchBlock,
          p.launchTx,
          p.launchSender,
          p.launchedAt,
          b.to,
          p.imageUrl ?? null,
          p.description ?? null,
          p.externalUrl ?? null,
        ],
      );
    if (b.events?.length)
      await db.query(
        `INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
      SELECT 4663,$1,x."poolId",x.token,x."txHash",x."logIndex",x.block,x."blockHash",x.timestamp,x."transactionSender",x.amount0,x.amount1,x."ethWei",x."tokenRaw",x.side
      FROM jsonb_to_recordset($2::jsonb) AS x("poolId" text,token text,"txHash" text,"logIndex" integer,block bigint,"blockHash" text,timestamp bigint,"transactionSender" text,amount0 text,amount1 text,"ethWei" text,"tokenRaw" text,side text)`,
        [b.to, JSON.stringify(b.events)],
      );
    await db.query(
      "UPDATE recent_streams SET cursor_block=$2,cursor_hash=$3,cursor_timestamp=$4,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
      [s.key, b.to, b.hash, b.timestamp],
    );
    await db.query("COMMIT");
    return true;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
export async function recentCheckpoints(db: Client, key: RecentStream["key"]) {
  const r = await db.query(
    "SELECT to_block,block_hash FROM recent_batches WHERE chain_id=4663 AND stream_key=$1 ORDER BY to_block DESC LIMIT 256",
    [key],
  );
  return r.rows.map((b) => ({
    to: Number(b.to_block),
    hash: String(b.block_hash),
  }));
}
async function rewindOne(
  db: Client,
  key: RecentStream["key"],
  ancestor: number | null,
) {
  let batch: null | { block_hash: string; to_timestamp: string } = null;
  if (ancestor !== null) {
    batch = (
      await db.query(
        "SELECT block_hash,to_timestamp FROM recent_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
        [key, ancestor],
      )
    ).rows[0];
    if (!batch) throw Error("Unknown recent ancestor");
  }
  await db.query(
    "DELETE FROM recent_batches WHERE chain_id=4663 AND stream_key=$1 AND ($2::bigint IS NULL OR to_block>$2)",
    [key, ancestor],
  );
  await db.query(
    "UPDATE recent_streams SET cursor_block=$2,cursor_hash=$3,cursor_timestamp=$4,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
    [key, ancestor, batch?.block_hash ?? null, batch?.to_timestamp ?? null],
  );
}
export async function rewindRecent(
  db: Client,
  expected: RecentStream,
  ancestor: number | null,
) {
  if (
    ancestor !== null &&
    (!integer(ancestor) ||
      expected.cursor === null ||
      ancestor > expected.cursor)
  )
    throw Error("Unknown recent ancestor");
  await db.query("BEGIN");
  try {
    // Lock in one stable order when discovery invalidates both lanes.
    await db.query(
      "SELECT stream_key FROM recent_streams WHERE chain_id=4663 ORDER BY stream_key FOR UPDATE",
    );
    const current = await recentStream(db, expected.key);
    if (current.cursor !== expected.cursor || current.hash !== expected.hash)
      throw Error("Stale recent rewind");
    if (expected.key === "discovery") {
      const swaps = await recentStream(db, "swaps");
      if (
        swaps.cursor !== null &&
        (ancestor === null || swaps.cursor > ancestor)
      ) {
        const prior =
          ancestor === null
            ? null
            : (
                await db.query(
                  "SELECT max(to_block)::text AS n FROM recent_batches WHERE chain_id=4663 AND stream_key='swaps' AND to_block<=$1",
                  [ancestor],
                )
              ).rows[0].n;
        await rewindOne(db, "swaps", prior === null ? null : Number(prior));
      }
    }
    await rewindOne(db, expected.key, ancestor);
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
