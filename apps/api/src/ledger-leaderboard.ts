import type {
  AnalyticsCoverage,
  AnalyticsLeaderboardOptions,
  AnalyticsLeaderboardResponse,
  LiveWindow,
} from "@pools/core";
import { walletSummary } from "./accounting-read";
import type { ReadQuery } from "./catalog-read";
import { catalogSummary } from "./explore-read";
import { ledgerCut, type LedgerCut } from "./ledger-market";
import { RequestError } from "./request";

/** The trader leaderboard from the aggregate ledger (`MARKET_SOURCE=ledger`,
 * docs/LEDGER-MARKET-SERVING.md "The trader leaderboard"): one row per wallet
 * per window in `agg_wallet_windows`, summed by the tip loop from whole UTC
 * hours ending with the ledger cursor's hour, with the top of the board by
 * realized already ranked (`packages/db/src/ledger-windows.ts`). The board is
 * the top 100 per window and nothing beyond it (captain, 17 Sep 2026): a page
 * reaching past 100 is refused, and `total` never exceeds 100. The writer's
 * `ledgerWindowPolicy` holds the same two numbers; this read service does not
 * depend on the writer package, and the integration test pins them equal. */
export const ledgerLeaderboardPolicy = Object.freeze({
  /** Eligible for a rank: at least this many supported trades in the window
   * on a supported position, the gate migration 020's partial index carries
   * and the board's default `minTrades`. */
  minTrades: 10,
  /** Ranks are kept for the top of the board only. */
  rankedWallets: 100,
});

/** Every column `walletSummary` reads, under its names, from a window row
 * `x`. Unrealized is not a board figure (it needs a price per position; the
 * wallet reader marks them), the window's cutoff is the cursor its rows were
 * summed to, and every row spans its whole window, since the ledger folds
 * every swap since launch. */
export const summaryColumns = (
  address: string,
) => `'0x'||encode(${address},'hex') AS wallet,x.realized_wei::text AS realized,x.net_wei::text AS net,
  x.volume_wei::text AS volume,x.disposed_cost_wei::text AS disposed_cost,NULL::text AS unrealized,
  x.trades AS trade_count,x.supported_trades,x.wins,x.losses,x.closures,x.hold_seconds::text AS hold_seconds,
  x.best_wei::text AS best,x.last_timestamp::text AS last,x.supported_positions AS supported_count,
  x.excluded_positions AS excluded_count,true AS complete_window`;
/** The window's refresh row: the cursor its rows were summed to. A window
 * the tip loop has not refreshed since the ledger's last walk-back has no
 * rows to stand on and answers a retryable 503 until the next refresh
 * (about a minute); a refresh past the served cut is evidence out of order. */
export async function ledgerWindowRefresh(
  query: ReadQuery,
  cut: LedgerCut,
  window: LiveWindow,
  pending: string,
) {
  const refresh = (
    await query(
      `SELECT through_block,through_timestamp,window_start,ranked FROM agg_window_refreshes WHERE chain_id=4663 AND "window"=$1`,
      [window],
    )
  ).rows[0];
  if (!refresh) throw new RequestError(503, pending);
  if (Number(refresh.through_block) > cut.block)
    throw new RequestError(503, "market_evidence_invalid");
  return {
    asOf: Number(refresh.through_timestamp),
    windowStart: Number(refresh.window_start),
    ranked: Number(refresh.ranked),
  };
}
/** The ledger's coverage as every wallet and creator read serves it: the
 * catalog's count, the pools with a trade, and the selected cutoff as both
 * cut times. A caller that already read the catalog can pass its count to
 * avoid repeating the same whole-catalog count. */
export async function ledgerCoverage(
  query: ReadQuery,
  asOf: number,
  catalogPools?: number,
): Promise<AnalyticsCoverage> {
  const catalogCount = catalogPools ?? (await catalogSummary(query)).count;
  const processed = (
    await query(
      `SELECT count(*)::int AS count FROM agg_pool_state WHERE chain_id=4663`,
    )
  ).rows[0];
  return {
    catalogPools: catalogCount,
    processedPools: processed.count,
    asOf,
    oldestAsOf: asOf,
    generatedAt: new Date().toISOString(),
    complete: false,
    registryExhaustive: false,
    pnlScope: "attributed_positions_all_pools",
  };
}
/** Eligible for the board: the writer's own rule, as a literal so the planner
 * matches migration 020's partial index whenever the gate is its 10 or more. */
const eligible = (minTrades: number) =>
  `x.supported_trades>=${minTrades} AND x.supported_positions>0`;

/** The board for the window, or null when the ledger has folded nothing yet
 * (no cursor or no pool hour), in which case the accounting tables answer
 * exactly as with the switch off. A window the tip loop has not refreshed
 * since the ledger's last walk-back has no rows to stand on and answers a
 * retryable 503 until the next refresh (about a minute). */
export async function readLedgerLeaderboard(
  query: ReadQuery,
  options: AnalyticsLeaderboardOptions,
): Promise<AnalyticsLeaderboardResponse | null> {
  const cut = await ledgerCut(query);
  if (!cut) return null;
  const window = options.window ?? "All",
    metric = options.metric ?? "realized",
    minTrades = options.minTrades ?? ledgerLeaderboardPolicy.minTrades,
    offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  if (!Number.isSafeInteger(minTrades) || minTrades < 0)
    throw new RequestError(400, "invalid_min_trades");
  if (offset + limit > ledgerLeaderboardPolicy.rankedWallets)
    throw new RequestError(400, "invalid_offset");
  const refresh = await ledgerWindowRefresh(
    query,
    cut,
    window,
    "leaderboard_refresh_pending",
  );
  const asOf = refresh.asOf;
  // The writer's own ranking serves the board it ranked: the top 100 off the
  // rank index, one probe per address. Any other gate or metric orders the
  // eligible rows the same way (the address breaking ties) and counts them up
  // to the cap, so its total is the same population's. That order is found
  // as the writer finds its ranks: the metric at the page's last position
  // bounds the candidates first, so the join and the tie-break sort touch a
  // page of rows rather than the window's whole eligible set.
  const ranked =
    metric === "realized" && minTrades === ledgerLeaderboardPolicy.minTrades;
  const column = metric === "net" ? "net_wei" : "realized_wei";
  const rows = ranked
    ? (
        await query(
          `SELECT x.rank,${summaryColumns("w.address")} FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
           WHERE x.chain_id=4663 AND x."window"=$1 AND x.rank IS NOT NULL ORDER BY x.rank LIMIT $2 OFFSET $3`,
          [window, limit, offset],
        )
      ).rows
    : (
        await query(
          `WITH cut AS (
             SELECT x.${column} AS threshold FROM agg_wallet_windows x
             WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible(minTrades)}
             ORDER BY x.${column} DESC OFFSET $4 LIMIT 1
           )
           SELECT $3::int+row_number() OVER (ORDER BY x.${column} DESC,x.address) AS rank,${summaryColumns("x.address")} FROM (
             SELECT x.*,w.address FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
             WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible(minTrades)}
               AND x.${column}>=coalesce((SELECT threshold FROM cut),'-Infinity')
             ORDER BY x.${column} DESC,w.address LIMIT $2 OFFSET $3
           ) x ORDER BY x.${column} DESC,x.address`,
          [window, limit, offset, offset + limit - 1],
        )
      ).rows;
  const total = ranked
    ? refresh.ranked
    : Number(
        (
          await query(
            `SELECT count(*)::int AS count FROM (SELECT 1 FROM agg_wallet_windows x
             WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible(minTrades)} LIMIT $2) c`,
            [window, ledgerLeaderboardPolicy.rankedWallets],
          )
        ).rows[0].count,
      );
  return {
    coverage: await ledgerCoverage(query, asOf),
    window,
    metric,
    minTrades,
    items: rows.map((r) =>
      walletSummary({ ...r, asof: asOf, oldest: asOf }, r.wallet),
    ),
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
