import {
  buildAnalyticsModel,
  type AnalyticsModel,
  type AnalyticsPublication,
  type CatalogPool,
} from "@pools/core";
import { assertCatalogIdentity, catalogCte } from "./catalog-read";
import { RequestError } from "./request";
type Query = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, any>[] }>;

/** On-demand detail reads one pool evidence capture. Global coverage is a SQL
 * summary; no global snapshots are materialized by this API. */
export async function loadAnalyticsModel(
  query: Query,
  poolId: string,
): Promise<AnalyticsModel> {
  await assertCatalogIdentity(query);
  const catalogCount = await query(
    `${catalogCte} SELECT count(*)::text AS count FROM catalog`,
  );
  const savedCount = await query(
    `SELECT count(*)::text AS count,coalesce(sum(octet_length(snapshot::text)+coalesce(octet_length(holders::text),0)),0)::text AS bytes FROM analytics_pool_snapshots WHERE chain_id=4663 AND pool_id=$1`,
    [poolId],
  );
  if (
    Number(savedCount.rows[0].count) > 1 ||
    Number(savedCount.rows[0].bytes) > 32 * 1024 * 1024
  )
    throw new RequestError(503, "analytics_materialization_limit");
  const pools = await query(
    `SELECT p.pool_id,p.token,p.name,p.symbol,p.launch_block,p.launch_tx,p.launch_sender,p.launched_at FROM indexed_pools p JOIN analytics_pool_snapshots a USING(chain_id,pool_id) WHERE p.chain_id=4663 AND p.pool_id=$1 ORDER BY p.pool_id`,
    [poolId],
  );
  const saved = await query(
    `SELECT pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,holders,liquidity_wei,source_kind FROM analytics_pool_snapshots WHERE chain_id=4663 AND pool_id=$1 ORDER BY pool_id`,
    [poolId],
  );
  const catalog: CatalogPool[] = pools.rows.map((r) => ({
    id: r.pool_id,
    token: r.token,
    name: r.name,
    symbol: r.symbol,
    launchBlock: Number(r.launch_block),
    launchTx: r.launch_tx,
    launchSender: r.launch_sender,
    launchedAt: Number(r.launched_at),
  }));
  const publications: AnalyticsPublication[] = saved.rows.map((r) => {
    if (
      r.snapshot.markets?.[0]?.id !== r.pool_id ||
      r.snapshot.toBlock !== Number(r.through_block) ||
      r.snapshot.blockHash !== r.through_hash ||
      r.snapshot.toTimestamp !== Number(r.asof_timestamp)
    )
      throw new RequestError(503, "analytics_capture_mismatch");
    return {
      snapshot: r.snapshot,
      holders: r.holders,
      liquidityWei: r.liquidity_wei,
      sourceKind: r.source_kind,
      generatedAt: new Date(r.generated_at).toISOString(),
    };
  });
  const model = buildAnalyticsModel(catalog, publications);
  model.coverage.catalogPools = Number(catalogCount.rows[0].count);
  if (poolId) {
    const global = (
      await query(
        "SELECT count(*)::text AS count,coalesce(max(asof_timestamp),0)::text AS asof,min(asof_timestamp)::text AS oldest FROM analytics_pool_snapshots WHERE chain_id=4663",
      )
    ).rows[0];
    model.coverage.processedPools = Number(global.count);
    model.coverage.asOf = Number(global.asof);
    model.coverage.oldestAsOf =
      global.oldest === null ? null : Number(global.oldest);
  }
  return model;
}
