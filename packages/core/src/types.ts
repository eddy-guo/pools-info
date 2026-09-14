export type Address = `0x${string}`;
export type Window = "24h" | "7d";
export type Amount = string;

export interface Manifest {
  schemaVersion: 1;
  source: "demo" | "verified";
  chainId: 4663;
  generatedAt: string;
  from: number;
  to: number;
  fromBlock: number | null;
  toBlock: number | null;
  ethUsd: string;
  coverage: string;
}
export interface Pool {
  id: Address;
  token: Address;
  name: string;
  symbol: string;
  description: string;
  color: string;
  mark: string;
  decimals: number;
  supply: Amount;
  mode: "instant" | "crowd";
  creator: Address;
  createdAt: number;
  liquidityWei: Amount;
}
export interface Trade {
  id: string;
  txHash: Address;
  logIndex: number;
  block: number;
  timestamp: number;
  poolId: Address;
  trader: Address;
  side: "buy" | "sell";
  ethWei: Amount;
  tokenRaw: Amount;
}
export interface Identity {
  address: Address;
  label: string;
  color: string;
}
export interface Snapshot {
  manifest: Manifest;
  pools: Pool[];
  identities: Identity[];
  trades: Trade[];
}
export interface Position {
  poolId: Address;
  trader: Address;
  quantity: Amount;
  costWei: Amount;
  realizedWei: Amount | null;
  proceedsWei: Amount;
  investedWei: Amount;
  buys: number;
  sells: number;
  flags: string[];
  realizations: { timestamp: number; wei: Amount }[];
}
export interface PeriodStats {
  volumeWei: Amount;
  trades: number;
  traders: number;
  change: number;
}
export interface PricePoint {
  time: number;
  wei: Amount;
}
export interface PoolRow extends Pool {
  priceWei: Amount;
  fdvWei: Amount;
  stats: Record<Window, PeriodStats>;
  series: PricePoint[];
}
export interface WalletRow extends Identity {
  realizedWei: Amount;
  volumeWei: Amount;
  trades: number;
  winRate: number | null;
  wins: number;
  losses: number;
  eligible: boolean;
  lastActive: number;
  poolCount: number;
  flags: string[];
  roi: number | null;
}
export interface WalletDetail {
  wallet: Identity;
  summary: Record<Window, WalletRow>;
  positions: (Position & {
    pool: PoolRow;
    valueWei: Amount;
    unrealizedWei: Amount | null;
  })[];
  trades: Trade[];
  pnlSeries: PricePoint[];
}
export interface PoolDetail {
  pool: PoolRow;
  trades: Trade[];
  traders: WalletRow[];
}
export interface Creator {
  identity: Identity;
  pools: PoolRow[];
  volumeWei: Amount;
  liquidityWei: Amount;
}
export interface SearchResult {
  type: "Token" | "Wallet" | "Transaction";
  title: string;
  subtitle: string;
  href: string;
  color: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface PoolQuery {
  search?: string;
  mode?: "instant" | "crowd";
  sort?: "volume" | "newest" | "liquidity";
  window?: Window;
  page?: number;
  pageSize?: number;
}
export interface AnalyticsReader {
  manifest(): Promise<Manifest>;
  pools(query?: PoolQuery): Promise<Page<PoolRow>>;
  pool(id: string): Promise<PoolDetail | null>;
  leaderboard(
    window: Window,
    page?: number,
    pageSize?: number,
  ): Promise<Page<WalletRow>>;
  wallet(address: string): Promise<WalletDetail | null>;
  wallets(): Promise<Identity[]>;
  creators(): Promise<Creator[]>;
  search(query: string): Promise<SearchResult[]>;
  searchIndex(): Promise<SearchResult[]>;
  recentTrades(limit?: number): Promise<Trade[]>;
}
