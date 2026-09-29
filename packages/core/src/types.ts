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
  /** Token units bought and sold through the position's attributed swaps,
   * so `investedWei / boughtRaw` and `proceedsWei / soldRaw` are its exact
   * average entry and exit prices. Served by the ledger route; null where the
   * fold has not recorded them (a position written before they were folded,
   * or the frozen accounting tables). */
  boughtRaw?: Amount | null;
  soldRaw?: Amount | null;
  flags: string[];
  realizations: { timestamp: number; wei: Amount }[];
  /** Read API rows from the aggregate ledger only. When the open inventory
   * cycle began (the buy that took the position from flat), unix seconds;
   * null while flat. */
  openedAt?: number | null;
  /** The UTC hours of the position's first and last attributed swap, as unix
   * seconds at the hour's start: the ledger keeps swaps per hour, so these are
   * the honest bounds of a closed position's span. Null without a swap. */
  firstHour?: number | null;
  lastHour?: number | null;
}
export interface PricePoint {
  time: number;
  wei: Amount;
}
