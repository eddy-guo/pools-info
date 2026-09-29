import type { LiveWindow, WalletPositionResponse } from "@pools/core";
import { catalogCte, type ReadQuery } from "./catalog-read";
import { catalogPool } from "./explore-read";
import { ledgerCoverage, ledgerWindowRefresh } from "./ledger-leaderboard";
import { ledgerCut, ledgerPriceSql, ledgerUnitsConflict } from "./ledger-market";
import {
  counterpartyFlags,
  positionColumns,
  positionSources,
  walletPosition,
  windowFlowColumns,
} from "./ledger-wallet";
import { RequestError } from "./request";

/** One wallet-position from the aggregate ledger (`MARKET_SOURCE=ledger`,
 * docs/LEDGER-MARKET-SERVING.md "A single position"), the read behind the
 * position PnL card: `GET /v1/wallets/:address/positions/:poolId?window=`.
 * `position` is the wallet page's row for that pool, field for field
 * (`walletPosition` over the same columns, the same cut and the same window
 * start), so a consumer of the page reuses its type; beside it sits what a
 * card needs and the ledger can vouch for: the price state behind the mark,
 * the ledger's ROI and the position's inventory cycles.
 * Each is null where the ledger has nothing to stand on (an excluded
 * position's finances, an unmarked position's value, a percent of a zero
 * basis), never a stand-in. The pool is the catalog row the card names it by. */

/** $1 wallet_ref, $2 the window's first hour, $3 pool_ref: the wallet page's
 * columns for this one position (a primary-key probe of `agg_positions`), the
 * price state's identity and its price per whole token (`ledgerPriceSql`, the
 * pool page's figure), the fold's disposed cost, and from
 * one primary-key range of `agg_wallet_hours` the window's flow, the hours
 * traded in and the position's lifetime closures. */
export const positionSql = `WITH marked AS (
    SELECT ${positionColumns},
      p.disposed_cost_wei::text AS disposed_cost,
      s.sqrt_price_x96::text AS sqrt_price_x96,s.price_block::text AS price_block,s.price_timestamp::text AS price_timestamp,
      '0x'||encode(s.price_tx,'hex') AS price_tx,${ledgerPriceSql("s.sqrt_price_x96", "i.decimals")}::text AS price_wei,
      f.closures,f.hold_seconds
    FROM ${positionSources}
    LEFT JOIN LATERAL (
      SELECT ${windowFlowColumns},coalesce(sum(closures),0)::int AS closures,
        coalesce(sum(hold_seconds),0)::text AS hold_seconds
      FROM agg_wallet_hours WHERE chain_id=4663 AND wallet_ref=$1 AND pool_ref=$3
    ) f ON true
    WHERE p.chain_id=4663 AND p.wallet_ref=$1 AND p.pool_ref=$3
  ) SELECT m.*,CASE WHEN $4::boolean THEN NULL ELSE mark::text END AS unrealized FROM marked m`;

/** A percent to four decimals, truncated toward zero in integer arithmetic as
 * `walletSummary` computes the board's ROI; null over a zero denominator,
 * never a percent of nothing. */
const percent = (numerator: bigint, denominator: bigint) =>
  denominator > 0n
    ? Number((numerator * 1000000n) / denominator) / 10000
    : null;

/** The position, or a 404 in the api's usual shape: `pool_not_indexed` for a
 * pool the catalog lacks (as the pool route answers), `wallet_not_found` for
 * a wallet the ledger has never attributed a swap or transfer to, and
 * `position_not_found` when the wallet never held or traded this pool's token.
 * A deployment whose ledger has folded nothing answers 503
 * `position_coverage_unavailable` rather than the frozen accounting tables,
 * and a window the tip loop has not refreshed since the ledger's last
 * walk-back 503 `position_refresh_pending` until the next refresh (about a
 * minute), as the wallet page does. */
export async function readLedgerPosition(
  query: ReadQuery,
  address: string,
  poolId: string,
  window: LiveWindow,
): Promise<WalletPositionResponse> {
  const cut = await ledgerCut(query);
  if (!cut) throw new RequestError(503, "position_coverage_unavailable");
  // The pool by the id the pool page uses, with the ledger's surrogate key.
  const pool = (
    await query(
      `${catalogCte} SELECT c.*,i.pool_ref,i.decimals,
        a.through_block AS verified_block,a.snapshot->'markets'->0->>'decimals' AS verified_decimals
      FROM catalog c
      LEFT JOIN indexed_pools i ON i.chain_id=c.chain_id AND i.pool_id=c.pool_id
      LEFT JOIN analytics_pool_snapshots a ON a.chain_id=c.chain_id AND a.pool_id=c.pool_id
      WHERE c.chain_id=4663 AND c.pool_id=$1`,
      [poolId],
    )
  ).rows[0];
  if (!pool) throw new RequestError(404, "pool_not_indexed");
  const ref = (
    await query(
      `SELECT wallet_ref FROM agg_wallets WHERE address=decode($1,'hex')`,
      [address.slice(2)],
    )
  ).rows[0]?.wallet_ref;
  if (ref === undefined) throw new RequestError(404, "wallet_not_found");
  // A catalog row the ledger has no key for (a recent discovery the indexer
  // never saved) has no position under it.
  if (pool.pool_ref === null) throw new RequestError(404, "position_not_found");
  const verifiedDecimals =
    pool.verified_decimals === null ? null : Number(pool.verified_decimals);
  if (
    verifiedDecimals !== null &&
    (!Number.isSafeInteger(verifiedDecimals) || verifiedDecimals < 0)
  )
    throw new RequestError(503, "market_evidence_invalid");
  const decimals = pool.decimals === null ? null : Number(pool.decimals);
  const unitsConflict = ledgerUnitsConflict(
    decimals,
    verifiedDecimals === null
      ? null
      : { decimals: verifiedDecimals, block: Number(pool.verified_block) },
    Math.max(cut.startBlock, Number(pool.launch_block)),
    cut.block,
  );
  const priceUnavailable = unitsConflict || decimals === null || decimals > 36;
  const refresh = await ledgerWindowRefresh(
    query,
    cut,
    window,
    "position_refresh_pending",
  );
  const row = (
    await query(positionSql, [ref, refresh.windowStart, pool.pool_ref, priceUnavailable])
  ).rows[0];
  if (!row) throw new RequestError(404, "position_not_found");
  const coverage = await ledgerCoverage(query, refresh.asOf);
  const attributed = await counterpartyFlags(query, address);
  const position = walletPosition(
    row,
    address,
    cut,
    attributed.get(Number(row.pool_ref)),
  );
  // The mark is served only for a supported, marked position, so the value
  // and the total return below are null for an excluded or unmarked one.
  const unrealized =
    position.unrealizedWei === null ? null : BigInt(position.unrealizedWei);
  // The held units' average cost per whole token, exact and truncated: the
  // entry price of what the position still holds under average-cost
  // accounting. A lifetime entry or exit average would need the raw tokens
  // bought or sold, which the ledger does not keep, so none is served.
  const held = position.position;
  const avgEntryPriceWei =
    held && held.quantity !== "0" && position.decimals !== null && !priceUnavailable
      ? (
          (BigInt(held.costWei) * 10n ** BigInt(position.decimals)) /
          BigInt(held.quantity)
        ).toString()
      : null;
  const openedAt =
    row.cycle_opened_at === null ? null : Number(row.cycle_opened_at);
  return {
    coverage,
    window,
    wallet: address,
    pool: catalogPool(pool),
    position,
    mark:
      row.sqrt_price_x96 === null
        ? null
        : {
            sqrtPriceX96: row.sqrt_price_x96,
            priceWei: priceUnavailable ? null : row.price_wei,
            block: Number(row.price_block),
            timestamp: Number(row.price_timestamp),
            txHash: row.price_tx,
            valueWei:
              unrealized === null
                ? null
                : (unrealized + BigInt(row.cost_wei)).toString(),
          },
    roi: position.supported
      ? percent(BigInt(row.realized_wei), BigInt(row.disposed_cost))
      : null,
    totalRoi:
      unrealized === null
        ? null
        : percent(
            BigInt(row.realized_wei) + unrealized,
            BigInt(row.invested_wei),
          ),
    avgEntryPriceWei,
    cycles: position.supported
      ? {
          openedAt,
          openHoldSeconds:
            openedAt === null ? null : Math.max(0, cut.asOf - openedAt),
          closures: row.closures,
          holdSeconds: Number(row.hold_seconds),
        }
      : null,
  };
}
