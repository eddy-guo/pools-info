import type { Client } from "./index";
import { ledgerLaunchStreamIdentity } from "./ledger";

/** One launch log as the launch stream retains it in its batch evidence
 * (`LedgerLaunchEvidence.logs`): enough to name the pool, the strategy that
 * emitted the launch and the transaction the catalog row records. */
export interface RetainedLaunchLog {
  address: string;
  topic0: string;
  topic1: string;
  transactionHash: string;
  blockNumber: number;
}
export interface CreatorFeeRow {
  poolId: string;
  launchTx: string;
  launchBlock: number;
  creatorFees: boolean;
}
export interface UnresolvedCreatorFeeBatch {
  batchEnd: number;
  pools: number;
}

const word = (v: unknown) => typeof v === "string" && /^0x[\da-f]{64}$/.test(v);
const address = (v: unknown) =>
  typeof v === "string" && /^0x[\da-f]{40}$/.test(v);

/** Catalog pools whose creator-fee flag is unknown, and how many of them have
 * no deep publication to fall back on (the pools whose page shows the flag
 * as unavailable). */
export async function creatorFeeCoverage(db: Client) {
  const row = (
    await db.query(
      `SELECT count(*)::int AS pools,
              count(creator_fees)::int AS known,
              count(*) FILTER (WHERE creator_fees IS NULL
                AND NOT EXISTS(SELECT 1 FROM analytics_pool_snapshots a
                  WHERE a.chain_id=p.chain_id AND a.pool_id=p.pool_id))::int AS unpublished
         FROM indexed_pools p WHERE chain_id=4663`,
    )
  ).rows[0];
  return {
    pools: row.pools as number,
    known: row.known as number,
    unknown: (row.pools - row.known) as number,
    unknownUnpublished: row.unpublished as number,
  };
}

/** The launch-stream batches whose retained logs can fill an unknown flag,
 * oldest first, with the count of such pools in each; a pool counts under
 * its oldest retained source only. `scope` "unpublished" names only pools
 * with no deep publication; "all" every unknown flag. A pool whose launch
 * reached the catalog through another source only is left out: it has no
 * retained log to derive from. */
export async function unresolvedCreatorFeeBatches(
  db: Client,
  scope: "unpublished" | "all",
): Promise<UnresolvedCreatorFeeBatch[]> {
  const rows = (
    await db.query(
      `SELECT batch_end::text AS batch_end, count(*)::int AS pools FROM (
         SELECT p.pool_id, min(s.batch_end) AS batch_end
           FROM indexed_pools p
           JOIN pool_launch_sources s ON s.chain_id=p.chain_id AND s.pool_id=p.pool_id AND s.stream_key=$1
          WHERE p.chain_id=4663 AND p.creator_fees IS NULL
            AND ($2 OR NOT EXISTS(SELECT 1 FROM analytics_pool_snapshots a
              WHERE a.chain_id=p.chain_id AND a.pool_id=p.pool_id))
          GROUP BY p.pool_id) x
        GROUP BY batch_end ORDER BY batch_end`,
      [ledgerLaunchStreamIdentity.key, scope === "all"],
    )
  ).rows;
  return rows.map((r) => ({ batchEnd: Number(r.batch_end), pools: r.pools }));
}

/** The launch logs one launch-stream batch retains, read as the only part of
 * its evidence this needs. Every row is checked to the shape the lane wrote,
 * so a malformed log stops the run instead of resolving to nothing. */
export async function retainedLaunchLogs(
  db: Client,
  batchEnd: number,
): Promise<RetainedLaunchLog[]> {
  if (!Number.isSafeInteger(batchEnd) || batchEnd < 0)
    throw Error("Invalid launch batch");
  const rows = (
    await db.query(
      "SELECT evidence->'logs' AS logs FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
      [ledgerLaunchStreamIdentity.key, batchEnd],
    )
  ).rows;
  if (!rows.length) throw Error("Launch batch not found");
  const logs = rows[0].logs;
  if (!Array.isArray(logs)) throw Error("Launch batch retains no logs");
  return logs.map((l) => {
    const log = {
      address: String(l?.address ?? "").toLowerCase(),
      topic0: String(l?.topic0 ?? "").toLowerCase(),
      topic1: String(l?.topic1 ?? "").toLowerCase(),
      transactionHash: String(l?.transaction_hash ?? "").toLowerCase(),
      blockNumber: l?.block_number,
    };
    if (
      !address(log.address) ||
      !word(log.topic0) ||
      !word(log.topic1) ||
      !word(log.transactionHash) ||
      !Number.isSafeInteger(log.blockNumber) ||
      log.blockNumber < 0
    )
      throw Error("Malformed retained launch log");
    return log as RetainedLaunchLog;
  });
}

/** Stores each flag on the pool whose recorded launch the log names: the
 * pool id, transaction and block must all match the catalog row, and a flag
 * already stored is never replaced. Returns the pools filled. */
export async function saveCreatorFees(
  db: Client,
  rows: readonly CreatorFeeRow[],
): Promise<number> {
  if (rows.length > 10000) throw Error("Invalid creator fee rows");
  for (const r of rows)
    if (
      !word(r.poolId) ||
      !word(r.launchTx) ||
      !Number.isSafeInteger(r.launchBlock) ||
      r.launchBlock < 0 ||
      typeof r.creatorFees !== "boolean"
    )
      throw Error("Invalid creator fee rows");
  if (!rows.length) return 0;
  const result = await db.query(
    `UPDATE indexed_pools p SET creator_fees=x.creator_fees
       FROM jsonb_to_recordset($1::jsonb) AS x(pool_id text, launch_tx text, launch_block bigint, creator_fees boolean)
      WHERE p.chain_id=4663 AND p.pool_id=x.pool_id AND p.launch_tx=x.launch_tx
        AND p.launch_block=x.launch_block AND p.creator_fees IS NULL`,
    [
      JSON.stringify(
        rows.map((r) => ({
          pool_id: r.poolId,
          launch_tx: r.launchTx,
          launch_block: r.launchBlock,
          creator_fees: r.creatorFees,
        })),
      ),
    ],
  );
  return result.rowCount ?? 0;
}
