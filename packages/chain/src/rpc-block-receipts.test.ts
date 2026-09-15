import test from "node:test";
import assert from "node:assert/strict";
import {
  Rpc,
  RpcResponseCapacity,
  RpcRateLimitExhausted,
  blockReceiptPolicy,
} from "./rpc";

test("block receipt transport caps batches at two and preserves reordered reply identity", async (t) => {
  const sizes: number[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const rows = JSON.parse(String(init.body));
      sizes.push(rows.length);
      return Response.json(
        rows.reverse().map((r: { id: number; params: unknown[] }) => ({
          id: r.id,
          result: r.params,
        })),
      );
    },
  );
  const rpc = new Rpc("http://127.0.0.1:1/mock", { maxBatchSize: 10 });
  const params = Array.from({ length: 7 }, (_, i) => [`0x${i}`]);
  assert.deepEqual(await rpc.batch("eth_getBlockReceipts", params), params);
  assert.deepEqual(sizes, [2, 2, 2, 1]);
  assert.equal(rpc.calls, 7);
});

test("block response byte limit applies to streamed HTTP bytes before parsing, cancels and never retries", async (t) => {
  for (const declared of [false, true])
    await t.test(String(declared), async (sub) => {
      let cancelled = false,
        pulls = 0;
      sub.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: declared
                ? {
                    "content-length": String(
                      blockReceiptPolicy.maxResponseBytes + 1,
                    ),
                  }
                : {},
            },
          ),
      );
      const rpc = new Rpc("http://127.0.0.1:1/mock");
      await assert.rejects(
        rpc.batch("eth_getBlockReceipts", [["0x1"]]),
        RpcResponseCapacity,
      );
      assert.equal(rpc.requests, 1);
      assert.equal(cancelled, true);
      assert.ok(pulls <= 10);
    });
});

test("HTTP 429 wins over an oversized body and exhaustion remains sticky", async (t) => {
  let cancelled = 0;
  const events: string[][] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {
          status: 429,
          headers: {
            "content-length": String(blockReceiptPolicy.maxResponseBytes + 1),
          },
        },
      ),
  );
  const rpc = new Rpc("http://127.0.0.1:1/mock", {
    onRateLimit: (e) => events.push(e.methods),
  });
  await assert.rejects(
    rpc.batch("eth_getBlockReceipts", [["0x1"]]),
    RpcRateLimitExhausted,
  );
  await assert.rejects(rpc.call("eth_blockNumber", []), RpcRateLimitExhausted);
  assert.equal(rpc.requests, 4);
  assert.equal(cancelled, 4);
  assert.deepEqual(
    events,
    Array.from({ length: 4 }, () => ["eth_getBlockReceipts"]),
  );
});

test("JSON 429 retries only throttled block calls and preserves successful results", async (t) => {
  const batches: number[][] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const rows = JSON.parse(String(init.body)) as { id: number }[];
      batches.push(rows.map((r) => r.id));
      return Response.json(
        rows.map((r) =>
          r.id === 2 && batches.length === 1
            ? { id: r.id, error: { code: 429 } }
            : { id: r.id, result: [r.id] },
        ),
      );
    },
  );
  assert.deepEqual(
    await new Rpc("http://127.0.0.1:1/mock").batch("eth_getBlockReceipts", [
      ["0x1"],
      ["0x2"],
    ]),
    [[1], [2]],
  );
  assert.deepEqual(batches, [[1, 2], [2]]);
});

test("block fetch cancellation stops retries and cancels its response body", async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort(Error("cancelled"));
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const rpc = new Rpc("http://127.0.0.1:1/mock").withAbortSignal(
    controller.signal,
  );
  await assert.rejects(
    rpc.batch("eth_getBlockReceipts", [["0x1"]]),
    /cancelled/,
  );
  assert.equal(rpc.requests, 1);
  assert.equal(cancelled, true);
  await assert.rejects(rpc.call("eth_blockNumber", []), /cancelled/);
  assert.equal(rpc.requests, 1);
});

test("block response IDs and HTTP budgets reject incomplete evidence", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const rows = JSON.parse(String(init.body));
      return Response.json(rows.map(() => ({ id: 999, result: [] })));
    },
  );
  await assert.rejects(
    new Rpc("http://127.0.0.1:1/mock").batch("eth_getBlockReceipts", [["0x1"]]),
    /ID|Incomplete/,
  );
  await assert.rejects(
    new Rpc("http://127.0.0.1:1/mock", { maxRequests: 0 }).batch(
      "eth_getBlockReceipts",
      [["0x1"]],
    ),
    /budget exceeded/,
  );
});
