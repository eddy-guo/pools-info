import type { WalletHistoryUnavailable } from "./wallet-history-types";
/** No accounts are created: callers supply their local list on every read. */
export function parseFollowingWallets(value: string | null): string[] {
  if (value === null || value === "") return [];
  if (value.length > 8599) throw Error("invalid_wallets");
  const wallets = value.split(",").map((s) => s.toLowerCase());
  if (
    wallets.length > 200 ||
    wallets.some((s) => !/^0x[0-9a-f]{40}$/.test(s)) ||
    new Set(wallets).size !== wallets.length
  )
    throw Error("invalid_wallets");
  return wallets.sort();
}

export interface FollowingActivityItem {
  id: string;
  wallet: string;
  poolId: string;
  token: string;
  symbol: string;
  decimals: number;
  txHash: string;
  logIndex: number;
  block: number;
  timestamp: number;
  side: "buy" | "sell";
  ethWei: string;
  tokenRaw: string;
  /** Execution-average ETH wei per whole token, rounded down exactly. */
  priceWei: string | null;
  asOf: number;
  throughBlock: number;
  supported: true;
}

export interface FollowingActivityResponse {
  items: FollowingActivityItem[];
  hasMore: boolean;
  scope: "saved_verified_positions";
  notice: string;
  coverage: {
    requestedWallets: number;
    returnedPools: number;
    /** Publication cutoffs of returned items only, not all followed wallets. */
    asOf: number | null;
    oldestAsOf: number | null;
    generatedAt: string;
    complete: false;
    registryExhaustive: false;
  };
}

/** One followed wallet's trade as the explorer lists it: the wallet's ERC-20
 * leg against the PoolManager in a token of the verified registry. It carries
 * no ETH amount and no price; those are not in the explorer's transfer. */
export interface FollowingTrade {
  /** `txHash:logIndex`, unique in a response. */
  id: string;
  wallet: string;
  /** The registry's pool for the token; null when the registry holds more
   * than one pool for it. */
  poolId: string | null;
  token: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  txHash: string;
  logIndex: number;
  block: number;
  /** Unix seconds; null when the explorer has not attached a block time. */
  timestamp: number | null;
  side: "buy" | "sell";
  /** Raw token amount as an exact decimal string; scale by `decimals`. */
  tokenRaw: string;
  method: string | null;
}
/** What the answer holds for one requested wallet. `read`: its first explorer
 * page as of `fetchedAt`. `stale`: the last refresh failed for `reason` and
 * the page from `fetchedAt` is served. `pending`: not read yet, since one
 * answer reads a bounded number of wallets; a later poll reads it.
 * `unavailable`: the read failed for `reason` and nothing was ever read. */
export interface FollowingWalletCoverage {
  wallet: string;
  status: "read" | "stale" | "pending" | "unavailable";
  fetchedAt: string | null;
  reason: WalletHistoryUnavailable["reason"] | null;
  /** The explorer holds older transfers than the page read. */
  olderTrades: boolean;
  /** Where the page read ends when `olderTrades`: this wallet's trades at or
   * below this block may be missing from the items, while other wallets'
   * trades there are listed. Null when the page reaches the wallet's first
   * transfer, or when nothing was read. */
  horizonBlock: number | null;
}
/** `GET /v1/following`: each followed wallet's newest explorer trades in
 * verified-registry tokens, merged newest first. */
export interface FollowingTradesResponse {
  source: "blockscout";
  scope: "explorer_registry_trades";
  items: FollowingTrade[];
  /** More trades exist than the items: the merge was cut at `limit`, or a
   * wallet's explorer page ends before its first transfer. */
  hasMore: boolean;
  notice: string;
  note: "Explorer history for display only; not accounting or PnL evidence.";
  coverage: {
    requestedWallets: number;
    /** Distinct tokens among the items. */
    returnedTokens: number;
    wallets: FollowingWalletCoverage[];
    generatedAt: string;
    complete: false;
    registryExhaustive: false;
  };
}
