import {
  ledgerHour,
  type AnalyticsWalletPosition,
  type AnalyticsWalletResponse,
  type LiveWindow,
  type PricePoint,
} from "@pools/core";
import { readLaunches, walletSummary } from "./accounting-read";
import type { ReadQuery } from "./catalog-read";
import { catalogPool } from "./explore-read";
import {
  ledgerCoverage,
  ledgerWindowRefresh,
  ledgerRealizedRanksSql,
  summaryColumns,
} from "./ledger-leaderboard";
import { ledgerCut, type LedgerCut } from "./ledger-market";

/** The wallet page from the aggregate ledger (`MARKET_SOURCE=ledger`,
 * docs/LEDGER-MARKET-SERVING.md "The wallet page"): the header and the
 * window's figures from the wallet's `agg_wallet_windows` row, with its rank
 * read from the current trader board, so the profile's headline equals the board's
 * row to the wei at the same cursor for every wallet with no position in its
 * own launches (the board leaves those out, the profile keeps them), and the
 * positions from `agg_positions`, the fold's whole state
 * per pool, marked at each pool's latest price state, and the realized curve
 * from `agg_wallet_hours`, the wallet's realized per pool per UTC hour. The
 * response is the accounting reader's, field for field; what the ledger does
 * not keep is served empty rather than from the frozen tables: there is no
 * row per sale (design decision D3), so `trades` is empty. */

/** The mark of a supported position: what its held units fetch at the pool's
 * latest price state, less their cost, exact to the wei and truncated toward
 * zero as `ledgerPriceSql` prices a whole token (`2^192 / sqrt^2` wei per raw
 * unit, the decimals cancelling). A flat position marks at zero less its
 * cost (zero under the fold's invariant) whatever the pool's price; a held
 * one is unmarked, null, while the pool's decimals are unknown or it has no
 * price state, and an excluded position's finances are never served. */
export const markSql = `CASE WHEN NOT p.supported THEN NULL WHEN p.quantity_raw=0 THEN -p.cost_wei
  WHEN i.decimals IS NOT NULL AND s.sqrt_price_x96>0
  THEN trunc(p.quantity_raw*6277101735386680763835789423207666416102355444464034512896::numeric/(s.sqrt_price_x96*s.sqrt_price_x96))-p.cost_wei END`;
/** The row the wallet page serves per position and the single-position read
 * (`ledger-position.ts`) serves for one pool: the identity from
 * `indexed_pools i`, the fold's state, flags and open cycle from
 * `agg_positions p`, the window's realized, net and volume and the hours it
 * traded in from the hour rows `f` (`windowFlowColumns`; a position with no
 * hour in the window has no flow in it and reads as zero) and the mark from
 * the price state `s`. Both reads select these columns from
 * `positionSources`, so the two answers agree field for field. */
export const positionColumns = `p.pool_ref,i.pool_id,i.token,i.symbol,i.decimals,i.launch_tx,p.supported,p.flags,
      p.quantity_raw::text AS quantity_raw,p.cost_wei::text AS cost_wei,p.realized_wei::text AS realized_wei,
      p.invested_wei::text AS invested_wei,p.proceeds_wei::text AS proceeds_wei,p.buys,p.sells,
      p.cycle_opened_at::text AS cycle_opened_at,f.first_hour,f.last_hour,
      coalesce(f.realized,0)::text AS window_realized,coalesce(f.net,0)::text AS net,coalesce(f.volume,0)::text AS volume,
      ${markSql} AS mark`;
export const positionSources = `agg_positions p JOIN indexed_pools i USING (pool_ref)
    LEFT JOIN agg_pool_state s ON s.chain_id=p.chain_id AND s.pool_ref=p.pool_ref`;
/** One pass over a wallet's hour rows: the window's flow, realized, net
 * (proceeds less spent) and volume over the hours from the window's first
 * hour ($2), beside the first and last hour the position traded in at all,
 * the honest bounds of its span, since the ledger keeps swaps per hour and no
 * first swap time. The window bound sits in the aggregates rather than the
 * scan on purpose: a `hour>=$2` predicate under the scan steered the planner
 * onto migration 026's pool-first index, 1,490 index searches and 9k buffers
 * for a 358-position wallet, where one primary-key range reads 414. */
export const windowFlowColumns = `sum(realized_wei) FILTER (WHERE hour>=$2) AS realized,
      sum(proceeds_wei) FILTER (WHERE hour>=$2)-sum(spent_wei) FILTER (WHERE hour>=$2) AS net,
      sum(volume_wei) FILTER (WHERE hour>=$2) AS volume,min(hour) AS first_hour,max(hour) AS last_hour`;
/** The wallet's positions ($1 wallet_ref) with the window's own realized, net
 * and volume per pool summed from its hour rows from the window's first hour
 * ($2, the refresh's own start, so the per-position figures sum to the
 * summary's) and the hours it traded in, each position's mark, and the
 * wallet's unrealized over every supported position beside each row: the sum
 * of their marks, or null while any is unmarked, over the whole set rather
 * than the 500 served. */
const positionsSql = `WITH marked AS (
    SELECT ${positionColumns}
    FROM ${positionSources}
    LEFT JOIN (
      SELECT pool_ref,${windowFlowColumns}
      FROM agg_wallet_hours WHERE chain_id=4663 AND wallet_ref=$1 GROUP BY pool_ref
    ) f ON f.pool_ref=p.pool_ref
    WHERE p.chain_id=4663 AND p.wallet_ref=$1
  )
  SELECT m.*,mark::text AS unrealized,
    (SELECT CASE WHEN count(*)=0 OR bool_or(mark IS NULL) THEN NULL ELSE sum(mark)::text END FROM marked WHERE supported) AS wallet_unrealized
  FROM marked m ORDER BY m.pool_id LIMIT 501`;
/** A served position row (`positionColumns` with `mark::text AS unrealized`)
 * as the wallet page publishes it, with the read-time counterparty flags for
 * its pool appended to the fold's: `asOf` and `throughBlock` are the ledger
 * cut on every position, `decimals` is the catalog's, null when unread and
 * never defaulted, and an excluded position serves its counts and volume and
 * null for every finance and for `position`. A supported position's block
 * carries its times beside the fold's state: `openedAt`, when its open cycle
 * began (null while flat), and `firstHour` and `lastHour`, the hours of its
 * first and last swap at the hour's start. */
export function walletPosition(
  p: Record<string, any>,
  address: string,
  cut: LedgerCut,
  counterparty: readonly string[] = [],
): AnalyticsWalletPosition {
  return {
    poolId: p.pool_id,
    token: p.token,
    symbol: p.symbol,
    decimals: p.decimals === null ? null : Number(p.decimals),
    launchTx: p.launch_tx,
    asOf: cut.asOf,
    throughBlock: cut.block,
    supported: p.supported,
    flags: [...p.flags, ...counterparty],
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
          openedAt:
            p.cycle_opened_at === null ? null : Number(p.cycle_opened_at),
          firstHour: p.first_hour === null ? null : Number(p.first_hour) * 3600,
          lastHour: p.last_hour === null ? null : Number(p.last_hour) * 3600,
        }
      : null,
  };
}
/** The wallet's cumulative realized over the window ($1 wallet_ref, hours
 * from $2, the refresh's own start, through $3, the refresh's hour), one
 * point per hour with a sale on a supported position, summed across pools:
 * the accounting reader's per-sale curve at the ledger's hour grain, and the
 * same rule as the header, since an excluded position's hours carry no
 * finance (`ledgerExcludingFlags`, migration 022) and are left out here
 * rather than drawn as flat points. Sampled as the accounting reader samples
 * its sales, every k-th hour and the last, to about 500 points. */
const curveSql = `WITH hours AS (
    SELECT h.hour,sum(h.realized_wei) AS realized
    FROM agg_wallet_hours h JOIN agg_positions p ON p.chain_id=h.chain_id AND p.wallet_ref=h.wallet_ref AND p.pool_ref=h.pool_ref
    WHERE h.chain_id=4663 AND h.wallet_ref=$1 AND h.hour>=$2 AND h.hour<=$3 AND p.supported AND h.sells>0
    GROUP BY h.hour
  ), gains AS (
    SELECT hour,sum(realized) OVER (ORDER BY hour ROWS UNBOUNDED PRECEDING) AS cumulative,
      row_number() OVER (ORDER BY hour) AS n,count(*) OVER () AS total
    FROM hours
  ) SELECT hour,cumulative::text AS cumulative,total FROM gains
  WHERE mod(n-1,greatest(1,ceil(total/498.0)::bigint))=0 OR n=total ORDER BY n`;
/** The first hour the wallet traded a supported position in, the All
 * curve's start as the accounting reader's is its first capture. */
const firstHourSql = `SELECT min(h.hour) AS hour FROM agg_wallet_hours h JOIN agg_positions p ON p.chain_id=h.chain_id AND p.wallet_ref=h.wallet_ref AND p.pool_ref=h.pool_ref
  WHERE h.chain_id=4663 AND h.wallet_ref=$1 AND h.hour<=$2 AND p.supported`;
/** The wallet's position counts and last activity as the window refresh
 * computes them (`positionStats` in `packages/db/src/ledger-windows.ts`), for
 * a wallet the ledger knows that has no hour in the window and so no row in
 * it: its window figures are then zero and its rank none. */
const positionStatsSql = `SELECT count(*) FILTER (WHERE supported AND buys+sells>0)::int AS supported_count,
    count(*) FILTER (WHERE NOT supported)::int AS excluded_count,
    (max(last_timestamp) FILTER (WHERE buys+sells>0))::text AS last
  FROM agg_positions WHERE chain_id=4663 AND wallet_ref=$1`;

/** Additive read-time attribution from retained raw transfer endpoints and the
 * append-only positive-evidence registry. The registry is optional until the
 * attended provenance activation. No row means no classification, and these
 * advisory flags never affect support, basis or a financial figure. */
export async function counterpartyFlags(query: ReadQuery, address: string) {
  const ready = await query(
    `SELECT to_regclass('agg_transfer_provenance') IS NOT NULL AS provenance,
      to_regclass('agg_transfer_counterparty_registry') IS NOT NULL AS registry`,
  );
  if (!ready.rows[0].provenance || !ready.rows[0].registry)
    return new Map<number, string[]>();
  const rows = (
    await query(
      `WITH legs AS (
         SELECT pool_ref,to_address AS counterparty,block_number
         FROM agg_transfer_provenance
         WHERE chain_id=4663 AND from_address=decode($1,'hex')
           AND from_address<>to_address AND token_raw>0
         UNION ALL
         SELECT pool_ref,from_address AS counterparty,block_number
         FROM agg_transfer_provenance
         WHERE chain_id=4663 AND to_address=decode($1,'hex')
           AND from_address<>to_address AND token_raw>0
       )
       SELECT l.pool_ref,array_agg(DISTINCT r.class ORDER BY r.class) AS classes
       FROM legs l JOIN agg_transfer_counterparty_registry r
         ON r.chain_id=4663 AND r.address=l.counterparty
        AND l.block_number>=r.valid_from_block
        AND (r.valid_through_block IS NULL OR l.block_number<=r.valid_through_block)
       GROUP BY l.pool_ref`,
      [address.slice(2)],
    )
  ).rows;
  return new Map<number, string[]>(
    rows.map((row) => [
      Number(row.pool_ref),
      ["wrapper", "farm"]
        .filter((kind) => row.classes.includes(kind))
        .map((kind) => `${kind}_counterparty`),
    ]),
  );
}

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
    curve: PricePoint[],
    curveSampled: boolean,
  ): AnalyticsWalletResponse => ({
    coverage,
    window,
    wallet,
    positions,
    trades: [],
    tradesTruncated: false,
    positionsTruncated,
    positionRealizationsIncluded: false,
    curveSampled,
    curve,
    launches: launches.slice(0, 500).map(catalogPool),
    launchesTruncated: launches.length > 500,
  });
  if (ref === undefined)
    return response(walletSummary(undefined, address), [], false, [], false);
  const positions = (await query(positionsSql, [ref, refresh.windowStart]))
    .rows;
  const attributed = await counterpartyFlags(query, address);
  // The summary is the wallet's own window row and current board rank; a wallet with
  // no hour in the window has none and reads as zero activity in it, with
  // its lifetime position counts and last activity.
  const row =
    (
      await query(
        `SELECT (SELECT b.rank FROM (${ledgerRealizedRanksSql}) b WHERE b.wallet_ref=x.wallet_ref) AS rank,${summaryColumns("w.address")} FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
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
  // The curve, as the accounting reader draws it: a leading zero at the
  // window's start (the All window's at the wallet's first supported hour),
  // the cumulative realized at the end of each hour with a sale, and the
  // header's own figure at the window's cutoff, so the chart's end equals the
  // headline; nothing for a wallet with no supported position. An hour's
  // point sits at its end, never before its sales, and the refresh's own
  // hour, still open at the cutoff, ends at the cutoff.
  const through = ledgerHour(refresh.asOf);
  const curveRows = wallet.supportedPositionCount
    ? (await query(curveSql, [ref, refresh.windowStart, through])).rows
    : [];
  const curve: PricePoint[] = curveRows.map((p) => ({
    time: Math.min((Number(p.hour) + 1) * 3600, refresh.asOf),
    wei: p.cumulative,
  }));
  if (wallet.supportedPositionCount) {
    const first =
      window === "All"
        ? (await query(firstHourSql, [ref, through])).rows[0].hour
        : refresh.windowStart;
    curve.unshift({
      time: first === null ? refresh.asOf : Number(first) * 3600,
      wei: "0",
    });
    curve.push({ time: refresh.asOf, wei: wallet.realizedWei! });
  }
  return response(
    wallet,
    positions
      .slice(0, 500)
      .map((p) =>
        walletPosition(p, address, cut, attributed.get(Number(p.pool_ref))),
      ),
    positions.length > 500,
    curve,
    Number(curveRows[0]?.total ?? 0) > curveRows.length,
  );
}
