import test from "node:test";
import assert from "node:assert/strict";
import { HyperSyncPageCapacity, HyperSyncUnauthorized } from "@pools/chain";
import {
  throwIfHyperSyncPageCapacity,
  throwIfHyperSyncUnauthorized,
  workerFailureExitCode,
} from "./rpc-operations";
import {
  BROAD_CAPACITY_EXIT_CODE,
  HYPERSYNC_UNAUTHORIZED_EXIT_CODE,
} from "./supervisor";

// A separate process (per-file test isolation) from rpc-operations.test.ts:
// the sticky exit-code flags are process-local, and that file's rate-limit
// test permanently marks its own stop for the rest of its process.
test("a HyperSync page over its own caps exits like the broad worker's overflow", () => {
  assert.equal(workerFailureExitCode(Error("generic")), 1);
  const capacity = new HyperSyncPageCapacity(100, 101, 10001, 1000);
  assert.doesNotThrow(() => throwIfHyperSyncPageCapacity(Error("generic")));
  assert.throws(
    () => throwIfHyperSyncPageCapacity(capacity),
    (e) => e === capacity,
  );
  assert.equal(workerFailureExitCode(capacity), BROAD_CAPACITY_EXIT_CODE);
  // Sticky like the other reserved stops: a later cleanup failure must not
  // fall back to the restarting default.
  assert.equal(
    workerFailureExitCode(Error("DB cleanup failed")),
    BROAD_CAPACITY_EXIT_CODE,
  );
});

test("a HyperSync token Envio rejected gets its own reserved, sticky exit", () => {
  // Runs after the capacity test above in the same process, so a prior
  // sticky flag (not this test's concern) may already shadow the generic
  // default; only this test's own error/flag pairing is asserted here.
  const unauthorized = new HyperSyncUnauthorized(401);
  assert.doesNotThrow(() => throwIfHyperSyncUnauthorized(Error("generic")));
  assert.throws(
    () => throwIfHyperSyncUnauthorized(unauthorized),
    (e) => e === unauthorized,
  );
  assert.equal(
    workerFailureExitCode(unauthorized),
    HYPERSYNC_UNAUTHORIZED_EXIT_CODE,
  );
  assert.equal(
    workerFailureExitCode(Error("DB cleanup failed")),
    HYPERSYNC_UNAUTHORIZED_EXIT_CODE,
  );
});
