import test from "node:test";
import assert from "node:assert/strict";
import { RpcRateLimitExhausted, type RpcRateLimitEvent } from "@pools/chain";
import {
  rpcRateLimitObserver,
  throwIfRateLimitExhausted,
  workerFailureExitCode,
} from "./rpc-operations";
import { RPC_RATE_LIMIT_EXIT_CODE } from "./supervisor";
import { safeError } from "./errors";

test("all workers report recovered429 and a known terminal pause survives cleanup failure", (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (value: string) => logged.push(value));
  const event: RpcRateLimitEvent = {
    source: "json_rpc",
    methods: ["eth_call"],
    batchCalls: 10,
    throttledCalls: 2,
    attempt: 1,
    httpRequests: 1,
    rpcCalls: 10,
  };
  assert.equal(workerFailureExitCode(Error("generic")), 1);
  assert.doesNotThrow(() => throwIfRateLimitExhausted(Error("generic")));
  for (const worker of ["main", "recent", "analytics"] as const)
    rpcRateLimitObserver(worker)(event);
  assert.deepEqual(
    logged.map((v) => JSON.parse(v).worker),
    ["main", "recent", "analytics"],
  );
  assert.ok(logged.every((v) => JSON.parse(v).event === "rpc_rate_limited"));
  assert.equal(
    workerFailureExitCode(Error("generic after recovered limit")),
    1,
  );
  rpcRateLimitObserver("analytics")({ ...event, attempt: 4 });
  const terminal = new RpcRateLimitExhausted();
  assert.throws(
    () => throwIfRateLimitExhausted(terminal),
    (e) => e === terminal,
  );
  assert.equal(workerFailureExitCode(terminal), RPC_RATE_LIMIT_EXIT_CODE);
  assert.equal(
    workerFailureExitCode(Error("DB cleanup failed")),
    RPC_RATE_LIMIT_EXIT_CODE,
  );
  assert.match(
    safeError(terminal),
    /rpc_rate_limit_exhausted.*manually restarting/,
  );
});
