import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Rpc, RpcRateLimitExhausted, type RpcRateLimitEvent } from "./rpc";

async function endpoint(kind: "http" | "json_rpc", rejected: number) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body),
      rows = Array.isArray(input) ? input : [input];
    const limited = requests++ < rejected;
    res.statusCode = limited && kind === "http" ? 429 : 200;
    const output = rows.map((r) =>
      limited
        ? {
            id: r.id,
            error: {
              code: kind === "json_rpc" ? 429 : -32000,
              message: "secret_url https://provider.invalid/private_key",
            },
          }
        : { id: r.id, result: r.params[0] },
    );
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(input) ? output : output[0]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/private_key`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("recovered provider 429 is reported without provider secrets", async () => {
  const provider = await endpoint("http", 1);
  const events: RpcRateLimitEvent[] = [];
  try {
    const rpc = new Rpc(provider.url, {
      onRateLimit: (event) => events.push(event),
    });
    assert.equal(await rpc.call("eth_blockNumber", ["0x100"]), "0x100");
    assert.equal(provider.requests(), 2);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      source: "http",
      methods: ["eth_blockNumber"],
      batchCalls: 1,
      throttledCalls: 1,
      attempt: 1,
      httpRequests: 1,
      rpcCalls: 1,
    });
    assert.doesNotMatch(
      JSON.stringify(events),
      /private_key|secret_url|provider.invalid|0x100/,
    );
  } finally {
    await provider.close();
  }
});

for (const kind of ["http", "json_rpc"] as const) {
  for (const mode of ["single", "batch"] as const) {
    test(`${kind} 429 ${mode} exhausts exactly four attempts and cannot restart the same client`, async () => {
      const provider = await endpoint(kind, Infinity);
      const events: RpcRateLimitEvent[] = [];
      try {
        const rpc = new Rpc(provider.url, {
          onRateLimit: (event) => events.push(event),
        });
        const call = () =>
          mode === "single"
            ? rpc.call("eth_getLogs", ["sensitive_param"])
            : rpc.batch("eth_getLogs", [
                ["sensitive_param"],
                ["sensitive_param2"],
              ]);
        await assert.rejects(call(), RpcRateLimitExhausted);
        assert.equal(provider.requests(), 4);
        assert.deepEqual(
          events.map((e) => e.attempt),
          [1, 2, 3, 4],
        );
        assert.ok(events.every((e) => e.source === kind));
        await assert.rejects(
          rpc.call("eth_blockNumber", []),
          RpcRateLimitExhausted,
        );
        assert.equal(provider.requests(), 4);
        assert.doesNotMatch(
          JSON.stringify(events),
          /private_key|secret_url|provider.invalid|sensitive_param/,
        );
      } finally {
        await provider.close();
      }
    });
  }
}

test("recovered JSON-RPC throttling is reported and unknown method text is redacted", async () => {
  const provider = await endpoint("json_rpc", 1);
  const events: RpcRateLimitEvent[] = [];
  try {
    const rpc = new Rpc(provider.url, {
      onRateLimit: (event) => events.push(event),
    });
    assert.deepEqual(
      await rpc.batch("method_containing_private_key", [[1], [2]]),
      [1, 2],
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].methods, ["other"]);
    assert.equal(events[0].throttledCalls, 2);
    assert.equal(events[0].source, "json_rpc");
    assert.doesNotMatch(
      JSON.stringify(events),
      /private_key|secret_url|provider.invalid/,
    );
  } finally {
    await provider.close();
  }
});
