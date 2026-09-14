import type { ChainMarket, ChainSnapshot } from "./chain-types";
export interface Candle {
  time: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
}
export const candleIntervals = {
  "1s": 1,
  "1m": 60,
  "5m": 300,
  "1h": 3600,
  "4h": 14400,
  "24h": 86400,
} as const;
// Fixed intervals, independent of viewport. Preserve input order for swaps in
// the same second, and use integers until the final chart-rendering boundary.
export function buildCandles(
  market: ChainMarket,
  snapshot: ChainSnapshot,
  interval: number,
): Candle[] {
  if (!Number.isSafeInteger(interval) || interval < 1)
    throw Error("Invalid candle interval");
  const buckets = new Map<number, Candle>();
  for (const point of [...market.series].sort((a, b) => a.time - b.time)) {
    if (point.time > snapshot.toTimestamp) continue;
    const time = Math.floor(point.time / interval) * interval,
      value = BigInt(point.wei),
      old = buckets.get(time);
    if (old) {
      old.close = value;
      old.high = old.high > value ? old.high : value;
      old.low = old.low < value ? old.low : value;
    } else
      buckets.set(time, {
        time,
        open: value,
        high: value,
        low: value,
        close: value,
        volume: 0n,
      });
  }
  for (const t of snapshot.trades) {
    if (t.poolId !== market.id || t.timestamp > snapshot.toTimestamp) continue;
    const b = buckets.get(Math.floor(t.timestamp / interval) * interval);
    if (b) b.volume += BigInt(t.ethWei);
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}
export function candleValue(
  value: bigint,
  market: Pick<ChainMarket, "supply" | "decimals">,
  metric: "Price" | "FDV",
) {
  return metric === "FDV"
    ? (value * BigInt(market.supply)) / 10n ** BigInt(market.decimals)
    : value;
}
