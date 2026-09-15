import type { CatalogPool } from "@pools/core";
import { catalogCte, type ReadQuery } from "./catalog-read";
export function catalogPool(r: Record<string, any>): CatalogPool {
  return {
    id: r.pool_id,
    token: r.token,
    name: r.name,
    symbol: r.symbol,
    launchBlock: Number(r.launch_block),
    launchTx: r.launch_tx,
    launchSender: r.launch_sender,
    launchedAt: Number(r.launched_at),
  };
}
export async function catalogSummary(query: ReadQuery) {
  const { rows } = await query(
    `${catalogCte} SELECT count(*)::text AS count,coalesce(min(launch_block),0)::text AS first_block,coalesce(max(launch_block),0)::text AS last_block FROM catalog`,
  );
  return {
    count: Number(rows[0].count),
    firstBlock: Number(rows[0].first_block),
    lastBlock: Number(rows[0].last_block),
  };
}
