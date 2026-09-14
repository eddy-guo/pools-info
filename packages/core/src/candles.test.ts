import { test } from "node:test";
import assert from "node:assert/strict";
import captured from "../../../data/snapshots/chain.json";
import { buildCandles, candleValue } from "./candles";
import type { ChainSnapshot } from "./chain-types";
test("fixed candles preserve OHLC order, gaps, cutoff and exact swap volume", () => {
  const s = structuredClone(captured) as ChainSnapshot,
    m = s.markets[0];
  s.toTimestamp = 1000;
  m.series = [
    { time: 120, wei: "20" },
    { time: 121, wei: "10" },
    { time: 121, wei: "30" },
    { time: 300, wei: "40" },
    { time: 1001, wei: "999" },
  ];
  s.trades = [
    { ...s.trades[0], poolId: m.id, timestamp: 121, ethWei: "15" },
    { ...s.trades[0], poolId: m.id, timestamp: 122, ethWei: "25" },
    { ...s.trades[0], poolId: "other", timestamp: 122, ethWei: "100" },
  ];
  assert.deepEqual(buildCandles(m, s, 60), [
    { time: 120, open: 20n, high: 30n, low: 10n, close: 30n, volume: 40n },
    { time: 300, open: 40n, high: 40n, low: 40n, close: 40n, volume: 0n },
  ]);
  assert.equal(buildCandles(m, s, 1).length, 3);
  assert.throws(() => buildCandles(m, s, 0));
});
test("FDV conversion respects supply decimals and never changes price or volume", () => {
  assert.equal(candleValue(3n, { supply: "1500000", decimals: 6 }, "FDV"), 4n);
  assert.equal(
    candleValue(3n, { supply: "1500000", decimals: 6 }, "Price"),
    3n,
  );
});
