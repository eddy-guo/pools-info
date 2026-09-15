import test from "node:test";
import assert from "node:assert/strict";
import { rpcPacing } from "./rpc-pacing";

test("pacing preserves defaults and rejects accidental blank or malformed overrides", () => {
  assert.deepEqual(rpcPacing({}), { minIntervalMs: 1000, maxBatchSize: 2 });
  assert.deepEqual(
    rpcPacing({ RPC_MIN_INTERVAL_MS: "250", RPC_MAX_BATCH_SIZE: "10" }),
    { minIntervalMs: 250, maxBatchSize: 10 },
  );
  for (const raw of ["", " ", "NaN", "1.5", "-1", "10001"])
    assert.throws(
      () => rpcPacing({ RPC_MIN_INTERVAL_MS: raw }),
      /RPC_MIN_INTERVAL_MS/,
    );
  for (const raw of ["", "0", "21", "1.5", "Infinity"])
    assert.throws(
      () => rpcPacing({ RPC_MAX_BATCH_SIZE: raw }),
      /RPC_MAX_BATCH_SIZE/,
    );
});
