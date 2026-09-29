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
 * per window in `agg_trader_windows`, summed by the tip loop from whole UTC
 * hours ending with the ledger cursor's hour without the positions in pools
 * the wallet launched itself (`packages/db/src/ledger-windows.ts`). A
 * observed contract is excluded from the board. The board is the top 100 per window and
 * nothing beyond it (captain, 17 Sep 2026): a page reaching past 100 is
 * refused, and `total` never exceeds 100. The writer's `ledgerWindowPolicy`
 * holds the same two numbers; this read service does not depend on the
 * writer package, and the integration test pins them equal. */
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
/** Eligible for the board at the requested gate; `w` names the wallet row. */
const eligible = (minTrades: number, w: string, x = "x") =>
  `${x}.supported_trades>=${minTrades} AND ${x}.supported_positions>0
   AND NOT EXISTS (SELECT 1 FROM wallet_code_observations c WHERE c.chain_id=4663 AND c.address=${w}.address AND c.kind='contract')`;

/** Profile ranks and search enrichment use the board's realized top 100 for
 * their respective windows, with trader-only totals and contract exclusion.
 * The inner LIMIT bounds the window function to the served board. */
export const ledgerRealizedRanksSql = `SELECT wallet_ref,row_number() OVER (ORDER BY realized_wei DESC,address)::int AS rank FROM (
  SELECT t.wallet_ref,t.realized_wei,v.address FROM agg_trader_windows t JOIN agg_wallets v USING (wallet_ref)
  WHERE t.chain_id=4663 AND t."window"=$1 AND ${eligible(ledgerLeaderboardPolicy.minTrades, "v", "t")}
  ORDER BY t.realized_wei DESC,v.address LIMIT ${ledgerLeaderboardPolicy.rankedWallets}
) top`;

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
  const column = metric === "net" ? "net_wei" : "realized_wei";
  const rows = (
    await query(
      `WITH cut AS (
             SELECT x.${column} AS threshold FROM agg_trader_windows x JOIN agg_wallets v USING (wallet_ref)
             WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible(minTrades, "v")}
             ORDER BY x.${column} DESC OFFSET $4 LIMIT 1
           )
           SELECT $3::int+row_number() OVER (ORDER BY x.${column} DESC,x.address) AS rank,${summaryColumns("x.address")} FROM (
             SELECT x.*,w.address FROM agg_trader_windows x JOIN agg_wallets w USING (wallet_ref)
             WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible(minTrades, "w")}
               AND x.${column}>=coalesce((SELECT threshold FROM cut),'-Infinity')
             ORDER BY x.${column} DESC,w.address LIMIT $2 OFFSET $3
           ) x ORDER BY x.${column} DESC,x.address`,
      [window, limit, offset, offset + limit - 1],
    )
  ).rows;
  const total = Number(
    (
      await query(
        `SELECT count(*)::int AS count FROM (SELECT 1 FROM agg_trader_windows x JOIN agg_wallets w USING (wallet_ref)
             WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible(minTrades, "w")} LIMIT $2) c`,
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
