import test from "node:test";
import assert from "node:assert/strict";
import { recentBatchSuccess } from "./recent-budget";

test("observed production durations do not grow a near-budget batch", () => {
  let state = { batchBlocks: 250, goodCycles: 0 };
  for (const elapsedMs of [54039, 70049, 67041, 67045, 68045]) {
    state = recentBatchSuccess({
      ...state,
      maxBlocks: 1000,
      advanced: 250,
      elapsedMs,
      httpRequests: 71,
    });
  }
  assert.deepEqual(state, { batchBlocks: 250, goodCycles: 0 });
});

test("five full batches with headroom grow within the configured maximum", () => {
  let state = { batchBlocks: 250, goodCycles: 0 };
  for (let i = 0; i < 5; i++) {
    state = recentBatchSuccess({
      ...state,
      maxBlocks: 400,
      advanced: 250,
      elapsedMs: 40000,
      httpRequests: 90,
    });
  }
  assert.deepEqual(state, { batchBlocks: 400, goodCycles: 0 });
});

test("partial, idle, slow or request-heavy batches reset the growth streak", () => {
  const input = {
    batchBlocks: 250,
    goodCycles: 4,
    maxBlocks: 1000,
    advanced: 250,
    elapsedMs: 40000,
    httpRequests: 90,
  };
  for (const override of [
    { advanced: 249 },
    { advanced: 0 },
    { elapsedMs: 45001 },
    { httpRequests: 101 },
  ]) {
    assert.deepEqual(recentBatchSuccess({ ...input, ...override }), {
      batchBlocks: 250,
      goodCycles: 0,
    });
  }
});
