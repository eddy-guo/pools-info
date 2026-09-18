import assert from "node:assert/strict";
import test from "node:test";
import { assertObservedMarket, type ObservedMarket } from "@pools/core";
import {
  creatorFeeFlag,
  ledgerAnswers,
  ledgerWindowHour,
  marketSourceSetting,
  withCreatorFees,
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

test("the creator-fee flag prefers the stored column, falls back to the publication, and is omitted rather than invented", () => {
  // Stored wins whatever the publication says, including a contradiction.
  assert.equal(creatorFeeFlag(true, undefined), true);
  assert.equal(creatorFeeFlag(false, true), false);
  assert.equal(creatorFeeFlag(true, null), true);
  // A null column (written before migration 021) reads the publication.
  assert.equal(creatorFeeFlag(null, true), true);
  assert.equal(creatorFeeFlag(undefined, false), false);
  // Neither a real boolean: undefined, never false. A SQL null, a missing
  // publication and a non-boolean stand-in all read the same way.
  for (const stored of [null, undefined, "true", 1, 0, ""])
    for (const published of [null, undefined, "false", 0, {}])
      assert.equal(creatorFeeFlag(stored, published), undefined);
  // Undefined leaves the market without the key, and the served shape passes
  // the website's validator, which rejects a null flag.
  const market = {
    poolId: "0x" + "1".repeat(64),
    token: "0x" + "2".repeat(40),
    decimals: null,
    priceWei: null,
    window: "24h",
    volumeWei: null,
    trades: null,
    change: null,
    observations: [],
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 3600,
      fromTimestamp: null,
      truncated: false,
      candles: [],
    },
    coverage: {
      startBlock: null,
      cutoff: null,
      indexedAt: null,
      completeWindow: false,
      windowStart: null,
      priceBaseline: null,
      unitBasis: null,
      unitsConflict: false,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
  } as ObservedMarket;
  const absent = withCreatorFees(market, undefined);
  assert.equal(absent, market);
  assert.equal("creatorFees" in absent, false);
  for (const flag of [true, false]) {
    const served = withCreatorFees(market, flag);
    assert.equal(served.creatorFees, flag);
    assert.doesNotThrow(() =>
      assertObservedMarket(
        JSON.parse(JSON.stringify(served)),
        market.poolId,
        market.token,
        "24h",
      ),
    );
  }
  assert.throws(() =>
    assertObservedMarket(
      JSON.parse(JSON.stringify({ ...market, creatorFees: null })),
      market.poolId,
      market.token,
      "24h",
    ),
  );
});
