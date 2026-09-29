import test from "node:test";
import assert from "node:assert/strict";
import { usdPrice } from "./usd-price";

// The ETH/USD rate of the read behind the data side's figures audit of
// 29 Sep 2026 (item D1: the production home page in USD mode at 15:10Z).
const AUDIT_RATE = 2700.705;

test("a sub-cent price keeps four significant digits instead of rounding to a cent", () => {
  // Hookr.fun: 5073335767828 wei is $0.0137, shown as "$0.01" (27% low).
  assert.deepEqual(usdPrice("5073335767828", AUDIT_RATE), {
    form: "plain",
    text: "$0.0137",
  });
  // Prologue: $0.00804, shown as "$0.01" (24% high).
  assert.deepEqual(usdPrice("2977000000000", AUDIT_RATE), {
    form: "plain",
    text: "$0.00804",
  });
  assert.deepEqual(usdPrice("1000000000000", 4000), {
    form: "plain",
    text: "$0.004",
  });
  assert.deepEqual(usdPrice("30000000000", 4000), {
    form: "plain",
    text: "$0.00012",
  });
});

test("a price under a dollar keeps at least two decimals, so a round figure reads as dollars and cents", () => {
  assert.deepEqual(usdPrice("125000000000000", 4000), {
    form: "plain",
    text: "$0.50",
  });
  assert.deepEqual(usdPrice("25000000000000", 4000), {
    form: "plain",
    text: "$0.10",
  });
  assert.deepEqual(usdPrice("30864000000000", 4000), {
    form: "plain",
    text: "$0.1235",
  });
});

test("a price from a dollar up keeps the two-decimal money form", () => {
  assert.deepEqual(usdPrice("250000000000000", 4000), {
    form: "plain",
    text: "$1.00",
  });
  assert.deepEqual(usdPrice("1000000000000000000", 4218.44), {
    form: "plain",
    text: "$4,218.44",
  });
  assert.deepEqual(usdPrice("1000000000000000000000", 4218.44), {
    form: "plain",
    text: "$4.22M",
  });
  // $0.99995 rounds up to a dollar at four significant digits and reads as
  // one, not as "$1.000".
  assert.deepEqual(usdPrice("999950000000000000", 1), {
    form: "plain",
    text: "$1.00",
  });
  assert.deepEqual(usdPrice("0", 4000), { form: "plain", text: "$0.00" });
});

test("a price below $0.0001 keeps the leading-zero notation, unchanged", () => {
  // CREAM at $7.2e-6 on the audit's read renders "$0.0₅7200".
  assert.deepEqual(usdPrice("1800000000", 4000), {
    form: "subscript",
    zeros: 5,
    digits: "7200",
    title: "$0.000007200",
  });
});
