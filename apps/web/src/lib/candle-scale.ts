import type { Candle } from "@pools/core";

/* Lightweight Charts accepts floating-point coordinates only up to
   Number.MAX_SAFE_INTEGER / 100. Keep every source candle exact as bigint and
   give the chart one shared decimal scale, so relative OHLC geometry survives
   without clamping high prices or sacrificing one-wei resolution for the
   ordinary tiny-price case. */
export function candlePriceDivisor(
  bars: readonly Pick<Candle, "high">[],
): number {
  let largest = 0n;
  for (const { high } of bars) {
    const magnitude = high < 0n ? -high : high;
    if (magnitude > largest) largest = magnitude;
  }
  return 10 ** Math.max(0, largest.toString().length - 12);
}
