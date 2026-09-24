import type { LiveWindow, MarketBoundary } from "@pools/core";
import { catalogCte, type ReadQuery } from "./catalog-read";
import {
  ledgerAnswers,
  ledgerBaselineFoundSql,
  ledgerBaselineSql,
  ledgerLaunchSql,
  ledgerPriceSql,
  ledgerServedChangeSql,
} from "./ledger-market";
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
/** The announced shape only: `startBlock` and `discoveryBatch` are internal
 * cut bookkeeping the frontend contract does not include. */
export function announcedBroadMarketCutoff(
  cut: BroadExploreCut | null,
): (MarketBoundary & { rebuildPending: boolean }) | null {
  return cut
    ? {
        block: cut.block,
        hash: cut.hash,
        asOf: cut.asOf,
        rebuildPending: cut.rebuildPending,
      }
    : null;
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
// With `ownBuys` (the SQL expression naming a `text[]` of launch senders)
// every launch of those senders also carries `own`: whether the selected
// source holds a buy whose transaction sender is the launch sender, over that
// source's whole covered history rather than the window. It names senders
// rather than taking a flag because the evidence costs a probe per launch:
// the creators page needs it only for the creators it serves, and asking for
// it over the whole catalog is what put that read past its statement budget.
// Deep evidence rides the flow scan the rank already pays for; broad evidence
// is one hash semi-join over broad_swaps at or below the served cutoff.
// With `ledger` (the served window), the ledger's flow comes first for every
// launch it covers whose deep publication, if any, is no newer than its
// cursor ($7-$9 below), so the broad and deep rules only ever evaluate for
// the launches it does not; a window whole hours cannot answer proves no flow.
// With both, `own` for a ledger-served launch is the ledger's own evidence:
// a position of the launch sender in that pool with a buy attributed to it
// (`agg_positions.buys`, the beneficiary rule of `planLedgerBatch`: the
// initiator when it received the tokens, else the one address that did),
// over the pool's whole folded history, found by one primary-key probe per
// launch after the senders are matched to their wallet rows: the LATERAL
// with its LIMIT keeps the planner on that probe rather than the wallet
// index's every position of every launching wallet (1.3M buffers, two
// parallel workers and a temp spill). Those probes read the position heap at
// random, so they cost what the named senders launched; over the whole
// catalog they were 260k buffers and 2.1s of the 2.4s a cold
// production-shaped creators read spent inside its 3s budget.
export function rankedFlowCtes(
  where = "",
  { ownBuys = null as string | null, ledger = null as LiveWindow | null } = {},
) {
  // Own-buy evidence is only ever carried for the senders `ownBuys` names.
  const ofSenders = (column: string) =>
    ownBuys ? ` AND ${column}=ANY(${ownBuys}::text[])` : "";
  const broadSelected = `${broadCoverageSql("p.")} AND (a.through_block IS NULL OR $2 >= a.through_block)`;
  const ledgerSelected = (value: string) =>
    ledger
      ? `WHEN ll.pool_id IS NOT NULL AND p.launch_block BETWEEN $9 AND $7 AND (a.through_block IS NULL OR $7 >= a.through_block) THEN ${ledgerAnswers(ledger) ? value : "NULL"} `
      : "";
  const flow = ownBuys
    ? `SELECT t.pool_id,sum(t.eth_wei) FILTER (WHERE t.timestamp >= $1) AS volume,count(*) FILTER (WHERE t.timestamp >= $1)::integer AS trades,
      bool_or(t.side='buy' AND t.wallet=p.launch_sender) AS own
    FROM analytics_accounting_trades t LEFT JOIN indexed_pools p ON p.chain_id=t.chain_id AND p.pool_id=t.pool_id WHERE t.chain_id=4663 GROUP BY t.pool_id
  ), broad_own AS (
    SELECT DISTINCT bs.pool_id FROM broad_swaps bs JOIN indexed_pools p ON p.chain_id=bs.chain_id AND p.pool_id=bs.pool_id AND p.launch_sender=bs.transaction_sender
    WHERE bs.chain_id=4663 AND bs.side='buy' AND bs.batch_end<=$2${ofSenders("p.launch_sender")}`
    : `SELECT pool_id,sum(eth_wei) AS volume,count(*)::integer AS trades FROM analytics_accounting_trades WHERE chain_id=4663 AND timestamp >= $1 GROUP BY pool_id`;
  const ledgerOwn = ownBuys && ledger;
  return `${catalogCte}, flow AS (
    ${flow}
  )${broadFlowCte("catalog")}${
    ledger
      ? `${ledgerFlowCtes}, ledger_flow_ids AS (
    SELECT ip.pool_id,f.trades,f.volume FROM ledger_flow f JOIN indexed_pools ip ON ip.pool_ref=f.pool_ref
  )`
      : ""
  }${
    ledgerOwn
      ? `, ledger_own AS (
    SELECT ip.pool_id FROM indexed_pools ip
    JOIN agg_wallets w ON w.address=decode(substr(ip.launch_sender,3),'hex')
    JOIN LATERAL (SELECT 1 FROM agg_positions ap WHERE ap.chain_id=4663 AND ap.pool_ref=ip.pool_ref AND ap.wallet_ref=w.wallet_ref AND ap.buys>0 LIMIT 1) ap ON true
    WHERE ip.chain_id=4663${ofSenders("ip.launch_sender")}
  )`
      : ""
  }, ranked AS MATERIALIZED (
    SELECT p.pool_id,p.launch_sender,
      CASE ${ledgerSelected("coalesce(lf.trades,0)")}WHEN ${broadSelected} THEN coalesce(b.trades,0) WHEN a.pool_id IS NOT NULL THEN coalesce(f.trades,0) END AS trades,
      CASE ${ledgerSelected("coalesce(lf.volume,0)")}WHEN ${broadSelected} THEN CASE WHEN coalesce(b.unsupported,0)=0 THEN coalesce(b.volume,0) END WHEN a.pool_id IS NOT NULL THEN coalesce(f.volume,0) END AS volume${
        ownBuys
          ? `,
      CASE ${ledgerSelected("lo.pool_id IS NOT NULL")}WHEN ${broadSelected} THEN bo.pool_id IS NOT NULL WHEN a.pool_id IS NOT NULL THEN coalesce(f.own,false) END AS own`
          : ""
      }
    FROM catalog p LEFT JOIN broad_flow b ON b.pool_id=p.pool_id${ownBuys ? " LEFT JOIN broad_own bo ON bo.pool_id=p.pool_id" : ""}
    LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=p.pool_id
    LEFT JOIN flow f ON f.pool_id=p.pool_id${
      ledger
        ? `
    LEFT JOIN ledger_launches ll ON ll.pool_id=p.pool_id
    LEFT JOIN ledger_flow_ids lf ON lf.pool_id=p.pool_id`
        : ""
    }${ledgerOwn ? "\n    LEFT JOIN ledger_own lo ON lo.pool_id=p.pool_id" : ""} ${where}
  )`;
}
// Ledger parameters, bound after the broad ones: $7 the ledger's cursor
// block, $8 the window's first UTC hour (null for All), $9 the ledger's start
// block. The launches the ledger covers and every pool's window flow, over the
// whole catalog: All reads the pool state's lifetime totals, a window sums its
// hours from the hour index. The flow is keyed by pool_ref; a catalog-keyed
// read maps it to pool ids through the pool_ref index, so a window only looks
// up the pools that traded in it rather than scanning the registry again.
export const ledgerFlowCtes = `, ledger_launches AS (
    SELECT DISTINCT pool_id FROM pool_launch_sources WHERE chain_id=4663 AND stream_key='launches:agg:v1' AND batch_end<=$7
  ), ledger_flow AS (
    SELECT pool_ref,trades,volume_wei AS volume FROM agg_pool_state WHERE chain_id=4663 AND $8::integer IS NULL
    UNION ALL
    SELECT pool_ref,sum(trades),sum(volume_wei) FROM agg_pool_hours WHERE chain_id=4663 AND hour>=$8::integer GROUP BY pool_ref
  )`;
/** Every launch the ledger serves, ranked for a deep-ranked order on the
 * columns it needs: window flow, the deep liquidity (the ledger holds no ETH
 * liquidity) and the change `ledger_metrics` serves. It reads `indexed_pools`
 * directly (the catalog's recent-only rows are never covered), and `mode`
 * bounds the set: gainers need a trade inside the window, a liquidity order a
 * published liquidity, and a change order every covered launch with its
 * baseline probed only where it traded inside the window. `where` holds the
 * catalog filters (on `p`). Requires `ledgerFlowCtes`. Only the deep
 * publications' narrow columns ride its 62k-row joins, and it streams into
 * the rank rather than being stored, so neither spills past work_mem. */
export function ledgerRankedCte(
  where: string,
  mode: "change" | "gainers" | "liquidity",
  window: LiveWindow,
) {
  const active = "f.pool_ref IS NOT NULL",
    answers = ledgerAnswers(window);
  return `, ledger_ranked AS (
    SELECT p.pool_id,p.launch_block,
      ${answers ? "CASE WHEN $8::integer IS NULL THEN coalesce(s.trades,0) ELSE coalesce(f.trades,0) END" : "NULL::bigint"} AS trades,
      ${answers ? "CASE WHEN $8::integer IS NULL THEN coalesce(s.volume_wei,0) ELSE coalesce(f.volume,0) END" : "NULL::numeric"} AS volume,
      a.liquidity_wei,
      ${
        mode === "liquidity" || !answers
          ? "NULL::numeric"
          : ledgerServedChangeSql({
              hour: "$8::integer",
              decimals: "p.decimals",
              conflict: "coalesce(a.decimals<>p.decimals,false)",
              latest: "s.sqrt_price_x96",
              active,
              baseline: "base.sqrt",
            })
      } AS change
    FROM indexed_pools p
    ${mode === "gainers" ? "JOIN" : "LEFT JOIN"} ledger_flow f ON f.pool_ref=p.pool_ref
    ${mode === "liquidity" ? "JOIN" : "LEFT JOIN"} (SELECT pool_id,through_block,liquidity_wei,(market->>'decimals')::integer AS decimals
      FROM analytics_accounting_pools WHERE chain_id=4663${mode === "liquidity" ? " AND liquidity_wei IS NOT NULL" : ""}) a ON a.pool_id=p.pool_id
    LEFT JOIN agg_pool_state s ON s.chain_id=4663 AND s.pool_ref=p.pool_ref${
      mode === "liquidity"
        ? ""
        : `
    LEFT JOIN LATERAL (${ledgerBaselineSql("p.pool_ref", "$8::integer", active)}) base ON true`
    }
    WHERE p.chain_id=4663${where ? " AND " + where.replace(/^WHERE /, "") : ""} AND ${ledgerLaunchSql("p.", "$9", "$7")}
      AND (a.through_block IS NULL OR $7 >= a.through_block)
  )`;
}
// Full per-pool market state (dated units, latest and baseline price states)
// for the `page` relation being served. Never run over the whole catalog: the
// per-pool lateral lookups cost seconds at catalog scale on a small host.
// With `ledger` (the served window), `ledger_metrics` serves every page pool
// the ledger covers and wins over broad and deep wherever no deep publication
// is newer than its cursor; `ledger_selected` names those rows. Its units
// conflict when a deep publication declares other decimals, exactly as
// broad's do. A window whole hours cannot answer serves no flow or change.
export function broadExploreCtes({ ledger = null as LiveWindow | null } = {}) {
  const answers = !!ledger && ledgerAnswers(ledger);
  const selected = `l.pool_id IS NOT NULL AND (a.through_block IS NULL OR $7>=a.through_block)`;
  const when = (value: string) =>
    ledger ? `WHEN ${selected} THEN ${value} ` : "";
  const column = (plain: string, value: string, name: string) =>
    ledger ? `CASE ${when(value)}ELSE ${plain} END AS ${name}` : plain;
  return `${broadFlowCte("page")}${
    ledger
      ? `, ledger_page AS (
  SELECT p.pool_id,ip.pool_ref,ip.decimals FROM page p JOIN indexed_pools ip ON ip.chain_id=4663 AND ip.pool_id=p.pool_id
  WHERE ${ledgerLaunchSql("p.", "$9", "$7")}
), ledger_page_flow AS (
  SELECT pool_ref,sum(trades) AS trades,sum(volume_wei) AS volume FROM agg_pool_hours
  WHERE chain_id=4663 AND hour>=$8::integer AND pool_ref IN (SELECT pool_ref FROM ledger_page) GROUP BY pool_ref
), ledger_metrics AS (
  SELECT lp.pool_id,
    ${answers ? "CASE WHEN $8::integer IS NULL THEN coalesce(s.trades,0) ELSE coalesce(f.trades,0) END" : "NULL::bigint"} AS trades,
    ${answers ? "CASE WHEN $8::integer IS NULL THEN coalesce(s.volume_wei,0) ELSE coalesce(f.volume,0) END" : "NULL::numeric"} AS volume,
    units.conflict AS units_conflict,
    CASE WHEN NOT units.conflict THEN lp.decimals END AS decimals,
    CASE WHEN NOT units.conflict THEN ${ledgerPriceSql("s.sqrt_price_x96", "lp.decimals")} END AS price,
    ${answers ? ledgerServedChangeSql({ hour: "$8::integer", decimals: "lp.decimals", conflict: "units.conflict", latest: "s.sqrt_price_x96", active: "f.pool_ref IS NOT NULL", baseline: "base.sqrt" }) : "NULL::numeric"} AS change,
    ${answers ? ledgerBaselineFoundSql("s.sqrt_price_x96", "f.pool_ref IS NOT NULL", "base.sqrt") : "false"} AS baseline
  FROM ledger_page lp
  LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=lp.pool_id
  CROSS JOIN LATERAL (SELECT coalesce((a.market->>'decimals')::integer<>lp.decimals,false) AS conflict) units
  LEFT JOIN agg_pool_state s ON s.chain_id=4663 AND s.pool_ref=lp.pool_ref
  LEFT JOIN ledger_page_flow f ON f.pool_ref=lp.pool_ref
  LEFT JOIN LATERAL (${ledgerBaselineSql("lp.pool_ref", "$8::integer", "f.pool_ref IS NOT NULL")}) base ON true
)`
      : ""
  }, broad_metrics AS (
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
    CASE ${when("false")}WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN true ELSE false END AS broad_selected,
    CASE ${when("l.volume")}WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.volume ELSE a.volume END AS volume,
    CASE ${when("l.trades")}WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.trades ELSE a.trades END AS trades,
    CASE ${when("l.price")}WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.price ELSE CASE WHEN a.units_conflict IS NOT TRUE THEN (a.market->>'priceWei')::numeric END END AS price,
    CASE ${when("l.change")}WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.change ELSE CASE WHEN a.units_conflict IS NOT TRUE THEN a.change END END AS change,
    a.through_block,a.asof_timestamp,
    b.unit_block,b.unit_hash,b.unit_time,b.unit_source,${column("b.decimals", "l.decimals", "decimals")},
    CASE ${when("l.units_conflict")}WHEN b.pool_id IS NOT NULL AND (a.through_block IS NULL OR b.through_block>=a.through_block) THEN b.units_conflict ELSE a.units_conflict END AS units_conflict,b.sqrt_price_x96,b.price_block,b.price_hash,b.price_time,
    b.baseline_block,b.baseline_hash,b.baseline_time,b.window_start,a.through_hash AS deep_hash${
      ledger
        ? `,
    ${selected} AS ledger_selected,l.baseline AS ledger_baseline`
        : ""
    }
  FROM page p LEFT JOIN deep_metrics a USING(pool_id) LEFT JOIN broad_metrics b USING(pool_id)${ledger ? " LEFT JOIN ledger_metrics l USING(pool_id)" : ""}
)`;
}
