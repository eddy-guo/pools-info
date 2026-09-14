export interface ChainMarket {
  id: string;
  token: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
  launchBlock: number;
  launchedAt: number;
  launchTx: string;
  launchSender: string;
  positionRecipient: string;
  strategy: string;
  creatorFees: boolean;
  fee: number;
  priceWei: string | null;
  volumeWei: string;
  swaps: number;
  buys: number;
  sells: number;
  series: { time: number; wei: string }[];
  accounting?: {
    wallets: ChainWallet[];
    unattributedSwaps: number;
    transfersChecked: number;
  };
}
export interface ChainWallet {
  address: string;
  swaps: number;
  buys: number;
  sells: number;
  volumeWei: string;
  realizedWei: string | null;
  inventoryRaw: string;
  balanceRaw: string;
  balanceMatches: boolean;
  eligible: boolean;
  flags: string[];
  evidenceTx: string;
}
export interface ChainTrade {
  poolId: string;
  txHash: string;
  logIndex: number;
  block: number;
  timestamp: number;
  side: "buy" | "sell";
  ethWei: string;
  tokenRaw: string;
}
export interface ChainSnapshot {
  schemaVersion: 1;
  chainId: 4663;
  generatedAt: string;
  fromBlock: number;
  toBlock: number;
  fromTimestamp: number;
  toTimestamp: number;
  blockHash: string;
  discoveredLaunches: number;
  markets: ChainMarket[];
  trades: ChainTrade[];
  requests: number;
  durationMs: number;
  reconciliation: {
    txHash: string;
    wallet: string;
    token: string;
    swapTokenDelta: string;
    transferTokenDelta: string;
    matches: boolean;
    scope: string;
  } | null;
}
