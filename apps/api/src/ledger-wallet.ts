import type {
  AnalyticsWalletPosition,
  AnalyticsWalletResponse,
  LiveWindow,
} from "@pools/core";
import { readLaunches, walletSummary } from "./accounting-read";
import type { ReadQuery } from "./catalog-read";
import { catalogPool } from "./explore-read";
import {
  ledgerCoverage,
  ledgerWindowRefresh,
  summaryColumns,
} from "./ledger-leaderboard";
import { ledgerCut } from "./ledger-market";

/** The wallet page from the aggregate ledger (`MARKET_SOURCE=ledger`,
 * docs/LEDGER-MARKET-SERVING.md "The wallet page"): the header and the
 * window's figures from the same `agg_wallet_windows` row the trader board
 * ranks, so the profile's headline equals the board's row to the wei at the
 * same cursor, and the positions from `agg_positions`, the fold's whole state
 * per pool, marked at each pool's latest price state. The response is the
 * accounting reader's, field for field; what the ledger does not keep is
 * served empty rather than from the frozen tables: there is no row per sale
 * (design decision D3), so `trades` is empty, and the hourly realized curve
 * is the next slice's, so `curve` is empty. */

/** The mark of a supported position: what its held units fetch at the pool's
 * latest price state, less their cost, exact to the wei and truncated toward
 * zero as `ledgerPriceSql` prices a whole token (`2^192 / sqrt^2` wei per raw
 * unit, the decimals cancelling). A flat position marks at zero less its
 * cost (zero under the fold's invariant) whatever the pool's price; a held
 * one is unmarked, null, while the pool's decimals are unknown or it has no
 * price state, and an excluded position's finances are never served. */
const markSql = `CASE WHEN NOT p.supported THEN NULL WHEN p.quantity_raw=0 THEN -p.cost_wei
  WHEN i.decimals IS NOT NULL AND s.sqrt_price_x96>0
  THEN trunc(p.quantity_raw*6277101735386680763835789423207666416102355444464034512896::numeric/(s.sqrt_price_x96*s.sqrt_price_x96))-p.cost_wei END`;
/** The wallet's positions ($1 wallet_ref) with the window's own realized, net
 * and volume per pool summed from its hour rows from the window's first hour
 * ($2, the refresh's own start, so the per-position figures sum to the
 * summary's), each position's mark, and the wallet's unrealized over every
 * supported position beside each row: the sum of their marks, or null while
 * any is unmarked, over the whole set rather than the 500 served. */
const positionsSql = `WITH marked AS (
    SELECT i.pool_id,i.token,i.symbol,i.decimals,i.launch_tx,p.supported,p.flags,
      p.quantity_raw::text AS quantity_raw,p.cost_wei::text AS cost_wei,p.realized_wei::text AS realized_wei,
      p.invested_wei::text AS invested_wei,p.proceeds_wei::text AS proceeds_wei,p.buys,p.sells,
      coalesce(f.realized,0)::text AS window_realized,coalesce(f.net,0)::text AS net,coalesce(f.volume,0)::text AS volume,
      ${markSql} AS mark
    FROM agg_positions p JOIN indexed_pools i USING (pool_ref)
    LEFT JOIN agg_pool_state s ON s.chain_id=p.chain_id AND s.pool_ref=p.pool_ref
    LEFT JOIN (
      SELECT pool_ref,sum(realized_wei) AS realized,sum(proceeds_wei)-sum(spent_wei) AS net,sum(volume_wei) AS volume
      FROM agg_wallet_hours WHERE chain_id=4663 AND wallet_ref=$1 AND hour>=$2 GROUP BY pool_ref
    ) f ON f.pool_ref=p.pool_ref
    WHERE p.chain_id=4663 AND p.wallet_ref=$1
  )
  SELECT m.*,mark::text AS unrealized,
    (SELECT CASE WHEN count(*)=0 OR bool_or(mark IS NULL) THEN NULL ELSE sum(mark)::text END FROM marked WHERE supported) AS wallet_unrealized
  FROM marked m ORDER BY m.pool_id LIMIT 501`;
/** The wallet's position counts and last activity as the window refresh
 * computes them (`positionStats` in `packages/db/src/ledger-windows.ts`), for
 * a wallet the ledger knows that has no hour in the window and so no row in
 * it: its window figures are then zero and its rank none. */
const positionStatsSql = `SELECT count(*) FILTER (WHERE supported AND buys+sells>0)::int AS supported_count,
    count(*) FILTER (WHERE NOT supported)::int AS excluded_count,
    (max(last_timestamp) FILTER (WHERE buys+sells>0))::text AS last
  FROM agg_positions WHERE chain_id=4663 AND wallet_ref=$1`;

/** The wallet page for the window, or null when the ledger has folded
 * nothing yet (no cursor or no pool hour), in which case the accounting
 * tables answer exactly as with the switch off. A window the tip loop has
 * not refreshed since the ledger's last walk-back answers a retryable 503
 * until the next refresh (about a minute), as the board does. */
export async function readLedgerWallet(
  query: ReadQuery,
  address: string,
  window: LiveWindow,
): Promise<AnalyticsWalletResponse | null> {
  const cut = await ledgerCut(query);
  if (!cut) return null;
  const refresh = await ledgerWindowRefresh(
    query,
    cut,
    window,
    "wallet_refresh_pending",
  );
  const coverage = await ledgerCoverage(query, refresh.asOf);
  const ref = (
    await query(
      `SELECT wallet_ref FROM agg_wallets WHERE address=decode($1,'hex')`,
      [address.slice(2)],
    )
  ).rows[0]?.wallet_ref;
  // A wallet the ledger has never attributed a swap or transfer to: the
  // empty profile, as the accounting reader serves one it has no row for.
  const launches = await readLaunches(query, address);
  const response = (
    wallet: AnalyticsWalletResponse["wallet"],
    positions: AnalyticsWalletPosition[],
    positionsTruncated: boolean,
  ): AnalyticsWalletResponse => ({
    coverage,
    window,
    wallet,
    positions,
    trades: [],
    tradesTruncated: false,
    positionsTruncated,
    positionRealizationsIncluded: false,
    curveSampled: false,
    curve: [],
    launches: launches.slice(0, 500).map(catalogPool),
    launchesTruncated: launches.length > 500,
  });
  if (ref === undefined)
    return response(walletSummary(undefined, address), [], false);
  const positions = (await query(positionsSql, [ref, refresh.windowStart]))
    .rows;
  // The summary is the window's row, the board's own figures; a wallet with
  // no hour in the window has none and reads as zero activity in it, with
  // its lifetime position counts and last activity.
  const row =
    (
      await query(
        `SELECT x.rank,${summaryColumns("w.address")} FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
         WHERE x.chain_id=4663 AND x."window"=$1 AND x.wallet_ref=$2`,
        [window, ref],
      )
    ).rows[0] ??
    (await query(positionStatsSql, [ref])).rows.map((r) => ({
      ...r,
      realized: "0",
      net: "0",
      volume: "0",
      disposed_cost: "0",
      complete_window: true,
    }))[0];
  const wallet = walletSummary(
    {
      ...row,
      unrealized: positions[0]?.wallet_unrealized ?? null,
      asof: refresh.asOf,
      oldest: refresh.asOf,
    },
    address,
  );
  return response(
    wallet,
    positions.slice(0, 500).map((p) => ({
      poolId: p.pool_id,
      token: p.token,
      symbol: p.symbol,
      decimals: p.decimals === null ? null : Number(p.decimals),
      launchTx: p.launch_tx,
      asOf: cut.asOf,
      throughBlock: cut.block,
      supported: p.supported,
      flags: p.flags,
      realizedWei: p.supported ? p.window_realized : null,
      netWei: p.supported ? p.net : null,
      unrealizedWei: p.unrealized,
      volumeWei: p.volume,
      position: p.supported
        ? {
            poolId: p.pool_id,
            trader: address as `0x${string}`,
            quantity: p.quantity_raw,
            costWei: p.cost_wei,
            realizedWei: p.realized_wei,
            investedWei: p.invested_wei,
            proceedsWei: p.proceeds_wei,
            buys: p.buys,
            sells: p.sells,
            flags: [],
            realizations: [],
          }
        : null,
    })),
    positions.length > 500,
  );
}
