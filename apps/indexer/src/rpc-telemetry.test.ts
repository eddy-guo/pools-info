import test from "node:test";
import assert from "node:assert/strict";
import { Rpc } from "@pools/chain";
import { withLogRpc } from "./log-rpc";
import { trackRpcMethods } from "./rpc-telemetry";

test("split-provider logical telemetry counts log constituents and shared verification without double counting", async (t) => {
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests++;
      const body = JSON.parse(String(init.body));
      const reply = (r: { id: number; method: string }) => ({
        id: r.id,
        result: r.method === "eth_chainId" ? "0x1237" : [],
      });
      return Response.json(Array.isArray(body) ? body.map(reply) : reply(body));
    },
  );
  const counts = {};
  const state = trackRpcMethods(
    new Rpc("http://127.0.0.1:1/state", { minIntervalMs: 0 }),
    counts,
  );
  const logs = trackRpcMethods(
    new Rpc("http://127.0.0.1:1/logs", {
      minIntervalMs: 0,
      logRangeBlocks: 10,
    }),
    counts,
  );
  const rpc = withLogRpc(state, logs);
  await rpc.call("eth_chainId", []);
  assert.deepEqual(await rpc.logs("0x123", [], 100, 129), []);
  assert.deepEqual(counts, { eth_chainId: 2, eth_getLogs: 3 });
  assert.equal(rpc.calls, 5);
  assert.equal(rpc.requests, requests);
  assert.equal(state.methodCounts, logs.methodCounts);
});
