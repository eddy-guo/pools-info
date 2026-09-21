import assert from "node:assert/strict";
import { test } from "node:test";
import { candlePriceDivisor } from "./candle-scale";

test("empty, zero and tiny candles retain one-wei chart resolution", () => {
  for (const highs of [[], [0n], [1n, 2n, 4n], [1_000_000_000n]])
    assert.equal(candlePriceDivisor(highs.map((high) => ({ high }))), 1);
});

test("every OHLC magnitude fits the library without integer truncation", () => {
  // Include the old assertion boundary, fractional scaled values, and values
  // above even an ETH-denominated chart's limit. Only chart coordinates may
  // lose floating-point precision; the source bigint is retained verbatim.
  const values = [
    1n,
    1_000_000_000_001n,
    90_071_992_547_409n,
    90_071_992_547_410n,
    1_234_567_891_234_567_891n,
    10n ** 36n + 10n ** 24n,
    2n ** 256n - 1n,
  ];
  for (const high of values) {
    const divisor = candlePriceDivisor([{ high }]);
    const number = Number(high);
    const coordinate = number / divisor;
    assert.ok(Number.isFinite(coordinate) && coordinate > 0);
    assert.ok(coordinate <= Number.MAX_SAFE_INTEGER / 100);
    assert.ok(Number.isInteger(Math.log10(divisor)));
    assert.ok(Math.abs(coordinate * divisor - number) <= number * Number.EPSILON);
    // A shared scale must preserve the relative heights, not clamp an OHLC
    // field or round a fractional scaled coordinate down to an integer.
    const low = high / 3n || 1n;
    assert.ok(
      Math.abs(Number(low) / divisor / coordinate - Number(low) / number) <=
        Number.EPSILON,
    );
  }
  const high = 1_000_000_000_001n;
  assert.equal(Number(high) / candlePriceDivisor([{ high }]), 100_000_000_000.1);
});

test("the common scale follows the largest candle and can shrink on a new range", () => {
  const small = { high: 1_000_000_000n };
  const large = { high: 2_000_000_000_000_000_000n };
  assert.equal(candlePriceDivisor([large, small]), 10_000_000);
  assert.equal(candlePriceDivisor([small, large]), 10_000_000);
  assert.equal(candlePriceDivisor([small]), 1);
});
