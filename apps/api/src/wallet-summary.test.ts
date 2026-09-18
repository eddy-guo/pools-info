import assert from "node:assert/strict";
import test from "node:test";
import { walletSummary } from "./accounting-read";

const E = 10n ** 18n;
const row = (realized: bigint | null, disposed: bigint | null) => ({
  realized: realized === null ? null : realized.toString(),
  disposed_cost: disposed === null ? null : disposed.toString(),
});

test("ROI is realized over disposed cost to four decimals, and undefined wherever no cost was disposed", () => {
  // The board's and the wallet header's one mapper: a percent only when a
  // basis was disposed, so proceeds with no basis behind them (which the
  // fold excludes since migration 022, and whose figures are zero here)
  // never read as a return of any size.
  assert.equal(walletSummary(row(E, 6n * E), "0x1").roi, 16.6666);
  assert.equal(walletSummary(row(-E, 4n * E), "0x1").roi, -25);
  assert.equal(walletSummary(row(0n, E), "0x1").roi, 0);
  assert.equal(walletSummary(row(E, 0n), "0x1").roi, null);
  assert.equal(walletSummary(row(0n, 0n), "0x1").roi, null);
  assert.equal(walletSummary(row(10n * E, 0n), "0x1").roi, null);
  assert.equal(walletSummary(row(E, null), "0x1").roi, null);
  assert.equal(walletSummary(row(null, E), "0x1").roi, null);
  assert.equal(walletSummary(undefined, "0x1").roi, null);
  // Integer-exact: a basis and a gain beyond double precision divide to
  // the wei before the four decimals are taken.
  const cost = 4n * 31415926535897932384626433832n;
  assert.equal(walletSummary(row(cost / 4n, cost), "0x1").roi, 25);
  assert.equal(walletSummary(row(cost * 3n + 1n, cost), "0x1").roi, 300);
});
