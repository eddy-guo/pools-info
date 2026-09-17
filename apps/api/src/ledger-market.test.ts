import assert from "node:assert/strict";
import test from "node:test";
import {
  ledgerAnswers,
  ledgerWindowHour,
  marketSourceSetting,
  type LedgerCut,
} from "./ledger-market";

test("MARKET_SOURCE: unset or broad serves the broad rollups, ledger the ledger, anything else refuses to start", () => {
  assert.equal(marketSourceSetting(undefined), "broad");
  assert.equal(marketSourceSetting(""), "broad");
  assert.equal(marketSourceSetting("broad"), "broad");
  assert.equal(marketSourceSetting("ledger"), "ledger");
  for (const value of ["Ledger", "aggregate", "on", "1", " ledger"])
    assert.throws(() => marketSourceSetting(value), /Invalid MARKET_SOURCE/);
});

test("ledger windows are whole hours ending with the newest hour, and whole hours cannot answer 1h", () => {
  const cut: LedgerCut = {
    block: 1,
    hash: "0x" + "1".repeat(64),
    asOf: 497121 * 3600 + 177,
    startBlock: 0,
    newestHour: 497121,
    indexedAt: "2026-09-17T09:03:00.000Z",
  };
  assert.equal(ledgerWindowHour(cut, "24h"), 497121 - 23);
  assert.equal(ledgerWindowHour(cut, "6h"), 497121 - 5);
  assert.equal(ledgerWindowHour(cut, "7d"), 497121 - 167);
  assert.equal(ledgerWindowHour(cut, "30d"), 497121 - 719);
  assert.equal(ledgerWindowHour(cut, "All"), null);
  assert.equal(ledgerWindowHour({ ...cut, newestHour: 3 }, "24h"), 0);
  assert.equal(ledgerAnswers("1h"), false);
  for (const window of ["6h", "24h", "7d", "30d", "All"] as const)
    assert.equal(ledgerAnswers(window), true);
});
