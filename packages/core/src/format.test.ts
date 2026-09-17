import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "./format";

const wei = (eth: number) => BigInt(Math.round(eth * 1e18)).toString();

test("formatMoney formats a sub-1,000 USD amount with two decimals", () => {
  assert.equal(formatMoney(wei(0.1), "USD", 4218.44), "$421.84");
});
test("formatMoney formats a 1,000+ USD amount with thousands separators, matching the export", () => {
  assert.equal(formatMoney(wei(1), "USD", 4218.44), "$4,218.44");
});
test("formatMoney compacts a USD amount at a million and above, not below it", () => {
  assert.equal(formatMoney(wei(1000), "USD", 4218.44), "$4.22M");
  assert.equal(formatMoney(wei(236.9), "USD", 4218.44), "$999,348.44");
});
test("formatMoney signs a positive amount with + and a negative one with -", () => {
  assert.equal(formatMoney(wei(1), "USD", 4218.44, true), "+$4,218.44");
  assert.equal(formatMoney(wei(-1), "USD", 4218.44, true), "-$4,218.44");
});
test("formatMoney leaves the ETH form untouched by the currency rate", () => {
  assert.equal(formatMoney(wei(1), "ETH", 4218.44), "1.00 ETH");
});
