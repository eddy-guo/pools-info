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
import { ledgerCoverage } from "./ledger-leaderboard";
import {
  ledgerCut,
  ledgerWindowHour,
  type MarketSource,
} from "./ledger-market";

export const creatorsNote =
  "launches counts every discovered launch by the sender; measured, traded, volumeWei, medianVolumeWei, bestLaunch and boughtOwnLaunch come from measured launches only. An unmeasured launch counts in launches and nowhere else; no figure is invented for it. boughtOwnLaunch is sender-routed evidence: a buy in one of the sender's measured launches whose transaction sender is that address, and a transaction sender is an initiator, not a proven beneficiary.";
/** The note under `MARKET_SOURCE=ledger` once the ledger has folded: the
 * same figures, with a launch the ledger covers measured from its pool hours
 * and state, and its own-buy evidence the ledger's attributed position. */
export const ledgerCreatorsNote =
  "launches counts every discovered launch by the sender; measured, traded, volumeWei, medianVolumeWei, bestLaunch and boughtOwnLaunch come from measured launches only. An unmeasured launch counts in launches and nowhere else; no figure is invented for it. A launch the aggregate ledger covers is measured from the ledger's pool hours and state, and its boughtOwnLaunch is attributed evidence: a buy in one of the sender's measured launches attributed to that address (the transaction's initiator when it received the tokens, otherwise the one address that did). Any other measured launch keeps the broad rule, where boughtOwnLaunch is sender-routed: a buy whose transaction sender is that address, an initiator rather than a proven beneficiary.";
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
 * `sort=volume` population and its figures agree with that list: under
 * `MARKET_SOURCE=ledger` every launch the ledger covers is measured from its
 * pool hours and state (docs/LEDGER-MARKET-SERVING.md), the rest as with the
 * switch off, and a ledger that has folded nothing yet changes no figure
 * (`ledgerCut` returns null). One pass over the ranked launches groups by
 * sender; the median is taken from the ordered measured volumes as exact
 * numeric, never a float percentile. */
export async function readCreators(
  query: ReadQuery,
  options: CreatorsOptions,
  source: MarketSource = "broad",
): Promise<CreatorsResponse> {
  // The ranked statement's cost estimate sits far above
  // jit_optimize_above_cost while it executes in well under a second, so a
  // JIT-capable host would spend seconds compiling it (see explore).
  await query("SET LOCAL jit = off");
  const broadCut = await broadExploreCut(query);
  const ledger = source === "ledger" ? await ledgerCut(query) : null;
  const accounting = await accountingCoverage(query),
    coverage = ledger
      ? await ledgerCoverage(query, ledger.asOf, accounting.catalogPools)
      : accounting,
    window = options.window ?? "All",
    sort = options.sort ?? "launches",
    direction = options.direction === "asc" ? "ASC" : "DESC",
    offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  // $1-$6 feed the broad and deep rules and, with the ledger, $7-$9 its
  // cursor, the window's first hour and its start block, as explore binds
  // them; the page's limit and offset follow.
  const values: unknown[] = [
    windowFrom(accounting, window),
    broadCut?.block ?? null,
    broadWindowStart(broadCut, window),
    broadCut?.startBlock ?? null,
    broadCut?.discoveryBatch ?? null,
    broadCut?.asOf ?? null,
    ...(ledger
      ? [ledger.block, ledgerWindowHour(ledger, window), ledger.startBlock]
      : []),
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
  const ranked = rankedFlowCtes("", { ledger: ledger ? window : null });
  const rows = (
    await query(
      `${ranked}, creators AS (
    SELECT launch_sender,count(*)::integer AS launches,count(volume)::integer AS measured,
      count(*) FILTER (WHERE volume IS NOT NULL AND trades>0)::integer AS traded,
      sum(volume) AS volume,
      array_agg(volume ORDER BY volume) FILTER (WHERE volume IS NOT NULL) AS volumes,
      (array_agg(pool_id ORDER BY volume DESC,pool_id) FILTER (WHERE volume IS NOT NULL))[1] AS best_pool,
      max(volume) AS best_volume
    FROM ranked GROUP BY launch_sender
  ), figures AS (
    SELECT launch_sender,launches,measured,traded,volume,
      CASE WHEN measured>0 THEN div(volumes[(measured+1)/2]+volumes[(measured+2)/2],2) END AS median,
      best_pool,best_volume
    FROM creators
  ) SELECT *,count(*) OVER () AS total FROM figures ${filter} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    )
  ).rows;
  // An empty page past the end still reports the population's total. This is
  // a top-100-per-window-and-sort leaderboard: no rank beyond 100 is served,
  // so the reported total (and, through it, nextOffset) never exceeds 100.
  const total = Math.min(
    100,
    rows.length
      ? Number(rows[0].total)
      : Number(
          (
            await query(
              `${ranked} SELECT count(*)::text AS count FROM (SELECT launch_sender FROM ranked GROUP BY launch_sender ${sort === "launches" ? "" : "HAVING count(volume)>0"}) creators`,
              values,
            )
          ).rows[0].count,
        ),
  );
  // Own-buy evidence for the page's creators and no others. It costs a
  // position probe per launch, so over the whole catalog it was 2.1s of a
  // cold production-shaped read's 2.4s, inside a 3s statement budget; the
  // page's creators are the only ones whose flag is served, and the orders
  // above never read it. bought_own is null without a measured launch, since
  // only measured launches carry swap evidence.
  const senders = rows.map((r) => r.launch_sender),
    ownParam = `$${values.length + 1}`,
    ownRanked = rankedFlowCtes(
      `WHERE p.launch_sender=ANY(${ownParam}::text[])`,
      {
        ownBuys: ownParam,
        ledger: ledger ? window : null,
      },
    );
  const own = new Map<string, boolean | null>(
    senders.length
      ? (
          await query(
            `${ownRanked} SELECT launch_sender,bool_or(own) FILTER (WHERE volume IS NOT NULL) AS bought_own FROM ranked GROUP BY launch_sender`,
            [...values, senders],
          )
        ).rows.map((r) => [
          r.launch_sender,
          r.bought_own === null ? null : Boolean(r.bought_own),
        ])
      : [],
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
    boughtOwnLaunch: own.get(r.launch_sender) ?? null,
  }));
  return {
    coverage,
    broadMarketCutoff: announcedBroadMarketCutoff(broadCut),
    window,
    sort,
    direction: direction === "ASC" ? "asc" : "desc",
    attribution: "launch_transaction_initiator",
    measuredFigures,
    note: ledger ? ledgerCreatorsNote : creatorsNote,
    items,
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
