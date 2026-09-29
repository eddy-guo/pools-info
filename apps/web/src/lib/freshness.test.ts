import test from "node:test";
import assert from "node:assert/strict";
import {
  currentCut,
  freshnessStamp,
  indexedAgo,
  reportCut,
  stampBlock,
  stampLag,
} from "./freshness";

test("the lag prints exact seconds under a minute, then whole units", () => {
  assert.equal(indexedAgo(0), "0s");
  assert.equal(indexedAgo(8), "8s");
  assert.equal(indexedAgo(59), "59s");
  assert.equal(indexedAgo(60), "1m");
  assert.equal(indexedAgo(3599), "59m");
  assert.equal(indexedAgo(3600), "1h");
  assert.equal(indexedAgo(86399), "23h");
  assert.equal(indexedAgo(86400), "1d");
  assert.equal(indexedAgo(40 * 86400 + 5), "40d");
});

test("a clock behind the cut reads as just indexed, never negative", () => {
  assert.equal(indexedAgo(-30), "0s");
  assert.equal(indexedAgo(2.9), "2s");
});

test("the stamp's parts: a grouped block, and the lag from the cut", () => {
  assert.equal(stampBlock(0), "block 0");
  assert.equal(stampBlock(999), "block 999");
  assert.equal(stampBlock(12_845_102), "block 12,845,102");
  assert.equal(stampLag(1_790_000_000, 1_790_000_008), "indexed 8s ago");
  assert.equal(stampLag(1_790_000_000, 1_790_003_600), "indexed 1h ago");
  assert.equal(stampLag(1_790_000_010, 1_790_000_000), "indexed 0s ago");
});

test("the stamp names the block only when the read did", () => {
  assert.equal(
    freshnessStamp({ block: 12_845_102, asOf: 1_790_000_000 }, 1_790_000_008),
    "block 12,845,102 · indexed 8s ago",
  );
  assert.equal(
    freshnessStamp({ block: null, asOf: 1_790_000_000 }, 1_790_000_065),
    "indexed 1m ago",
  );
});

test("a cut naming its block wins over one that does not, then the newer", () => {
  assert.equal(currentCut(), null);
  reportCut("explore", { block: null, asOf: 100 });
  assert.deepEqual(currentCut(), { block: null, asOf: 100 });
  reportCut("stats", { block: 7, asOf: 90 });
  assert.deepEqual(currentCut(), { block: 7, asOf: 90 });
  reportCut("stats", null);
  assert.deepEqual(currentCut(), { block: null, asOf: 100 });
  reportCut("wallet", { block: null, asOf: 120 });
  assert.deepEqual(currentCut(), { block: null, asOf: 120 });
  reportCut("wallet", null);
  reportCut("explore", null);
  assert.equal(currentCut(), null);
  // Withdrawing a source that never reported changes nothing.
  reportCut("none", null);
  assert.equal(currentCut(), null);
});
