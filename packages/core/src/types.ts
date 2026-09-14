export type Address = `0x${string}`;
export type Amount = string;

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
export interface PricePoint {
  time: number;
  wei: Amount;
}
