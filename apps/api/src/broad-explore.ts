import type { LiveWindow, MarketBoundary } from "@pools/core";
import { catalogCte, type ReadQuery } from "./catalog-read";
import { RequestError } from "./request";

export interface BroadExploreCut extends MarketBoundary {
  startBlock: number;
  discoveryBatch: number;
  indexedAt: string;
  rebuildPending: boolean;
}
/** A projection cannot outrun the first missing historical batch. Reader owns
 * one repeatable-read snapshot across cutoff, totals and deterministic page. */
export async function broadExploreCut(
  query: ReadQuery,
): Promise<BroadExploreCut | null> {
  const { rows } = await query(`WITH gap AS (
    SELECT min(b.batch_end) AS missing FROM broad_batches b
    LEFT JOIN broad_market_batches m USING(chain_id,stream_key,batch_end)
    WHERE b.chain_id=4663 AND m.batch_end IS NULL
  ) SELECT s.start_block,s.cursor_block,s.cursor_hash,b.batch_end,b.timestamp,b.discovery_batch,
    i.block_hash,i.collected_at,d.block_hash AS discovery_hash,d.content_hash AS discovery_content_hash,
    b.discovery_hash AS pinned_hash,b.discovery_content_hash AS pinned_content_hash,gap.missing,
    EXISTS(SELECT 1 FROM broad_batches old
      JOIN indexer_batches dependency ON dependency.chain_id=old.chain_id AND dependency.stream_key=old.discovery_stream AND dependency.to_block=old.discovery_batch
      WHERE old.chain_id=4663 AND old.batch_end<=b.batch_end AND
        (old.discovery_hash<>dependency.block_hash OR old.discovery_content_hash<>dependency.content_hash)) AS invalid_dependency,
    EXISTS(SELECT 1 FROM broad_market_conflicts c WHERE c.chain_id=4663 AND c.batch_end<=b.batch_end) OR
    EXISTS(SELECT 1 FROM broad_market_recent_conflicts c WHERE c.chain_id=4663 AND c.batch_end<=b.batch_end) OR
    EXISTS(SELECT 1 FROM analytics_accounting_pools a WHERE a.chain_id=4663 AND a.through_block=b.batch_end
      AND (a.through_hash<>i.block_hash OR a.asof_timestamp<>b.timestamp)) AS conflict
  FROM indexer_streams s CROSS JOIN gap
  JOIN LATERAL(SELECT b.* FROM broad_batches b JOIN broad_market_batches m USING(chain_id,stream_key,batch_end)
    WHERE b.chain_id=s.chain_id AND b.stream_key=s.stream_key AND b.batch_end<=s.cursor_block
      AND (gap.missing IS NULL OR b.batch_end<gap.missing) ORDER BY b.batch_end DESC LIMIT 1)b ON true
  JOIN indexer_batches i ON i.chain_id=b.chain_id AND i.stream_key=b.stream_key AND i.to_block=b.batch_end
  JOIN indexer_batches d ON d.chain_id=b.chain_id AND d.stream_key=b.discovery_stream AND d.to_block=b.discovery_batch
  WHERE s.chain_id=4663 AND s.stream_key='swaps:broad:v1'`);
  const r = rows[0];
  if (!r) return null;
  if (r.conflict) throw new RequestError(503, "market_identity_conflict");
  if (
    r.invalid_dependency ||
    r.discovery_hash !== r.pinned_hash ||
    r.discovery_content_hash !== r.pinned_content_hash ||
    (Number(r.batch_end) === Number(r.cursor_block) &&
      r.block_hash !== r.cursor_hash)
  )
    throw new RequestError(503, "market_evidence_invalid");
  return {
    block: Number(r.batch_end),
    hash: r.block_hash,
    asOf: Number(r.timestamp),
    startBlock: Number(r.start_block),
    discoveryBatch: Number(r.discovery_batch),
    indexedAt: new Date(r.collected_at).toISOString(),
    rebuildPending: r.missing !== null,
  };
}
export function broadWindowStart(
  cut: BroadExploreCut | null,
  window: LiveWindow,
) {
  const seconds = {
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
    All: Infinity,
  };
  return cut ? Math.max(0, cut.asOf - seconds[window]) : 0;
}
// Parameters $1 remains deep publication window, $2-$6 hold broad cutoff,
// window start, stream start, pinned discovery checkpoint and dated timestamp.
// Only derived buckets and scalar dated units participate in global serving.
// The launches a canonical broad batch covers: launched inside the stream's
// range and pinned by the discovery checkpoint the batch depends on.
export const broadCoverageSql = (alias: string) =>
  `${alias}launch_block BETWEEN $4 AND $2 AND EXISTS(SELECT 1 FROM pool_launch_sources ps
    WHERE ps.chain_id=4663 AND ps.pool_id=${alias}pool_id AND ps.stream_key='discovery:v2' AND ps.batch_end<=$5)`;
// Window totals per pool from complete batch summaries plus intersecting edge
// buckets: over the whole catalog when a sort ranks on them, or over the page.
export function broadFlowCte(source: "catalog" | "page") {
  const scope = (alias: string) =>
    source === "page"
      ? ` AND ${alias}pool_id IN (SELECT pool_id FROM page)`
      : "";
  return `, broad_flow AS (
  SELECT pool_id,sum(trades) AS trades,sum(unsupported) AS unsupported,sum(volume_wei) AS volume
    FROM (
      SELECT pool_id,trades,unsupported,volume_wei FROM broad_market_summaries
        WHERE chain_id=4663 AND batch_end<=$2 AND first_timestamp >= $3 AND last_timestamp <= $6${scope("")}
      UNION ALL
      SELECT k.pool_id,k.trades,k.unsupported,k.volume_wei FROM broad_market_buckets k
        JOIN broad_market_summaries s USING(chain_id,stream_key,batch_end,pool_id)
        WHERE k.chain_id=4663 AND k.batch_end<=$2 AND k.timestamp >= $3 AND k.timestamp <= $6
          AND (s.first_timestamp<$3 OR s.last_timestamp>$6)${scope("k.")}
    ) inputs GROUP BY pool_id
)`;
}
// Every launch's served trades and volume on the cheap flow columns: broad
// flow where the canonical broad cutoff covers the launch and no deep
// publication is newer, else deep flow, else null where no source proves the
// metric. This is the whole-catalog rank for explore's trades and volume
// sorts and the per-launch input of the creators aggregate, so both serve
// one rule. `where` filters the catalog rows; $1-$6 bind as above. The CTE is
// materialized so its CASE expressions, each carrying the coverage subplan,
// evaluate once per launch however many aggregates read the columns.
export function rankedFlowCtes(where = "") {
  const broadSelected = `${broadCoverageSql("p.")} AND (a.through_block IS NULL OR $2 >= a.through_block)`;
  return `${catalogCte}, flow AS (
    SELECT pool_id,sum(eth_wei) AS volume,count(*)::integer AS trades FROM analytics_accounting_trades WHERE chain_id=4663 AND timestamp >= $1 GROUP BY pool_id
  )${broadFlowCte("catalog")}, ranked AS MATERIALIZED (
    SELECT p.pool_id,p.launch_sender,
      CASE WHEN ${broadSelected} THEN coalesce(b.trades,0) WHEN a.pool_id IS NOT NULL THEN coalesce(f.trades,0) END AS trades,
      CASE WHEN ${broadSelected} THEN CASE WHEN coalesce(b.unsupported,0)=0 THEN coalesce(b.volume,0) END WHEN a.pool_id IS NOT NULL THEN coalesce(f.volume,0) END AS volume
    FROM catalog p LEFT JOIN broad_flow b ON b.pool_id=p.pool_id
    LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=p.pool_id
    LEFT JOIN flow f ON f.pool_id=p.pool_id ${where}
  )`;
}
// Full per-pool market state (dated units, latest and baseline price states)
// for the `page` relation being served. Never run over the whole catalog: the
// per-pool lateral lookups cost seconds at catalog scale on a small host.
export function broadExploreCtes() {
  return `${broadFlowCte("page")}, broad_metrics AS (
  SELECT p.pool_id,$2::bigint AS through_block,$6::bigint AS asof_timestamp,$3::bigint AS window_start,
    coalesce(f.trades,0) AS trades,CASE WHEN coalesce(f.unsupported,0)=0 THEN coalesce(f.volume,0) END AS volume,
    units.decimals,units.block_number AS unit_block,units.block_hash AS unit_hash,units.timestamp AS unit_time,units.source AS unit_source,
    units.conflict AS units_conflict,
    CASE WHEN units.conflict IS NOT TRUE AND units.decimals<=36 AND last.last_sqrt>0 AND last.last_price_supported THEN
      trunc(6277101735386680763835789423207666416102355444464034512896::numeric*power(10::numeric,units.decimals)/power(last.last_sqrt,2)) END AS price,
    CASE WHEN units.conflict IS NOT TRUE AND units.decimals<=36 AND baseline.last_sqrt>0 AND baseline.last_price_supported AND last.last_sqrt>0 AND last.last_price_supported THEN
      div((trunc(6277101735386680763835789423207666416102355444464034512896::numeric*power(10::numeric,units.decimals)/power(last.last_sqrt,2))-
        trunc(6277101735386680763835789423207666416102355444464034512896::numeric*power(10::numeric,units.decimals)/power(baseline.last_sqrt,2)))*10000,
        nullif(trunc(6277101735386680763835789423207666416102355444464034512896::numeric*power(10::numeric,units.decimals)/power(baseline.last_sqrt,2)),0))/100 END AS change,
    last.last_sqrt AS sqrt_price_x96,last.last_block AS price_block,last.last_hash AS price_hash,last.timestamp AS price_time,
    baseline.last_block AS baseline_block,baseline.last_hash AS baseline_hash,baseline.timestamp AS baseline_time
  FROM page p LEFT JOIN broad_flow f USING(pool_id)
  LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=p.pool_id
  LEFT JOIN LATERAL(
    WITH eligible AS (
      SELECT u.decimals,u.block_number,u.block_hash,u.timestamp,'broad_token_units'::text AS source
      FROM broad_token_units u JOIN broad_batches b USING(chain_id,stream_key,batch_end)
      JOIN indexer_batches i ON i.chain_id=b.chain_id AND i.stream_key=b.stream_key AND i.to_block=b.batch_end
        AND i.block_hash=u.block_hash AND u.timestamp=b.timestamp
      WHERE u.chain_id=4663 AND u.token=p.token AND u.block_number BETWEEN greatest($4,p.launch_block) AND $2
      UNION ALL SELECT (a.market->>'decimals')::smallint,a.through_block,a.through_hash,a.asof_timestamp,'verified_deep_snapshot'
        WHERE a.through_block BETWEEN greatest($4,p.launch_block) AND $2 AND a.asof_timestamp<=$6
    ), summary AS(SELECT count(DISTINCT decimals)>1 AS conflict FROM eligible)
    SELECT summary.conflict,latest.* FROM summary LEFT JOIN LATERAL(
      SELECT * FROM eligible ORDER BY block_number DESC,source ASC LIMIT 1)latest ON true
  )units ON true
  LEFT JOIN LATERAL(SELECT * FROM broad_market_buckets WHERE chain_id=4663 AND pool_id=p.pool_id AND batch_end<=$2
    ORDER BY timestamp DESC,last_block DESC,last_log DESC,last_tx DESC LIMIT 1)last ON true
  LEFT JOIN LATERAL(SELECT * FROM broad_market_buckets WHERE chain_id=4663 AND pool_id=p.pool_id AND batch_end<=$2 AND timestamp<$3
    ORDER BY timestamp DESC,last_block DESC,last_log DESC,last_tx DESC LIMIT 1)baseline ON true
  WHERE ${broadCoverageSql("p.")}
), metrics AS (
  SELECT p.pool_id,a.market,a.liquidity_wei,a.holders_count,a.from_block,a.from_timestamp,a.generated_at,a.source_kind,
    CASE WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN true ELSE false END AS broad_selected,
    CASE WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.volume ELSE a.volume END AS volume,
    CASE WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.trades ELSE a.trades END AS trades,
    CASE WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.price ELSE CASE WHEN a.units_conflict IS NOT TRUE THEN (a.market->>'priceWei')::numeric END END AS price,
    CASE WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.change ELSE CASE WHEN a.units_conflict IS NOT TRUE THEN a.change END END AS change,
    a.through_block,a.asof_timestamp,
    b.unit_block,b.unit_hash,b.unit_time,b.unit_source,b.decimals,
    CASE WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.units_conflict ELSE a.units_conflict END AS units_conflict,b.sqrt_price_x96,b.price_block,b.price_hash,b.price_time,
    b.baseline_block,b.baseline_hash,b.baseline_time,b.window_start,a.through_hash AS deep_hash
  FROM page p LEFT JOIN deep_metrics a USING(pool_id) LEFT JOIN broad_metrics b USING(pool_id)
)`;
}
