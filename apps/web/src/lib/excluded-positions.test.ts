import test from "node:test";
import assert from "node:assert/strict";
import {
  UNATTRIBUTED_SWAP_REASON,
  excludedPositionsCaption,
  unattributedSwapExclusions,
} from "./excluded-positions";

const byFlag = (unattributed_swap_activity: number, others = 0) => ({
  zero_cost_inflow: others,
  unattributed_outflow: others,
  unknown_basis: others,
  unattributed_swap_activity,
});

test("the caption names the unattributed-swap count with the site's count wording", () => {
  assert.equal(
    excludedPositionsCaption({ excludedByFlag: byFlag(1) }),
    "1 position excluded (pooled or unattributed swap)",
  );
  assert.equal(
    excludedPositionsCaption({ excludedByFlag: byFlag(5) }),
    "5 positions excluded (pooled or unattributed swap)",
  );
  assert.equal(
    excludedPositionsCaption({ excludedByFlag: byFlag(1234) }),
    "1,234 positions excluded (pooled or unattributed swap)",
  );
});

test("the reason names what the flag covers, never a pooled sell alone", () => {
  // A pooled buy and a transaction with several swaps of one pool carry the
  // same flag as a pooled sell, so the label must not claim a sale.
  assert.equal(UNATTRIBUTED_SWAP_REASON, "pooled or unattributed swap");
  assert.doesNotMatch(UNATTRIBUTED_SWAP_REASON, /sold|sell/);
});

test("nothing to disclose renders no caption rather than a zero", () => {
  assert.equal(excludedPositionsCaption({ excludedByFlag: byFlag(0) }), null);
  // Exclusions for other flags alone (a zero-cost inflow, an unattributed
  // outflow, an unknown basis) are not this caption's.
  assert.equal(
    excludedPositionsCaption({ excludedByFlag: byFlag(0, 3) }),
    null,
  );
  // The accounting fallback classifies no exclusion by ledger flag.
  assert.equal(excludedPositionsCaption({ excludedByFlag: null }), null);
  assert.equal(unattributedSwapExclusions({ excludedByFlag: null }), 0);
});

test("the count is the unattributed-swap flag's alone, not the total", () => {
  assert.equal(unattributedSwapExclusions({ excludedByFlag: byFlag(2, 9) }), 2);
  assert.equal(
    excludedPositionsCaption({ excludedByFlag: byFlag(2, 9) }),
    "2 positions excluded (pooled or unattributed swap)",
  );
});
