import test from "node:test";
import assert from "node:assert/strict";
import { errorDetails, safeError } from "./errors";
test("collector diagnostics distinguish provider rejection, network failure and database constraints", () => {
  assert.match(safeError(Error("RPC HTTP 403")), /rpc_access_denied/);
  assert.match(safeError(Error("RPC HTTP 400")), /rpc_request_rejected/);
  assert.match(safeError(Error("RPC HTTP 429")), /rpc_unavailable/);
  assert.match(
    safeError(Error("Incomplete RPC batch")),
    /rpc_batch_incomplete/,
  );
  assert.match(
    safeError(Error("RPC response ID mismatch")),
    /rpc_response_id_mismatch/,
  );
  const network = new TypeError("fetch failed", {
    cause: { code: "ECONNRESET" },
  });
  assert.equal(errorDetails(network).networkCode, "ECONNRESET");
  assert.match(safeError(network), /network_failed/);
  const conflict = Object.assign(
    Error("duplicate key details contain private SQL"),
    { code: "23505" },
  );
  assert.equal(errorDetails(conflict).sqlState, "23505");
  assert.match(safeError(conflict), /database_constraint_failed: 23505/);
  assert.match(
    safeError(Object.assign(Error("private SQL"), { code: "57014" })),
    /database_timeout/,
  );
});
test("diagnostics never echo URLs, credentials, SQL, arbitrary codes or attacker-controlled names", () => {
  const secret = "https://example.test/key?token=private_secret";
  for (const e of [
    Object.assign(Error(secret), {
      code: secret,
      name: secret,
      cause: { code: secret },
    }),
    { message: secret, name: secret, code: secret },
    new TypeError(secret),
  ]) {
    const output = JSON.stringify({ error: safeError(e), ...errorDetails(e) });
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("private_secret"));
    assert.equal(errorDetails(e).sqlState, null);
    assert.equal(errorDetails(e).networkCode, null);
  }
});
