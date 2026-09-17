import type { LiveWindow } from "./live-analytics";

export interface MarketBoundary {
  block: number;
  hash: string;
  asOf: number;
}
export interface ObservedMarket {
  poolId: string;
  token: string;
  decimals: number | null;
  priceWei: string | null;
  /** Fully diluted value in wei: the price times the token's measured total
   * supply. Served only with the aggregate ledger's market, null there until
   * the supply has been read; absent on the broad and raw paths. */
  fdvWei?: string | null;
  window: LiveWindow;
  volumeWei: string | null;
  trades: number | null;
  change: number | null;
  observations: {
    id: string;
    transactionHash: string;
    logIndex: number;
    block: number;
    blockHash: string;
    timestamp: number;
    side: "buy" | "sell" | null;
    ethWei: string | null;
    tokenRaw: string | null;
  }[];
  coverage: {
    startBlock: number | null;
    cutoff: MarketBoundary | null;
    indexedAt: string | null;
    completeWindow: boolean;
    windowStart: number | null;
    priceBaseline: MarketBoundary | null;
    unitBasis:
      | (MarketBoundary & {
          decimals: number;
          source:
            | "broad_token_units"
            | "verified_deep_snapshot"
            | "aggregate_ledger";
        })
      | null;
    unitsConflict: boolean;
    accounting: "unavailable";
    attribution: "transaction_initiator_only";
  };
  history: {
    priceSemantics: "declared_cutoff_display_units";
    /** One minute from the broad rollups and raw copies; one hour from the
     * aggregate ledger's pool hours. Every candle time is a multiple of it. */
    intervalSeconds: 60 | 3600;
    fromTimestamp: number | null;
    truncated: boolean;
    candles: {
      time: number;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }[];
  };
}

const hash = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const uint = (v: unknown) =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,95})$/.test(v);
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const boundary = (v: any) =>
  v !== null &&
  typeof v === "object" &&
  integer(v.block) &&
  hash(v.hash) &&
  integer(v.asOf);
/** Validate at both the proxy and browser boundary before rendering raw amounts. */
export function assertObservedMarket(
  value: unknown,
  poolId: string,
  token: string,
  window: string,
): asserts value is ObservedMarket {
  const v = value as ObservedMarket;
  if (
    !v ||
    typeof v !== "object" ||
    v.poolId !== poolId ||
    v.token !== token ||
    !hash(poolId) ||
    !/^0x[0-9a-f]{40}$/.test(token) ||
    v.window !== window ||
    !(v.decimals === null || (integer(v.decimals) && v.decimals <= 36)) ||
    !(v.priceWei === null || uint(v.priceWei)) ||
    !(v.fdvWei === undefined || v.fdvWei === null || uint(v.fdvWei)) ||
    (v.fdvWei != null && v.priceWei === null) ||
    !(v.volumeWei === null || uint(v.volumeWei)) ||
    !(v.trades === null || integer(v.trades)) ||
    !(
      v.change === null ||
      (typeof v.change === "number" && Number.isFinite(v.change))
    ) ||
    !v.coverage ||
    typeof v.coverage.unitsConflict !== "boolean" ||
    !(v.coverage.unitBasis === null || boundary(v.coverage.unitBasis)) ||
    v.coverage.accounting !== "unavailable" ||
    v.coverage.attribution !== "transaction_initiator_only" ||
    typeof v.coverage.completeWindow !== "boolean" ||
    !(v.coverage.startBlock === null || integer(v.coverage.startBlock)) ||
    !(v.coverage.windowStart === null || integer(v.coverage.windowStart)) ||
    !(
      v.coverage.indexedAt === null ||
      (typeof v.coverage.indexedAt === "string" &&
        Number.isFinite(Date.parse(v.coverage.indexedAt)))
    ) ||
    !(v.coverage.cutoff === null || boundary(v.coverage.cutoff)) ||
    !(
      v.coverage.priceBaseline === null || boundary(v.coverage.priceBaseline)
    ) ||
    !Array.isArray(v.observations) ||
    v.observations.length > 50 ||
    !v.history ||
    v.history.priceSemantics !== "declared_cutoff_display_units" ||
    (v.history.intervalSeconds !== 60 && v.history.intervalSeconds !== 3600) ||
    typeof v.history.truncated !== "boolean" ||
    !(v.history.fromTimestamp === null || integer(v.history.fromTimestamp)) ||
    !Array.isArray(v.history.candles) ||
    v.history.candles.length > 1000
  )
    throw Error("Invalid observed market");
  const c = v.coverage;
  if (c.cutoff === null) {
    if (
      c.startBlock !== null ||
      v.decimals !== null ||
      c.completeWindow ||
      v.priceWei !== null ||
      v.volumeWei !== null ||
      v.trades !== null ||
      v.change !== null ||
      c.priceBaseline !== null ||
      c.windowStart !== null ||
      v.history.candles.length ||
      v.observations.length
    )
      throw Error("Uncovered market cannot assert observations");
  } else if (
    c.startBlock === null ||
    c.indexedAt === null ||
    c.startBlock > c.cutoff.block ||
    c.windowStart === null ||
    c.windowStart > c.cutoff.asOf ||
    (c.priceBaseline &&
      (c.priceBaseline.block > c.cutoff.block ||
        c.priceBaseline.asOf >= c.windowStart))
  )
    throw Error("Invalid observed market coverage");
  if (
    v.decimals === null &&
    (v.priceWei !== null ||
      v.change !== null ||
      v.history.candles.length ||
      c.priceBaseline !== null ||
      c.unitBasis !== null)
  )
    throw Error("Unverified token units");
  if (
    (c.unitBasis &&
      (c.unitBasis.decimals !== v.decimals ||
        ![
          "broad_token_units",
          "verified_deep_snapshot",
          "aggregate_ledger",
        ].includes(c.unitBasis.source))) ||
    (c.unitBasis &&
      (!c.cutoff ||
        c.unitBasis.block > c.cutoff.block ||
        c.unitBasis.block < c.startBlock! ||
        c.unitBasis.asOf > c.cutoff.asOf ||
        (c.unitBasis.block === c.cutoff.block &&
          (c.unitBasis.hash !== c.cutoff.hash ||
            c.unitBasis.asOf !== c.cutoff.asOf)))) ||
    (c.unitsConflict &&
      (v.priceWei !== null ||
        v.history.candles.length ||
        c.unitBasis !== null)) ||
    (v.decimals !== null && c.cutoff !== null && c.unitBasis === null)
  )
    throw Error("Invalid declared unit basis");
  const ids = new Set<string>();
  for (const row of v.observations) {
    if (
      !row ||
      !hash(row.transactionHash) ||
      !integer(row.logIndex) ||
      row.id !== `${row.transactionHash}:${row.logIndex}` ||
      ids.has(row.id) ||
      !integer(row.block) ||
      !hash(row.blockHash) ||
      !integer(row.timestamp) ||
      !c.cutoff ||
      row.block < c.startBlock! ||
      row.block > c.cutoff.block ||
      row.timestamp > c.cutoff.asOf ||
      (row.block === c.cutoff.block && row.blockHash !== c.cutoff.hash) ||
      (row.side === null
        ? row.ethWei !== null || row.tokenRaw !== null
        : !["buy", "sell"].includes(row.side) ||
          !uint(row.ethWei) ||
          !uint(row.tokenRaw))
    )
      throw Error("Invalid observed trade");
    ids.add(row.id);
  }
  let previous = -1;
  for (const bar of v.history.candles) {
    if (
      !bar ||
      !integer(bar.time) ||
      bar.time % v.history.intervalSeconds ||
      bar.time <= previous ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(uint) ||
      !c.cutoff ||
      bar.time > c.cutoff.asOf ||
      BigInt(bar.low) > BigInt(bar.open) ||
      BigInt(bar.low) > BigInt(bar.close) ||
      BigInt(bar.high) < BigInt(bar.open) ||
      BigInt(bar.high) < BigInt(bar.close) ||
      v.history.fromTimestamp === null ||
      bar.time < v.history.fromTimestamp
    )
      throw Error("Invalid observed candles");
    previous = bar.time;
  }
}
