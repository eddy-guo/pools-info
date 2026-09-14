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
