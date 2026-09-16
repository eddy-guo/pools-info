import assert from "node:assert/strict";
import test from "node:test";
import { InitiatorLedger, tier2Flags } from "./tier2-accounting";
import type { Trade } from "./types";
const pool = "0x" + "1".repeat(64),
  wallet = "0x" + "2".repeat(40);
const trade = (
  n: number,
  side: "buy" | "sell",
  eth: string,
  quantity: string,
  timestamp = n,
): Trade => ({
  id: `${n}:0`,
  poolId: pool as `0x${string}`,
  trader: wallet as `0x${string}`,
  txHash: ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`,
  block: n,
  logIndex: 0,
  timestamp,
  side,
  ethWei: eth,
  tokenRaw: quantity,
});
test("initiator model carries exact prior-window basis and retains attribution flags", () => {
  const ledger = new InitiatorLedger(pool, wallet, 100, true),
    cost = 900719925474099300001n;
  ledger.add(trade(1, "buy", cost.toString(), "3", 1));
  const gain = ledger.add(trade(2, "sell", cost.toString(), "1", 101));
  const basis = cost / 3n;
  assert.equal(gain!.wei, (cost - basis).toString());
  const result = ledger.finish();
  assert.equal(
    BigInt(result.realizedWei!),
    cost - BigInt(result.disposedCostWei!),
  );
  assert.equal(result.tradeCount, 1);
  assert.deepEqual(result.flags, [...tier2Flags]);
  assert.equal(result.position.quantity, "2");
});
test("a later oversell nulls the whole book, including earlier valid gains", () => {
  const ledger = new InitiatorLedger(pool, wallet, 0, true);
  ledger.add(trade(1, "buy", "10", "10"));
  ledger.add(trade(2, "sell", "8", "5"));
  ledger.add(trade(3, "sell", "100", "6"));
  assert.equal(ledger.finish().realizedWei, null);
  assert.equal(ledger.finish().disposedCostWei, null);
  assert.ok(ledger.finish().flags.includes("unknown_basis"));
});
test("late history never assumes zero-cost opening inventory, even with observed buys", () => {
  const ledger = new InitiatorLedger(pool, wallet, 0, false);
  ledger.add(trade(1, "buy", "10", "10"));
  ledger.add(trade(2, "sell", "20", "10"));
  assert.equal(ledger.finish().realizedWei, null);
  assert.equal(ledger.finish().netWei, "10");
  assert.deepEqual(ledger.finish().flags.slice(-2), [
    "late_history_start",
    "unknown_basis",
  ]);
});
test("unsupported history invalidates basis rather than inventing a trade", () => {
  const ledger = new InitiatorLedger(pool, wallet, 0, true);
  ledger.add(trade(1, "buy", "10", "10"));
  ledger.invalidate("unsupported_swap_history");
  ledger.add(trade(2, "sell", "20", "10"));
  assert.equal(ledger.finish().realizedWei, null);
  assert.equal(ledger.finish().tradeCount, 2);
});
test("duplicate initiator trades dedupe and conflicting copies fail", () => {
  const ledger = new InitiatorLedger(pool, wallet, 0, true),
    buy = trade(1, "buy", "10", "10");
  ledger.add(buy);
  ledger.add({ ...buy });
  assert.equal(ledger.finish().tradeCount, 1);
  assert.throws(
    () => ledger.add({ ...buy, ethWei: "11" }),
    /Conflicting duplicate/,
  );
});
test("the ledger rejects mixed attribution books and unordered input", () => {
  const ledger = new InitiatorLedger(pool, wallet, 0, true);
  ledger.add(trade(2, "buy", "10", "10"));
  assert.throws(() => ledger.add(trade(1, "buy", "10", "10")), /Unordered/);
  assert.throws(
    () =>
      ledger.add({
        ...trade(3, "buy", "10", "10"),
        trader: ("0x" + "3".repeat(40)) as `0x${string}`,
      }),
    /Mixed/,
  );
});
