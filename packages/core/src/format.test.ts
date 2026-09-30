import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ethFigure,
  figureText,
  formatEthAmount,
  formatMoney,
  formatPercent,
  formatTokenAmount,
} from "./format";

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

test("one ETH figure rule: two decimals from 0.01, compact from a million, significant digits and subscript zeros below", () => {
  const wei = (eth: number) => (BigInt(Math.round(eth * 1e6)) * 10n ** 12n).toString();
  // The QA sweep's column that mixed 2 to 11 decimals (item 12, 29 Sep 2026).
  assert.equal(formatEthAmount(wei(191.52)), "191.52");
  assert.equal(formatEthAmount(wei(172.423)), "172.42");
  assert.equal(formatEthAmount(wei(56.7509)), "56.75");
  assert.equal(formatEthAmount("410397000000000"), "0.0004104");
  // One wallet's PnL that printed three ways (+1.8671, +1.86706, +1.867).
  assert.equal(formatEthAmount(wei(1.8671)), "1.87");
  assert.equal(formatEthAmount(wei(1.86706)), "1.87");
  assert.equal(formatEthAmount(wei(1.867)), "1.87");
  // The export's own samples and the site's existing compact threshold.
  assert.equal(formatEthAmount(wei(240.54)), "240.54");
  assert.equal(formatEthAmount(wei(2100)), "2,100.00");
  assert.equal(formatEthAmount(wei(1234567.8)), "1.23M");
  assert.equal(formatEthAmount(wei(-1234567.8)), "-1.23M");
  // Under 0.01 ETH: four significant digits, never a fabricated 0.00.
  assert.equal(formatEthAmount(wei(0.01)), "0.01");
  assert.equal(formatEthAmount(wei(0.0099)), "0.0099");
  assert.equal(formatEthAmount(wei(0.004104)), "0.004104");
  assert.equal(formatEthAmount("-5524430000000"), "-0.0₅5524");
  assert.deepEqual(ethFigure("-5524430000000"), {
    form: "subscript",
    sign: "-",
    zeros: 5,
    digits: "5524",
  });
  assert.deepEqual(ethFigure("5"), {
    form: "subscript",
    sign: "",
    zeros: 17,
    digits: "5",
  });
  assert.equal(figureText(ethFigure("5")), "0.0₁₇5");
  assert.deepEqual(ethFigure("0"), { form: "plain", text: "0.00" });
  assert.equal(formatEthAmount("-" + wei(0.5)), "-0.50");
  // A token quantity follows the same rule at its own decimals.
  assert.equal(formatTokenAmount("8274943690407648622739002", 18), "8.27M");
  assert.equal(formatTokenAmount("123456000000000000000", 18), "123.46");
  assert.equal(formatTokenAmount("0", 18), "0.00");
  assert.equal(formatTokenAmount("1500", 0), "1,500.00");
});

test("percent changes abbreviate from 10,000% with their sign", () => {
  assert.equal(formatPercent(805.667), "+805.67%");
  assert.equal(formatPercent(-84.9779), "-84.98%");
  assert.equal(formatPercent(0.004), "0.00%");
  assert.equal(formatPercent(9999.994), "+9999.99%");
  assert.equal(formatPercent(9999.995), "+10K%");
  assert.equal(formatPercent(15285.6), "+15.3K%");
  assert.equal(formatPercent(-15285.6), "-15.3K%");
  assert.equal(formatPercent(1234567.8), "+1.2M%");
  assert.equal(formatPercent(805.667, 1), "+805.7%");
});
