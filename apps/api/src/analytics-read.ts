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

/** This pilot loads the full published corpus so global ranking happens before
 * pagination. Fail clearly above the limit instead of silently ranking a sample. */
export async function loadAnalyticsModel(
  query: Query,
): Promise<AnalyticsModel> {
  await assertCatalogIdentity(query);
  const catalogCount = await query(
    `${catalogCte} SELECT count(*)::text AS count FROM catalog`,
  );
  const savedCount = await query(
    "SELECT count(*)::text AS count,coalesce(sum(octet_length(snapshot::text)+coalesce(octet_length(holders::text),0)),0)::text AS bytes FROM analytics_pool_snapshots WHERE chain_id=4663",
  );
  if (
    Number(catalogCount.rows[0].count) > 10000 ||
    Number(savedCount.rows[0].count) > 500 ||
    Number(savedCount.rows[0].bytes) > 32 * 1024 * 1024
  )
    throw new RequestError(503, "analytics_materialization_limit");
  const pools = await query(
    `${catalogCte} SELECT pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at FROM catalog ORDER BY pool_id`,
  );
  const saved = await query(
    "SELECT pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,holders,liquidity_wei,source_kind FROM analytics_pool_snapshots WHERE chain_id=4663 ORDER BY pool_id",
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
  return buildAnalyticsModel(catalog, publications);
}
