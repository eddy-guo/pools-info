/** Explorer wallet history served on demand from the Blockscout PRO API.
 * Display only: never accounting or PnL evidence, never joined to positions. */
export type WalletHistoryKind = "transactions" | "token-transfers" | "trades";
export interface WalletHistoryTransaction {
  hash: string;
  /** Null while the transaction is still pending. */
  block: number | null;
  /** Unix seconds; null while pending. */
  timestamp: number | null;
  from: string;
  /** Null for contract creation. */
  to: string | null;
  /** Decoded method name when the explorer knows the ABI, otherwise the
   * 4-byte selector, or null for plain value transfers. */
  method: string | null;
  status: "ok" | "error" | "pending";
  /** Native value in wei, exact decimal string. */
  value: string;
  /** Paid fee in wei, exact decimal string; null while pending. */
  fee: string | null;
}
export interface WalletHistoryTokenTransfer {
  transactionHash: string;
  logIndex: number;
  block: number;
  /** Unix seconds; null when the explorer has not attached a block time. */
  timestamp: number | null;
  from: string;
  to: string;
  token: {
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    /** ERC-20, ERC-721, ERC-1155, or another explorer token type. */
    type: string | null;
  };
  /** Raw integer amount as a decimal string; null for ERC-721 transfers. */
  value: string | null;
  /** Token ID for ERC-721/ERC-1155 transfers, otherwise null. */
  tokenId: string | null;
  method: string | null;
}
/** One ERC-20 leg the wallet settled directly with the v4 PoolManager: the
 * explorer's view of a swap. It carries no ETH figure, because the ETH side
 * of a swap is often paid or received by a router or bot contract rather than
 * the wallet, so the exact amount lives only in the Swap log. */
export interface WalletHistoryTrade {
  transactionHash: string;
  logIndex: number;
  block: number;
  /** Unix seconds; null when the explorer has not attached a block time. */
  timestamp: number | null;
  /** `buy`: the token left the PoolManager for the wallet; `sell`: the wallet
   * paid the token into the PoolManager. */
  side: "buy" | "sell";
  token: WalletHistoryTokenTransfer["token"];
  /** Raw token amount as an exact decimal string; scale by `token.decimals`. */
  tokenRaw: string;
  method: string | null;
}
interface WalletHistoryPage<K extends WalletHistoryKind, T> {
  source: "blockscout";
  chainId: 4663;
  wallet: string;
  kind: K;
  items: T[];
  /** Opaque; pass back as `cursor` to fetch the next page, null at the end. */
  nextCursor: string | null;
  /** ISO time the page was fetched from the explorer. */
  fetchedAt: string;
  /** True when served from cache past its freshness window because the
   * explorer was unavailable or the daily credit budget was spent. */
  stale: boolean;
  note: "Explorer history for display only; not accounting or PnL evidence.";
}
export type WalletHistoryResponse =
  | WalletHistoryPage<"transactions", WalletHistoryTransaction>
  | WalletHistoryPage<"token-transfers", WalletHistoryTokenTransfer>
  | WalletHistoryPage<"trades", WalletHistoryTrade>;
export interface WalletHistoryUnavailable {
  error: "wallet_history_unavailable";
  reason:
    | "not_configured"
    | "budget_exhausted"
    | "upstream_unavailable"
    | "key_rejected";
}
