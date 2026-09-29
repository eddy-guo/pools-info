import assert from "node:assert/strict";
import test from "node:test";
import { assertObservedMarket, type ObservedMarket } from "@pools/core";
import { ledgerStream } from "../../../packages/db/src/index";
import {
  creatorFeeFlag,
  ledgerFlow,
  ledgerLiveTradeRows,
  ledgerValues,
  ledgerWindowHour,
  ledgerWindowStart,
  marketSourceSetting,
  withCreatorFees,
  type LedgerCut,
} from "./ledger-market";

test("the API live-ring row bound matches the writer", () => {
  assert.equal(ledgerLiveTradeRows, ledgerStream.liveTradeRows);
});

test("MARKET_SOURCE: unset or broad serves the broad rollups, ledger the ledger, anything else refuses to start", () => {
  assert.equal(marketSourceSetting(undefined), "broad");
  assert.equal(marketSourceSetting(""), "broad");
  assert.equal(marketSourceSetting("broad"), "broad");
  assert.equal(marketSourceSetting("ledger"), "ledger");
  for (const value of ["Ledger", "aggregate", "on", "1", " ledger"])
    assert.throws(() => marketSourceSetting(value), /Invalid MARKET_SOURCE/);
});

test("ledger windows are whole hours ending with the newest hour, and 1h is the rolling hour the ring holds", () => {
  const cut: LedgerCut = {
    block: 1,
    hash: "0x" + "1".repeat(64),
    asOf: 497121 * 3600 + 177,
    startBlock: 0,
    newestHour: 497121,
    indexedAt: "2026-09-17T09:03:00.000Z",
    foldRule: 1,
    foldRuleSince: null,
  };
  assert.equal(ledgerWindowHour(cut, "24h"), 497121 - 23);
  assert.equal(ledgerWindowHour(cut, "6h"), 497121 - 5);
  assert.equal(ledgerWindowHour(cut, "7d"), 497121 - 167);
  assert.equal(ledgerWindowHour(cut, "30d"), 497121 - 719);
  assert.equal(ledgerWindowHour(cut, "All"), null);
  assert.equal(ledgerWindowHour({ ...cut, newestHour: 3 }, "24h"), 0);
  assert.equal(ledgerWindowStart(cut, "24h"), (497121 - 23) * 3600);
  assert.equal(ledgerWindowStart(cut, "All"), null);
  // 09:02:57 through 10:02:57, not the three minutes of the newest hour:
  // its first UTC hour is the one holding its start.
  assert.equal(ledgerWindowStart(cut, "1h"), 497120 * 3600 + 177);
  assert.equal(ledgerWindowHour(cut, "1h"), 497120);
  const hour = {
    start: 497120 * 3600 + 177,
    afterBlock: 10,
    beforeBlock: 11,
    hourAfterBlock: 9,
  };
  assert.equal(ledgerFlow("1h", hour), "ring");
  // A ring that does not hold the hour serves no 1h figure.
  assert.equal(ledgerFlow("1h", null), "none");
  for (const window of ["6h", "24h", "7d", "30d", "All"] as const)
    assert.equal(ledgerFlow(window, null), "hours");
  assert.deepEqual(ledgerValues(cut, "1h", hour), [
    1,
    497120,
    0,
    497120 * 3600 + 177,
    10,
    11,
    9,
  ]);
  assert.deepEqual(ledgerValues(cut, "1h", null), [1, 497120, 0]);
  assert.deepEqual(ledgerValues(cut, "24h", hour), [1, 497121 - 23, 0]);
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
