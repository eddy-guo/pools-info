// The crowd lane's catalog stream (docs/CROWD-LAUNCHES.md): pools.xyz crowd
// launches registered through the ordinary discovery commit, so every
// catalog reader sees them exactly as it sees an Instant launch, with the
// template auctions each range saw created kept beside the batch that saw
// them. It advances in lockstep with the crowd ledger stream, as
// launches:agg:v1 does with ledger:agg:v1.
import {
  crowdRegistryRevision,
  crowdRegistrySourceRevision,
  type CrowdAuction,
} from "@pools/chain";
import {
  commitBatchInTransaction,
  getStream,
  type Client,
  type PoolRecord,
  type Stream,
} from "./index";

export const crowdLaunchStreamIdentity = Object.freeze({
  key: "launches:crowd:v1",
  start: 23467030,
  registryRevision: crowdRegistryRevision,
  registrySourceRevision: crowdRegistrySourceRevision,
});
export async function ensureCrowdLaunchStream(db: Client): Promise<Stream> {
  const identity = crowdLaunchStreamIdentity;
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
export interface CrowdLaunchCommit {
  from: number;
  to: number;
  hash: string;
  evidence: unknown;
  pools: PoolRecord[];
  /** Template auctions created in the range. */
  auctions: readonly CrowdAuction[];
}
/** One crowd range's launches and remembered auctions, atomically. A replay
 * of the same batch is the discovery commit's no-op and adds nothing. */
export async function commitCrowdLaunchBatch(
  db: Client,
  expected: Stream,
  batch: CrowdLaunchCommit,
): Promise<boolean> {
  if (expected.key !== crowdLaunchStreamIdentity.key)
    throw Error("ledger_launch_stream_identity");
  for (const p of batch.pools)
    if (p.launchType !== "crowd") throw Error("Invalid launch type");
  for (const a of batch.auctions)
    if (a.createdBlock < batch.from || a.createdBlock > batch.to)
      throw Error("Launch outside batch");
  const { auctions, ...discovery } = batch;
  await db.query("BEGIN");
  try {
    const changed = await commitBatchInTransaction(db, expected, discovery);
    if (changed && auctions.length)
      await db.query(
        `INSERT INTO crowd_auctions(chain_id,auction,token,strategy,pool_id,created_block,created_tx,source_stream,source_batch)
         SELECT 4663,r.auction,r.token,r.strategy,r.pool_id,r.created_block,r.created_tx,$2,$3
         FROM jsonb_to_recordset($1::jsonb) AS r(auction text,token text,strategy text,pool_id text,created_block bigint,created_tx text)`,
        [
          JSON.stringify(
            auctions.map((a) => ({
              auction: a.auction,
              token: a.token,
              strategy: a.strategy,
              pool_id: a.poolId,
              created_block: a.createdBlock,
              created_tx: a.createdTx,
            })),
          ),
          expected.key,
          batch.to,
        ],
      );
    await db.query("COMMIT");
    return changed;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
/** Template auctions created before `beforeBlock` whose pool the catalog does
 * not hold yet: the migrations a crowd range may meet. */
export async function crowdPendingAuctions(
  db: Client,
  beforeBlock: number,
): Promise<{ auction: string; createdBlock: number }[]> {
  if (!Number.isSafeInteger(beforeBlock) || beforeBlock < 0)
    throw Error("ledger_invalid_registry_block");
  const r = await db.query(
    `SELECT a.auction,a.created_block FROM crowd_auctions a
     WHERE a.chain_id=4663 AND a.created_block<$1
       AND NOT EXISTS (SELECT 1 FROM indexed_pools p WHERE p.chain_id=4663 AND p.pool_id=a.pool_id)
     ORDER BY a.created_block,a.auction`,
    [beforeBlock],
  );
  return r.rows.map((row) => ({
    auction: row.auction as string,
    createdBlock: Number(row.created_block),
  }));
}
