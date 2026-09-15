/** Independent recent-chain observations. Never an accounting/PnL history. */
export interface LiveTradeEvent {
  id: string;
  poolId: string;
  token: string;
  name: string;
  symbol: string;
  launchTx: string;
  transactionHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  /** Unix seconds, from the saved canonical block header. */
  timestamp: number;
  side: "buy" | "sell";
  ethWei: string;
  tokenRaw: string;
  transactionInitiator: string | null;
  attribution: "transaction_initiator_only";
}
export interface LiveTradeFeedResponse {
  source: "indexed_recent_chain_events";
  generatedAt: string;
  poolId: string | null;
  events: LiveTradeEvent[];
  truncated: boolean;
  /** Replace the previous window on every poll, including when this is empty. */
  replacement: true;
  coverage: {
    state: "uninitialized" | "current" | "stale";
    scope: "verified_pools_launches_only";
    registryExhaustive: false;
    pnlAvailable: false;
    startBlock: number | null;
    headBlock: number | null;
    throughBlock: number | null;
    throughHash: string | null;
    /** Unix seconds; chain cutoff time, not last trade time. */
    asOf: number | null;
    /** ISO timestamp of the worker's latest successful head check. */
    checkedAt: string | null;
    lagBlocks: number | null;
    discoveryThroughBlock: number | null;
    discoveryLagBlocks: number | null;
    knownPools: number;
    staleAfterSeconds: number;
  };
}
