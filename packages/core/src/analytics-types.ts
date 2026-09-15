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
  pnlScope: "supported_pool_positions_only";
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
    source: "canonical_broad" | "deep_publication";
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
  sort?: "volume" | "price" | "trades" | "change" | "launch" | "liquidity";
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
export interface AnalyticsWalletPosition {
  poolId: string;
  token: string;
  symbol: string;
  decimals: number;
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
