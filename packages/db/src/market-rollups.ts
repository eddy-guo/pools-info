import type { Client } from "./index";

/** Bounded historical rebuild. No RPC/evidence deletion. Completion markers are
 * the durable derived cursor: serving stops before the first missing marker,
 * even if new commits have already projected a later suffix. Caller owns the
 * normal writer lock. Each invocation is an atomic, bounded transaction. */
export async function rebuildBroadMarket(db: Client, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error("Invalid market rebuild limit");
  await db.query("BEGIN");
  try {
    // Same discovery-before-broad lock order as canonical commits/rewinds.
    await db.query(
      "SELECT 1 FROM indexer_streams WHERE chain_id=4663 AND stream_key='discovery:v2' FOR UPDATE",
    );
    await db.query(
      "SELECT 1 FROM indexer_streams WHERE chain_id=4663 AND stream_key='swaps:broad:v1' FOR UPDATE",
    );
    const rows = (
      await db.query(
        `SELECT b.batch_end::text FROM broad_batches b
      LEFT JOIN broad_market_batches m USING(chain_id,stream_key,batch_end)
      WHERE b.chain_id=4663 AND m.batch_end IS NULL ORDER BY b.batch_end LIMIT $1`,
        [limit],
      )
    ).rows;
    for (const row of rows)
      await db.query("SELECT project_broad_market($1)", [row.batch_end]);
    const remaining = (
      await db.query(`SELECT count(*)::text AS count FROM broad_batches b
      LEFT JOIN broad_market_batches m USING(chain_id,stream_key,batch_end) WHERE b.chain_id=4663 AND m.batch_end IS NULL`)
    ).rows[0].count;
    await db.query("COMMIT");
    return { rebuilt: rows.length, remaining: Number(remaining) };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
