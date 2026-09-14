import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Rpc } from "@pools/chain";
import { withLogRpc } from "./log-rpc";
async function endpoint(chain = 4663) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const reply = (r: { id: number; method: string }) => {
      calls.push(r.method);
      return {
        jsonrpc: "2.0",
        id: r.id,
        result:
          r.method === "eth_chainId"
            ? `0x${chain.toString(16)}`
            : r.method === "eth_getLogs"
              ? []
              : "0x00",
      };
    };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(Array.isArray(input) ? input.map(reply) : reply(input)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
test("split RPC sends only logs to public provider, verifies chain and preserves the combined request budget", async () => {
  const state = await endpoint(),
    publicLogs = await endpoint();
  try {
    const limits = { maxRequests: 4, timeoutMs: 10000, logRangeBlocks: 1000 };
    const rpc = withLogRpc(
      new Rpc(state.url, limits),
      new Rpc(publicLogs.url, limits),
    );
    await rpc.call("eth_chainId", []);
    await rpc.logs(`0x${"1".repeat(40)}`, [], 100, 1099);
    await rpc.call("eth_call", [{}, "0x44"]);
    assert.deepEqual(state.calls, ["eth_chainId", "eth_call"]);
    assert.deepEqual(publicLogs.calls, ["eth_chainId", "eth_getLogs"]);
    assert.equal(rpc.requests, 4);
    await assert.rejects(
      rpc.logs(`0x${"1".repeat(40)}`, [], 1100, 1100),
      /Collection budget exceeded/,
    );
    assert.equal(publicLogs.calls.length, 2);
  } finally {
    await state.close();
    await publicLogs.close();
  }
});
test("public log endpoint on a different chain fails before collecting logs", async () => {
  const state = await endpoint(),
    publicLogs = await endpoint(1);
  try {
    const rpc = withLogRpc(new Rpc(state.url), new Rpc(publicLogs.url));
    await assert.rejects(
      rpc.logs(`0x${"1".repeat(40)}`, [], 100, 101),
      /Wrong chain/,
    );
    assert.deepEqual(publicLogs.calls, ["eth_chainId"]);
    assert.deepEqual(state.calls, []);
  } finally {
    await state.close();
    await publicLogs.close();
  }
});
