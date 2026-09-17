import type {
  CreatorRow,
  CreatorsOptions,
  CreatorsResponse,
} from "@pools/core";
import { accountingCoverage, windowFrom } from "./accounting-read";
import {
  announcedBroadMarketCutoff,
  broadExploreCut,
  broadWindowStart,
  rankedFlowCtes,
} from "./broad-explore";
import { catalogCte, type ReadQuery } from "./catalog-read";
import { catalogPool } from "./explore-read";

export const creatorsNote =
  "launches counts every discovered launch by the sender; measured, traded, volumeWei, medianVolumeWei, bestLaunch and boughtOwnLaunch come from measured launches only. An unmeasured launch counts in launches and nowhere else; no figure is invented for it. boughtOwnLaunch is sender-routed evidence: a buy in one of the sender's measured launches whose transaction sender is that address, and a transaction sender is an initiator, not a proven beneficiary.";
export const measuredFigures = [
  "measured",
  "traded",
  "volumeWei",
  "medianVolumeWei",
  "bestLaunch",
  "boughtOwnLaunch",
] as const;

/** Creators are launch transaction senders grouped over the whole catalog.
 * A launch is measured under the rule that gives an explore row its window
 * volume (`rankedFlowCtes`), so `measured` is the creator's share of explore's
 * `sort=volume` population and its figures agree with that list. One pass
 * over the ranked launches groups by sender; the median is taken from the
 * ordered measured volumes as exact numeric, never a float percentile. */
export async function readCreators(
  query: ReadQuery,
  options: CreatorsOptions,
): Promise<CreatorsResponse> {
  // The ranked statement's cost estimate sits far above
  // jit_optimize_above_cost while it executes in well under a second, so a
  // JIT-capable host would spend seconds compiling it (see explore).
  await query("SET LOCAL jit = off");
  const broadCut = await broadExploreCut(query);
  const coverage = await accountingCoverage(query),
    window = options.window ?? "All",
    sort = options.sort ?? "launches",
    direction = options.direction === "asc" ? "ASC" : "DESC",
    offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  const values: unknown[] = [
    windowFrom(coverage, window),
    broadCut?.block ?? null,
    broadWindowStart(broadCut, window),
    broadCut?.startBlock ?? null,
    broadCut?.discoveryBatch ?? null,
    broadCut?.asOf ?? null,
  ];
  // Launch-first: the launches order lists every creator; a metric order
  // lists only creators with a measured launch, before total and paging.
  const filter = sort === "launches" ? "" : "WHERE measured>0";
  const order =
    sort === "launches"
      ? `launches ${direction},volume DESC NULLS LAST,launch_sender ASC`
      : `${sort === "volume" ? "volume" : "median"} ${direction},launch_sender ASC`;
  // volumes[] holds the measured volumes ascending, so the median is the
  // middle element, or the floor of the two middle elements' mean for an
  // even count; both index expressions name the same element when the count
  // is odd. The best launch is the highest volume, lowest pool id on ties.
  // bought_own is null without a measured launch, since only measured
  // launches carry swap evidence.
  const ranked = rankedFlowCtes("", { ownBuys: true });
  const rows = (
    await query(
      `${ranked}, creators AS (
    SELECT launch_sender,count(*)::integer AS launches,count(volume)::integer AS measured,
      count(*) FILTER (WHERE volume IS NOT NULL AND trades>0)::integer AS traded,
      sum(volume) AS volume,
      array_agg(volume ORDER BY volume) FILTER (WHERE volume IS NOT NULL) AS volumes,
      (array_agg(pool_id ORDER BY volume DESC,pool_id) FILTER (WHERE volume IS NOT NULL))[1] AS best_pool,
      max(volume) AS best_volume,
      bool_or(own) FILTER (WHERE volume IS NOT NULL) AS bought_own
    FROM ranked GROUP BY launch_sender
  ), figures AS (
    SELECT launch_sender,launches,measured,traded,volume,
      CASE WHEN measured>0 THEN div(volumes[(measured+1)/2]+volumes[(measured+2)/2],2) END AS median,
      best_pool,best_volume,bought_own
    FROM creators
  ) SELECT *,count(*) OVER () AS total FROM figures ${filter} ORDER BY ${order} LIMIT $7 OFFSET $8`,
      [...values, limit, offset],
    )
  ).rows;
  // An empty page past the end still reports the population's total.
  const total = rows.length
    ? Number(rows[0].total)
    : Number(
        (
          await query(
            `${ranked} SELECT count(*)::text AS count FROM (SELECT launch_sender FROM ranked GROUP BY launch_sender ${sort === "launches" ? "" : "HAVING count(volume)>0"}) creators`,
            values,
          )
        ).rows[0].count,
      );
  // The page's best launches carry their catalog identity; a single
  // reference inlines the catalog CTE into two primary-key lookups.
  const bestIds = rows.map((r) => r.best_pool).filter(Boolean);
  const best = new Map<string, Record<string, any>>(
    bestIds.length
      ? (
          await query(
            `${catalogCte} SELECT * FROM catalog WHERE pool_id=ANY($1::text[])`,
            [bestIds],
          )
        ).rows.map((r) => [r.pool_id, r])
      : [],
  );
  const items: CreatorRow[] = rows.map((r) => ({
    address: r.launch_sender,
    launches: Number(r.launches),
    measured: Number(r.measured),
    traded: Number(r.traded),
    volumeWei: r.volume === null ? null : String(r.volume),
    medianVolumeWei: r.median === null ? null : String(r.median),
    bestLaunch:
      r.best_pool === null
        ? null
        : {
            ...catalogPool(best.get(r.best_pool)!),
            volumeWei: String(r.best_volume),
          },
    boughtOwnLaunch: r.bought_own === null ? null : Boolean(r.bought_own),
  }));
  return {
    coverage,
    broadMarketCutoff: announcedBroadMarketCutoff(broadCut),
    window,
    sort,
    direction: direction === "ASC" ? "asc" : "desc",
    attribution: "launch_transaction_initiator",
    measuredFigures,
    note: creatorsNote,
    items,
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
