import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Rpc } from "./rpc";

async function server(
  reply: (requests: { id: number; params: unknown[] }[]) => unknown,
) {
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply(JSON.parse(body))));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
test("JSON-RPC batching preserves caller order when replies arrive reversed", async () => {
  const endpoint = await server((rows) =>
    rows
      .map((row) => ({ jsonrpc: "2.0", id: row.id, result: row.params[0] }))
      .reverse(),
  );
  try {
    const rpc = new Rpc(endpoint.url);
    assert.deepEqual(await rpc.batch("example", [[1], [2], [3]]), [1, 2, 3]);
    assert.equal(rpc.requests, 1);
    assert.equal(rpc.calls, 3);
  } finally {
    await endpoint.close();
  }
});
test("missing and duplicate batch replies fail instead of shifting block or receipt attribution", async () => {
  const endpoint = await server((rows) => [
    { id: rows[0].id, result: "first" },
    { id: rows[0].id, result: "duplicate" },
  ]);
  try {
    await assert.rejects(
      new Rpc(endpoint.url).batch("example", [[1], [2]]),
      /Duplicate/,
    );
  } finally {
    await endpoint.close();
  }
  const missing = await server((rows) => [{ id: rows[0].id, result: "first" }]);
  try {
    await assert.rejects(
      new Rpc(missing.url).batch("example", [[1], [2]]),
      /Incomplete/,
    );
  } finally {
    await missing.close();
  }
});
test("batches stay bounded at twenty calls per HTTP request", async () => {
  const sizes: number[] = [];
  const endpoint = await server((rows) => {
    sizes.push(rows.length);
    return rows.map((row) => ({ id: row.id, result: row.params[0] }));
  });
  try {
    const rpc = new Rpc(endpoint.url);
    const values = await rpc.batch(
      "example",
      Array.from({ length: 45 }, (_, i) => [i]),
    );
    assert.equal(values.length, 45);
    assert.deepEqual(sizes, [20, 20, 5]);
  } finally {
    await endpoint.close();
  }
});

async function rangeLimitedServer() {
  const accepted: [number, number][] = [];
  let rejected = 0;
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const rows = Array.isArray(input) ? input : [input];
    const results = rows.map((row) => {
      const { fromBlock, toBlock } = row.params[0];
      const from = Number(fromBlock),
        to = Number(toBlock);
      if (to - from + 1 > 10) {
        rejected++;
        res.statusCode = 400;
        return {
          id: row.id,
          error: {
            code: -32600,
            message:
              "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
          },
        };
      }
      accepted.push([from, to]);
      return { id: row.id, result: [] };
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(input) ? results : results[0]));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    accepted,
    rejected: () => rejected,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
test("provider HTTP 400 range limits are learned once and paged without gaps", async () => {
  const endpoint = await rangeLimitedServer();
  try {
    const rpc = new Rpc(endpoint.url);
    assert.deepEqual(await rpc.logs("0x123", [], 100, 124), []);
    assert.deepEqual(endpoint.accepted, [
      [100, 109],
      [110, 119],
      [120, 124],
    ]);
    assert.equal(endpoint.rejected(), 1);
    assert.equal(rpc.requests, 2); // One rejected probe, one batch for all small ranges.
    await rpc.logs("0x123", [], 125, 134);
    assert.equal(endpoint.rejected(), 1);
    assert.deepEqual(endpoint.accepted.at(-1), [125, 134]);
  } finally {
    await endpoint.close();
  }
});
test("adapting a provider range never bypasses the request budget", async () => {
  const endpoint = await rangeLimitedServer();
  try {
    await assert.rejects(
      new Rpc(endpoint.url, { maxRequests: 1 }).logs("0x123", [], 100, 124),
      /budget exceeded/,
    );
    assert.equal(endpoint.accepted.length, 0);
  } finally {
    await endpoint.close();
  }
});

test("partial HTTP 200 throttling retries only rejected calls and preserves order", async () => {
  const batches: number[][] = [];
  const endpoint = await server((rows) => {
    batches.push(rows.map((r) => r.id));
    return rows
      .map((row, i) =>
        batches.length === 1 && i === 1
          ? {
              id: row.id,
              error: { code: 429, message: "Provider throughput exhausted" },
            }
          : { id: row.id, result: row.params[0] },
      )
      .reverse();
  });
  try {
    const rpc = new Rpc(endpoint.url);
    assert.deepEqual(
      await rpc.batch("example", [[11], [22], [33], [44]]),
      [11, 22, 33, 44],
    );
    assert.deepEqual(batches, [[1, 2, 3, 4], [2]]);
    assert.equal(rpc.requests, 2);
  } finally {
    await endpoint.close();
  }
});

test("configured batch size bounds initial provider bursts", async () => {
  const sizes: number[] = [];
  const endpoint = await server((rows) => {
    sizes.push(rows.length);
    return rows.map((row) => ({ id: row.id, result: row.params[0] }));
  });
  try {
    const rpc = new Rpc(endpoint.url, { maxBatchSize: 5 });
    assert.deepEqual(
      await rpc.batch(
        "example",
        Array.from({ length: 12 }, (_, i) => [i]),
      ),
      Array.from({ length: 12 }, (_, i) => i),
    );
    assert.deepEqual(sizes, [5, 5, 2]);
    assert.throws(
      () => new Rpc(endpoint.url, { maxBatchSize: 0 }),
      /batch size/,
    );
  } finally {
    await endpoint.close();
  }
});

test("mixed throttled and unknown errors fail closed instead of returning partial results", async () => {
  const endpoint = await server((rows) =>
    rows.map((row, i) => ({
      id: row.id,
      error: { code: i === 0 ? 429 : -32000, message: "Not safe to expose" },
    })),
  );
  try {
    await assert.rejects(
      new Rpc(endpoint.url).batch("example", [[1], [2]]),
      /RPC returned an error/,
    );
  } finally {
    await endpoint.close();
  }
});

test("throttled partial batches still obey the total request budget", async () => {
  let sent = 0;
  const endpoint = await server((rows) => {
    sent++;
    return rows.map((row) => ({
      id: row.id,
      error: { code: 429, message: "Throttled" },
    }));
  });
  try {
    await assert.rejects(
      new Rpc(endpoint.url, { maxRequests: 1 }).batch("example", [[1], [2]]),
      /budget exceeded/,
    );
    assert.equal(sent, 1);
  } finally {
    await endpoint.close();
  }
});
