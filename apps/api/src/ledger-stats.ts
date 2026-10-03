import type { LiveWindow } from "@pools/core";
import type { ReadQuery } from "./catalog-read";
import { ledgerCoverage } from "./ledger-leaderboard";
import {
  ledgerCut,
  ledgerFlow,
  ledgerHour,
  ledgerLaunchSql,
  ledgerWindowHour,
  ledgerWindowStart,
} from "./ledger-market";
import { RequestError } from "./request";

/** Market-wide header figures over ledger-covered launches only. The ledger
 * does not measure locked ETH liquidity, so that field remains null. The
 * coverage and cutoff make this a disclosed partial sum, never a claim about
 * pools outside the folded launch lanes. */
export async function readLedgerStats(query: ReadQuery, window: LiveWindow) {
  await query("SET LOCAL jit = off");
  const cut = await ledgerCut(query);
  if (!cut) throw new RequestError(503, "stats_coverage_unavailable");
  let allActiveTraders: number | null = null;
  if (window === "All") {
    const { rows } = await query(
      `SELECT a.through_block,a.through_timestamp,a.crowd_block,
         encode(a.crowd_hash,'hex') AS crowd_hash,a.instant_traders,a.all_traders,
         c.cursor_block AS current_crowd_block,encode(c.cursor_hash,'hex') AS current_crowd_hash
       FROM agg_active_trader_counts a LEFT JOIN agg_streams c
         ON c.chain_id=a.chain_id AND c.stream_key='ledger:crowd:v1'
       WHERE a.chain_id=4663`,
    );
    const saved = rows[0];
    const crowdBlock =
      saved?.crowd_block === null ? null : Number(saved?.crowd_block);
    const currentCrowdBlock =
      saved?.current_crowd_block === null
        ? null
        : Number(saved?.current_crowd_block);
    const aligned =
      crowdBlock === cut.block && saved?.crowd_hash === cut.hash.slice(2);
    const count = Number(aligned ? saved?.all_traders : saved?.instant_traders);
    if (
      Number(saved?.through_block) !== cut.block ||
      Number(saved?.through_timestamp) !== cut.asOf ||
      crowdBlock !== currentCrowdBlock ||
      saved?.crowd_hash !== saved?.current_crowd_hash ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw new RequestError(503, "stats_coverage_unavailable");
    allActiveTraders = count;
  }
  const hour = window === "1h" ? await ledgerHour(query, cut) : null;
  const flow = ledgerFlow(window, hour);
  const start = ledgerWindowStart(cut, window);
  const completeWindow = flow !== "none";
  const eligible = `SELECT p.pool_ref,p.launched_at FROM indexed_pools p
    LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=p.pool_id
    WHERE p.chain_id=4663 AND ${ledgerLaunchSql("p.", "$1", "$2")}
      AND (a.through_block IS NULL OR $2>=a.through_block)`;
  const values = [
    cut.startBlock,
    cut.block,
    start,
    ...(window === "All" || flow === "none" || flow === "ring"
      ? []
      : [ledgerWindowHour(cut, window)]),
    ...(flow === "ring" ? [hour!.afterBlock, hour!.start] : []),
  ];
  const flowSql =
    flow === "none"
      ? `SELECT NULL::integer AS pool_ref,NULL::bigint AS trades,NULL::numeric AS volume WHERE false`
      : flow === "ring"
        ? `SELECT t.pool_ref,count(*)::bigint AS trades,sum(t.eth_wei) AS volume
         FROM agg_live_trades t JOIN eligible e USING(pool_ref)
         WHERE t.chain_id=4663 AND t.block_number>$4 AND t.block_number<=$2
           AND t.timestamp>=$5 GROUP BY t.pool_ref`
        : window === "All"
          ? `SELECT s.pool_ref,s.trades,s.volume_wei AS volume
           FROM agg_pool_state s JOIN eligible e USING(pool_ref) WHERE s.chain_id=4663`
          : `SELECT h.pool_ref,sum(h.trades) AS trades,sum(h.volume_wei) AS volume
           FROM agg_pool_hours h JOIN eligible e USING(pool_ref)
           WHERE h.chain_id=4663 AND h.hour>=$4 GROUP BY h.pool_ref`;
  const activeSql =
    flow === "none" || window === "All"
      ? `SELECT NULL::integer AS wallet_ref WHERE false`
      : flow === "ring"
        ? `SELECT coalesce(t.wallet_ref,p.wallet_ref) AS wallet_ref FROM agg_live_trades t JOIN eligible e USING(pool_ref)
           LEFT JOIN LATERAL unnest(t.pooled_wallet_refs) AS p(wallet_ref) ON true
           WHERE t.chain_id=4663 AND t.block_number>$4 AND t.block_number<=$2
             AND t.timestamp>=$5 AND coalesce(t.wallet_ref,p.wallet_ref) IS NOT NULL`
        : `SELECT w.wallet_ref FROM agg_wallet_hours w JOIN eligible e USING(pool_ref)
           WHERE w.chain_id=4663 AND w.hour>=$4`;
  const { rows } = await query(
    `WITH eligible AS MATERIALIZED (${eligible}), flow AS (${flowSql}), active AS (${activeSql})
     SELECT (SELECT count(*)::text FROM eligible) AS measured_pools,
       (SELECT count(*)::text FROM eligible WHERE $3::bigint IS NULL OR launched_at >= $3) AS pools_launched,
       (SELECT coalesce(sum(volume),0)::text FROM flow) AS volume_wei,
       (SELECT coalesce(sum(trades),0)::text FROM flow) AS trades,
       (SELECT count(DISTINCT wallet_ref)::text FROM active) AS active_traders`,
    values,
  );
  const r = rows[0];
  const coverage = await ledgerCoverage(query, cut.asOf);
  return {
    window,
    asOf: cut.asOf,
    cutoff: { block: cut.block, hash: cut.hash, asOf: cut.asOf },
    windowStart: start,
    volumeWei: flow === "none" ? null : r.volume_wei,
    trades: flow === "none" ? null : Number(r.trades),
    liquidityWei: null,
    poolsLaunched: Number(r.pools_launched),
    activeTraders:
      flow === "none"
        ? null
        : window === "All"
          ? allActiveTraders
          : Number(r.active_traders),
    completeWindow,
    coverage: {
      ...coverage,
      measuredPools: Number(r.measured_pools),
      activeTraderScope: "attributed_wallets_in_measured_pools",
    },
  };
}
