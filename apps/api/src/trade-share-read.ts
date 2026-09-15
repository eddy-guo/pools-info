import type { TradeShareResponse } from "@pools/core";
import type { ReadQuery } from "./catalog-read";
import { RequestError } from "./request";
import {
  verifiedActivityFrom,
  verifiedActivityConditions,
} from "./verified-activity";

/** Fetch the persisted sale realization by exact event and proven beneficiary.
 * A profile's truncated trade list is never an accounting reconstruction source. */
export async function readTradeShare(
  query: ReadQuery,
  identity: {
    poolId: string;
    txHash: string;
    logIndex: number;
    wallet: string;
  },
): Promise<TradeShareResponse> {
  if (
    !/^0x[0-9a-f]{64}$/.test(identity.poolId) ||
    !/^0x[0-9a-f]{64}$/.test(identity.txHash) ||
    !/^0x[0-9a-f]{40}$/.test(identity.wallet) ||
    !Number.isInteger(identity.logIndex) ||
    identity.logIndex < 0 ||
    identity.logIndex > 2147483647
  )
    throw new RequestError(400, "invalid_trade_identity");
  const row = (
    await query(
      `
    SELECT t.wallet,t.pool_id,p.token,a.market->>'symbol' AS symbol,
      a.market->>'decimals' AS decimals,t.transaction_hash,t.log_index,
      t.block_number,t.timestamp,t.eth_wei::text,t.token_raw::text,
      t.realized_wei::text,t.disposed_cost_wei::text,a.asof_timestamp,a.through_block
    ${verifiedActivityFrom}
    WHERE ${verifiedActivityConditions}
      AND t.pool_id=$1 AND t.transaction_hash=$2 AND t.log_index=$3 AND t.wallet=$4
      AND t.side='sell' AND t.realized_wei IS NOT NULL AND t.disposed_cost_wei IS NOT NULL
    LIMIT 1`,
      [identity.poolId, identity.txHash, identity.logIndex, identity.wallet],
    )
  ).rows[0];
  if (!row) throw new RequestError(404, "trade_share_unavailable");
  const decimals = Number(row.decimals);
  if (
    row.decimals === null ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !/^[1-9][0-9]*$/.test(row.eth_wei) ||
    !/^[1-9][0-9]*$/.test(row.token_raw) ||
    !/^-?(0|[1-9][0-9]*)$/.test(row.realized_wei) ||
    !/^(0|[1-9][0-9]*)$/.test(row.disposed_cost_wei) ||
    BigInt(row.realized_wei) !==
      BigInt(row.eth_wei) - BigInt(row.disposed_cost_wei)
  )
    throw new RequestError(503, "trade_share_projection_invalid");
  return {
    trade: {
      wallet: row.wallet,
      poolId: row.pool_id,
      token: row.token,
      symbol: String(row.symbol),
      decimals,
      txHash: row.transaction_hash,
      logIndex: Number(row.log_index),
      block: Number(row.block_number),
      timestamp: Number(row.timestamp),
      side: "sell",
      ethWei: row.eth_wei,
      tokenRaw: row.token_raw,
      realizedWei: row.realized_wei,
      disposedCostWei: row.disposed_cost_wei,
      asOf: Number(row.asof_timestamp),
      throughBlock: Number(row.through_block),
      supported: true,
    },
    scope: "saved_verified_sale",
    coverage: { complete: false, registryExhaustive: false },
  };
}
