import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileWallets,
  type ObservedExecution,
  type TokenMovement,
} from "./chain-accounting";
const wallet = "0x123";
const manager = "0x456";
const executions: ObservedExecution[] = [
  {
    trade: {
      id: "buy",
      txHash: "0xabc",
      logIndex: 1,
      block: 1,
      timestamp: 1,
      poolId: "0x789",
      trader: wallet,
      side: "buy",
      ethWei: "1000000000000000000",
      tokenRaw: "10",
    },
    flags: [],
    matchedTransfer: "in",
  },
  {
    trade: {
      id: "sell",
      txHash: "0xdef",
      logIndex: 1,
      block: 2,
      timestamp: 2,
      poolId: "0x789",
      trader: wallet,
      side: "sell",
      ethWei: "800000000000000000",
      tokenRaw: "5",
    },
    flags: [],
    matchedTransfer: "out",
  },
];
const movements: TokenMovement[] = [
  { id: "in", from: manager, to: wallet, value: "10" },
  { id: "out", from: wallet, to: manager, value: "5" },
];
test("reconciled token movements carry average basis into gross realized swap PnL", () => {
  const [row] = reconcileWallets(
    executions,
    movements,
    new Map([[wallet, "5"]]),
  );
  assert.equal(row.realizedWei, "300000000000000000");
  assert.equal(row.inventoryRaw, "5");
  assert.equal(row.balanceMatches, true);
  assert.equal(row.eligible, false);
  assert.deepEqual(row.flags, []);
});
test("a gift cannot become a free-cost entry even when the current balance matches", () => {
  const [row] = reconcileWallets(
    executions,
    [...movements, { id: "gift", from: "0xaaa", to: wallet, value: "2" }],
    new Map([[wallet, "7"]]),
  );
  assert.equal(row.balanceMatches, true);
  assert.equal(row.realizedWei, null);
  assert.ok(row.flags.includes("unmatched_transfer"));
});
test("offsetting unsupported transfers are not hidden by net-zero balance changes", () => {
  const [row] = reconcileWallets(
    executions,
    [
      ...movements,
      { id: "x", from: wallet, to: "0xaaa", value: "2" },
      { id: "y", from: "0xaaa", to: wallet, value: "2" },
    ],
    new Map([[wallet, "5"]]),
  );
  assert.equal(row.realizedWei, null);
  assert.ok(row.flags.includes("unmatched_transfer"));
});
test("state balance disagreement invalidates otherwise complete-looking trades", () => {
  const [row] = reconcileWallets(
    executions,
    movements,
    new Map([[wallet, "6"]]),
  );
  assert.equal(row.realizedWei, null);
  assert.equal(row.balanceMatches, false);
});
test("an unsupported route never produces ranked or zero-cost profit", () => {
  const [row] = reconcileWallets(
    [{ ...executions[0], flags: ["unsupported_route"] }, executions[1]],
    movements,
    new Map([[wallet, "5"]]),
  );
  assert.equal(row.realizedWei, null);
  assert.equal(row.eligible, false);
  assert.ok(row.flags.includes("unknown_basis"));
});
