import {
  parseFollowingWallets,
  type FollowingActivityResponse,
} from "@pools/core";
import type { ReadQuery } from "./catalog-read";
import { RequestError } from "./request";
import {
  verifiedActivityFrom,
  verifiedActivityConditions,
} from "./verified-activity";

/** Bounded, attributed deep history only. No transaction-initiator lookup or RPC. */
export async function readFollowing(
  query: ReadQuery,
  wallets: readonly string[],
  limit = 50,
): Promise<FollowingActivityResponse> {
  const selected = parseFollowingWallets(wallets.join(","));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new RequestError(400, "invalid_limit");
  // Each indexed wallet contributes at most limit+1 rows before the global merge.
  // Duplicate canonical event identities are prevented by the accounting table's
  // UNIQUE(chain_id,transaction_hash,log_index) constraint.
  const rows = selected.length
    ? (
        await query(
          `
    WITH requested AS (SELECT unnest($1::text[]) AS wallet), candidates AS (
      SELECT selected.* FROM requested w CROSS JOIN LATERAL (
        SELECT t.wallet,t.pool_id,p.token,a.market->>'symbol' AS symbol,
          a.market->>'decimals' AS decimals,t.transaction_hash,t.log_index,
          t.block_number,t.timestamp,t.side,t.eth_wei::text,t.token_raw::text,
          a.asof_timestamp,a.through_block
        ${verifiedActivityFrom}
        WHERE t.wallet=w.wallet AND ${verifiedActivityConditions}
        ORDER BY t.timestamp DESC,t.block_number DESC,t.log_index DESC,t.transaction_hash DESC
        LIMIT $2
      ) selected
    ) SELECT * FROM candidates
    ORDER BY timestamp DESC,block_number DESC,log_index DESC,transaction_hash DESC
    LIMIT $2`,
          [selected, limit + 1],
        )
      ).rows
    : [];
  const items: FollowingActivityResponse["items"] = rows
    .slice(0, limit)
    .map((row) => {
      const decimals = Number(row.decimals);
      if (
        row.decimals === null ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 36 ||
        !/^[1-9][0-9]*$/.test(row.eth_wei) ||
        !/^[1-9][0-9]*$/.test(row.token_raw)
      )
        throw new RequestError(503, "following_projection_invalid");
      return {
        id: `${row.transaction_hash}:${row.log_index}`,
        wallet: row.wallet,
        poolId: row.pool_id,
        token: row.token,
        symbol: String(row.symbol),
        decimals,
        txHash: row.transaction_hash,
        logIndex: Number(row.log_index),
        block: Number(row.block_number),
        timestamp: Number(row.timestamp),
        side: row.side,
        ethWei: row.eth_wei,
        tokenRaw: row.token_raw,
        priceWei: (
          (BigInt(row.eth_wei) * 10n ** BigInt(decimals)) /
          BigInt(row.token_raw)
        ).toString(),
        asOf: Number(row.asof_timestamp),
        throughBlock: Number(row.through_block),
        supported: true,
      };
    });
  const cutoffs = items.map((item) => item.asOf);
  return {
    items,
    hasMore: rows.length > limit,
    scope: "saved_verified_positions",
    notice:
      "Saved trades with verified wallet attribution and supported position history. Coverage is partial; publication dates are not proof of current-chain freshness.",
    coverage: {
      requestedWallets: selected.length,
      returnedPools: new Set(items.map((item) => item.poolId)).size,
      asOf: cutoffs.length ? Math.max(...cutoffs) : null,
      oldestAsOf: cutoffs.length ? Math.min(...cutoffs) : null,
      generatedAt: new Date().toISOString(),
      complete: false,
      registryExhaustive: false,
    },
  };
}
