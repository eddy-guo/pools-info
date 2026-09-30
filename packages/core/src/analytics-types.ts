import type { MarketBoundary, ObservedMarket } from "./observed-market";
import type { CatalogPool } from "./catalog";
import type { ChainSnapshot, ChainMarket, PoolAudit } from "./chain-types";
import type { HolderLedger } from "./holders";
import type { LiveWindow } from "./live-analytics";
import type { ObservedExecution } from "./chain-accounting";
import type { Position, PricePoint } from "./types";

export interface AnalyticsPublication {
  snapshot: ChainSnapshot;
  holders: HolderLedger | null;
  liquidityWei: string | null;
  sourceKind: "indexed" | "rpc_capture" | "preloaded";
  generatedAt: string;
}
export interface AnalyticsCoverage {
  catalogPools: number;
  processedPools: number;
  asOf: number;
  oldestAsOf: number | null;
  generatedAt: string;
  complete: false;
  registryExhaustive: false;
  pnlScope:
    | "supported_pool_positions_only"
    | "observed_initiator_and_verified_positions"
    | "attributed_positions_all_pools";
  tier2Pools?: number;
  tier3Pools?: number;
  realizedPools?: number;
}
export interface AnalyticsPoolStats {
  priceWei: string | null;
  volumeWei: string | null;
  liquidityWei: string | null;
  change: number | null;
  trades: number | null;
  holders: number | null;
  completeWindow: boolean;
}
export interface AnalyticsPoolRow extends CatalogPool {
  marketCoverage?: {
    source: "canonical_broad" | "deep_publication" | "aggregate_ledger";
    startBlock: number;
    cutoff: MarketBoundary;
    windowStart: number;
    indexedAt: string;
    unitsConflict: boolean;
    unitBasis: ObservedMarket["coverage"]["unitBasis"];
    rawPrice: (MarketBoundary & { sqrtPriceX96: string }) | null;
    priceBaseline: MarketBoundary | null;
  } | null;
  processed: boolean;
  market: ChainMarket | null;
  stats: AnalyticsPoolStats;
  asOf: number | null;
  throughBlock: number | null;
  generatedAt: string | null;
  sourceKind: AnalyticsPublication["sourceKind"] | null;
}
export interface AnalyticsPoolDetail extends AnalyticsPublication {
  audit: PoolAudit | null;
  stats: AnalyticsPoolStats;
  coverage: AnalyticsCoverage;
}
export interface AnalyticsExploreOptions {
  window?: LiveWindow;
  sort?: "volume" | "trades" | "change" | "launch" | "liquidity";
  direction?: "asc" | "desc";
  view?: "all" | "gainers" | "new" | "crowd" | "watchlist";
  ids?: string[];
  q?: string;
  offset?: number;
  limit?: number;
}
export interface AnalyticsExploreResponse {
  coverage: AnalyticsCoverage;
  broadMarketCutoff?: (MarketBoundary & { rebuildPending: boolean }) | null;
  items: AnalyticsPoolRow[];
  total: number;
  nextOffset: number | null;
  window: LiveWindow;
  message?: string;
}
export interface CreatorsOptions {
  window?: LiveWindow;
  sort?: "launches" | "volume" | "median";
  direction?: "asc" | "desc";
  offset?: number;
  limit?: number;
}
/** One launch transaction sender. `launches` counts every discovered launch;
 * the other figures come from measured launches only, those whose selected
 * market source proves a window volume (explore's `sort=volume` population). */
export interface CreatorRow {
  address: string;
  launches: number;
  measured: number;
  traded: number;
  volumeWei: string | null;
  medianVolumeWei: string | null;
  bestLaunch: (CatalogPool & { volumeWei: string }) | null;
  /** Sender-routed evidence: a buy in a measured launch whose transaction
   * sender is this address; null without a measured launch. */
  boughtOwnLaunch: boolean | null;
}
export interface CreatorsResponse {
  coverage: AnalyticsCoverage;
  broadMarketCutoff: (MarketBoundary & { rebuildPending: boolean }) | null;
  window: LiveWindow;
  sort: "launches" | "volume" | "median";
  direction: "asc" | "desc";
  attribution: "launch_transaction_initiator";
  measuredFigures: readonly [
    "measured",
    "traded",
    "volumeWei",
    "medianVolumeWei",
    "bestLaunch",
    "boughtOwnLaunch",
  ];
  note: string;
  items: CreatorRow[];
  total: number;
  nextOffset: number | null;
}
export interface AnalyticsWalletPosition {
  accountingTier?: "tier2" | "tier3";
  attribution?: "transaction_initiator_only" | "transfer_verified";
  modeledPosition?: Position | null;
  poolId: string;
  token: string;
  symbol: string;
  decimals: number | null;
  launchTx: string;
  asOf: number;
  throughBlock: number;
  supported: boolean;
  flags: string[];
  realizedWei: string | null;
  unrealizedWei: string | null;
  netWei: string | null;
  volumeWei: string;
  position: Position | null;
}
export interface AnalyticsWalletSummary {
  verifiedUnrealizedWei?: string | null;
  unrealizedScope?: "verified_positions_only" | "unavailable";
  accountingTier?: "tier2" | "tier3" | "mixed" | "unavailable";
  attribution?:
    | "transaction_initiator_only"
    | "transfer_verified"
    | "mixed"
    | "unavailable";
  flags?: string[];
  tier2PositionCount?: number;
  tier3PositionCount?: number;
  realizedPositionCount?: number;
  rankingTradeCount?: number;
  address: string;
  rank: number | null;
  realizedWei: string | null;
  unrealizedWei: string | null;
  netWei: string | null;
  volumeWei: string;
  roi: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
  tradeCount: number;
  supportedTradeCount: number;
  supportedPositionCount: number;
  excludedPositionCount: number;
  bestWei: string | null;
  avgHold: number | null;
  last: number | null;
  asOf: number | null;
  oldestAsOf: number | null;
  completeWindow: boolean;
}
export interface AnalyticsLeaderboardOptions {
  window?: LiveWindow;
  minTrades?: number;
  metric?: "realized" | "net";
  offset?: number;
  limit?: number;
}
export interface AnalyticsLeaderboardResponse {
  coverage: AnalyticsCoverage;
  items: AnalyticsWalletSummary[];
  total: number;
  nextOffset: number | null;
  window: LiveWindow;
  minTrades: number;
  metric: "realized" | "net";
}
export interface AnalyticsWalletResponse {
  coverage: AnalyticsCoverage;
  wallet: AnalyticsWalletSummary;
  positions: AnalyticsWalletPosition[];
  trades: (ObservedExecution & { symbol: string; poolId: string })[];
  curve: PricePoint[];
  launches: CatalogPool[];
  /** Hosted metadata list is bounded independently from complete financial aggregates. */
  launchesTruncated?: boolean;
  window: LiveWindow;
  /** Profile trades are bounded separately from complete aggregate calculation. */
  tradesTruncated: boolean;
  positionsTruncated?: boolean;
  curveSampled?: boolean;
  /** Per-position realization lists are omitted by the SQL aggregate reader. */
  positionRealizationsIncluded?: boolean;
}
/** The pool's latest price state, the basis of a position's `unrealizedWei`
 * (`GET /v1/wallets/:address/positions/:poolId`). */
export interface WalletPositionMark {
  /** The pool's latest folded sqrtPriceX96 at the ledger cut, exact. */
  sqrtPriceX96: string;
  /** Wei per whole token at the ledger cut; null while the token's decimals
   * are unknown or conflict with verified units. The pool page may serve a
   * newer deep publication. */
  priceWei: string | null;
  /** The swap that set the state. */
  block: number;
  timestamp: number;
  txHash: string;
  /** What the held units fetch at that price, `unrealizedWei + costWei`
   * ("0" for a flat position); null for an excluded or unmarked position. */
  valueWei: string | null;
}
/** A supported position's inventory cycles over its whole history. */
export interface WalletPositionCycles {
  /** Unix seconds the open cycle began (the buy that took the position from
   * flat); null while flat. */
  openedAt: number | null;
  /** How long the open cycle has been held at the position's cut, bounded at
   * zero when block timestamps run backward; null while flat. */
  openHoldSeconds: number | null;
  /** Cycles closed by a sale. */
  closures: number;
  /** The closed cycles' summed hold, so the average is `holdSeconds / closures`. */
  holdSeconds: number;
}
/** One wallet-position from the aggregate ledger, the position PnL card's
 * read (`docs/LEDGER-MARKET-SERVING.md`, "A single position"). */
export interface WalletPositionResponse {
  coverage: AnalyticsCoverage;
  window: LiveWindow;
  /** The wallet, lowercased. */
  wallet: string;
  /** The catalog row the card names the pool by. */
  pool: CatalogPool;
  /** The wallet page's row for this pool, field for field. */
  position: AnalyticsWalletPosition;
  /** Null when the pool has no swap folded. */
  mark: WalletPositionMark | null;
  /** Realized over disposed cost in percent, the board's ROI; null while
   * nothing has been disposed or the position is excluded. */
  roi: number | null;
  /** Realized plus the mark over invested, in percent; null while the position
   * is unmarked or excluded or nothing was invested. */
  totalRoi: number | null;
  /** The average entry price of the held units, wei per whole token: their
   * average-cost basis `costWei` over `quantity`. Null while flat, excluded or
   * the decimals are unknown or conflict with verified units. The ledger keeps
   * no totals of token units bought or sold, so no lifetime entry or exit
   * average exists. */
  avgEntryPriceWei: string | null;
  /** Null for an excluded position, whose inventory is not served. */
  cycles: WalletPositionCycles | null;
}
