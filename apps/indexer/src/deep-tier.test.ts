import test from "node:test";
import assert from "node:assert/strict";
import { deepTierEnabled } from "./deep-tier";
test("the deep tier runs unless INDEXER_DEEP_TIER_ENABLED is exactly 0", () => {
  assert.equal(deepTierEnabled(undefined), true);
  assert.equal(deepTierEnabled("1"), true);
  assert.equal(deepTierEnabled("0"), false);
  for (const invalid of ["", "true", "off", "2"])
    assert.throws(() => deepTierEnabled(invalid), /INDEXER_DEEP_TIER_ENABLED/);
});
