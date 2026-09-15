import {
  parseFollowingWallets,
  type FollowingActivityResponse,
} from "@pools/core";
import type { ReadQuery } from "./catalog-read";
import { RequestError } from "./request";

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
        FROM analytics_accounting_trades t
        JOIN analytics_accounting_positions position USING(chain_id,pool_id,wallet)
        JOIN analytics_accounting_pools a USING(chain_id,pool_id)
        JOIN analytics_pool_snapshots s USING(chain_id,pool_id)
        JOIN indexed_pools p USING(chain_id,pool_id)
        WHERE t.chain_id=4663 AND t.wallet=w.wallet AND t.execution_supported
          AND position.supported AND cardinality(position.flags)=0
          AND a.through_block=s.through_block AND a.through_hash=s.through_hash
          AND a.generated_at=s.generated_at AND a.asof_timestamp=s.asof_timestamp
          AND a.from_block=p.launch_block AND a.market->>'id'=p.pool_id
          AND a.market->>'token'=p.token
          AND t.block_number BETWEEN a.from_block AND a.through_block
          AND t.timestamp BETWEEN a.from_timestamp AND a.asof_timestamp
          AND NOT EXISTS (SELECT 1 FROM recent_pools r WHERE r.chain_id=p.chain_id AND r.pool_id=p.pool_id
            AND (r.token,r.launch_block,r.launch_tx,r.launch_sender,r.launched_at)
              IS DISTINCT FROM (p.token,p.launch_block,p.launch_tx,p.launch_sender,p.launched_at))
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
