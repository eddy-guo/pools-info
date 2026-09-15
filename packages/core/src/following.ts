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
