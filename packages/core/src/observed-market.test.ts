import assert from "node:assert/strict";
import test from "node:test";
import { assertObservedMarket, type ObservedMarket } from "./observed-market";
const id = "0x" + "1".repeat(64),
  token = "0x" + "2".repeat(40),
  hash = "0x" + "3".repeat(64);
function fixture(): ObservedMarket {
  return {
    poolId: id,
    token,
    decimals: 18,
    priceWei: "900719925474099300001",
    window: "24h",
    volumeWei: "900719925474099300003",
    trades: 1,
    change: null,
    observations: [],
    coverage: {
      startBlock: 100,
      cutoff: { block: 200, hash, asOf: 200000 },
      unitBasis: {
        block: 200,
        hash,
        asOf: 200000,
        decimals: 18,
        source: "broad_token_units",
      },
      unitsConflict: false,
      indexedAt: "2026-09-15T00:00:00Z",
      completeWindow: false,
      windowStart: 113600,
      priceBaseline: null,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 60,
      fromTimestamp: 199980,
      truncated: false,
      candles: [
        {
          time: 199980,
          open: "900719925474099300001",
          high: "900719925474099300003",
          low: "900719925474099300000",
          close: "900719925474099300002",
          volume: "900719925474099300003",
        },
      ],
    },
  };
}
test("observed market boundary validates exact amounts and rejects fabricated coverage, units, identities and candles", () => {
  assert.doesNotThrow(() => assertObservedMarket(fixture(), id, token, "24h"));
  const changes: ((v: ObservedMarket) => void)[] = [
    (v) => {
      v.poolId = hash;
    },
    (v) => {
      v.priceWei = "1e18";
    },
    (v) => {
      v.coverage.unitBasis!.hash = id;
    },
    (v) => {
      v.coverage.cutoff = null;
    },
    (v) => {
      v.coverage.priceBaseline = { block: 201, hash, asOf: 100000 };
    },
    (v) => {
      v.decimals = null;
    },
    (v) => {
      v.coverage.unitsConflict = true;
    },
    (v) => {
      v.history.candles[0].low = "900719925474099300003";
    },
    (v) => {
      v.history.candles.push({ ...v.history.candles[0] });
    },
    (v) => {
      v.history.candles[0].volume = "-1";
    },
    (v) => {
      v.history.candles[0].time = 200040;
    },
    (v) => {
      v.observations = [
        {
          id: `${hash}:0`,
          transactionHash: hash,
          logIndex: 0,
          block: 201,
          blockHash: hash,
          timestamp: 200000,
          side: null,
          ethWei: "0",
          tokenRaw: null,
        },
      ];
    },
  ];
  for (const change of changes) {
    const v = fixture();
    change(v);
    assert.throws(() => assertObservedMarket(v, id, token, "24h"));
  }
  assert.throws(() => assertObservedMarket(fixture(), id, token, "All"));
});
