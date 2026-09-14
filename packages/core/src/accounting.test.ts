import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTrades, realizedInWindow } from "./accounting";
import type { Trade } from "./types";
const E = 10n ** 18n;
function trade(
  index: number,
  side: "buy" | "sell",
  ethWei: bigint,
  tokens: bigint,
): Trade {
  return {
    id: `tx${index}:0`,
    txHash: `0x${index.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    block: index,
    timestamp: index * 100,
    poolId: "0x01",
    trader: "0x02",
    side,
    ethWei: ethWei.toString(),
    tokenRaw: tokens.toString(),
  };
}
test("partial sale releases proportional basis and preserves residual cost", () => {
  const p = foldTrades([
    trade(1, "buy", E, 100n),
    trade(2, "sell", (E * 6n) / 10n, 40n),
  ]);
  assert.equal(p.quantity, "60");
  assert.equal(p.costWei, ((E * 6n) / 10n).toString());
  assert.equal(p.realizedWei, (E / 5n).toString());
});
test("windowed realized profit carries cost from purchases before the window", () => {
  const p = foldTrades([
    trade(1, "buy", E, 100n),
    trade(2, "sell", (E * 6n) / 10n, 40n),
    trade(3, "sell", (E * 9n) / 10n, 60n),
  ]);
  assert.equal(realizedInWindow(p, 250), (3n * E) / 10n);
  assert.equal(p.realizedWei, (E / 2n).toString());
  assert.equal(p.costWei, "0");
});
test("oversold inventory never credits all proceeds against partial basis", () => {
  const p = foldTrades([
    trade(1, "buy", E, 100n),
    trade(2, "sell", E * 3n, 150n),
  ]);
  assert.equal(p.realizedWei, null);
  assert.deepEqual(p.flags, ["unknown_basis"]);
  assert.equal(realizedInWindow(p, 0), null);
});
test("sell-first histories are unknown, even after later acquisitions", () => {
  const p = foldTrades([
    trade(1, "sell", E, 100n),
    trade(2, "buy", E, 100n),
    trade(3, "sell", E * 2n, 100n),
  ]);
  assert.equal(p.realizedWei, null);
  assert.equal(p.realizations.length, 0);
});
test("replay is idempotent and sorts input without mutating it", () => {
  const buy = trade(1, "buy", E, 100n),
    sell = trade(2, "sell", E * 2n, 100n);
  const input = [sell, buy, buy];
  const before = JSON.stringify(input);
  assert.deepEqual(foldTrades(input), foldTrades([buy, sell]));
  assert.equal(JSON.stringify(input), before);
});
test("conflicting duplicate events fail rather than silently hiding a reorg", () => {
  const buy = trade(1, "buy", E, 100n);
  assert.throws(
    () => foldTrades([buy, { ...buy, ethWei: (E * 2n).toString() }]),
    /Conflicting duplicate/,
  );
});
test("full closure consumes rounding residue, including quantities above Number precision", () => {
  const qty = 2n ** 200n;
  const cost = 2n ** 180n + 7n;
  const p = foldTrades([
    trade(1, "buy", cost, qty),
    trade(2, "sell", cost / 3n, qty / 3n),
    trade(3, "sell", cost, qty - qty / 3n),
  ]);
  assert.equal(p.quantity, "0");
  assert.equal(p.costWei, "0");
  assert.equal(p.realizedWei, (cost / 3n).toString());
});
test("mixed positions and nonpositive trade quantities fail", () => {
  assert.throws(() => foldTrades([trade(1, "buy", E, 0n)]), /positive/);
  assert.throws(
    () =>
      foldTrades([
        trade(1, "buy", E, 100n),
        { ...trade(2, "sell", E, 100n), trader: "0x99" },
      ]),
    /Mixed position/,
  );
});
