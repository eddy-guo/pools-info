import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  encodeCursor,
  parseRequest,
  RequestError,
  searchPattern,
} from "./request";
import { createApi } from "./server";
import { readData } from "./reader";

const hash = (s: string) => "0x" + s.repeat(64);
test("rejects invalid parameters, duplicate parameters, cross-query and malformed cursors", () => {
  for (const url of [
    "/v1/pools?limit=0",
    "/v1/pools?limit=101",
    "/v1/pools?limit=1&limit=2",
    "/v1/status?q=a",
    "/v1/trades?poolId=garbage",
    "/v1/pools?cursor=bad",
    "/v1/feed",
    `/v1/feed?pools=${hash("a")},${hash("a")}`,
  ])
    assert.throws(() => parseRequest(url), RequestError);
  const request = parseRequest("/v1/pools?q=pepe");
  const cursor = encodeCursor(request.scope, ["123", hash("a")]);
  assert.deepEqual(parseRequest(`/v1/pools?q=pepe&cursor=${cursor}`).cursor, [
    "123",
    hash("a"),
  ]);
  assert.throws(
    () => parseRequest(`/v1/pools?q=dog&cursor=${cursor}`),
    /invalid_cursor/,
  );
  const huge = encodeCursor(request.scope, ["9223372036854775808", hash("a")]);
  assert.throws(
    () => parseRequest(`/v1/pools?q=pepe&cursor=${huge}`),
    /invalid_cursor/,
  );
  assert.equal(searchPattern("a_%'"), "%a\\_\\%'%");
});

test("SQL text search is parameterized and wildcards are escaped", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  await readData(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  }, parseRequest("/v1/pools?q=%27%3Bdrop%20table%20x--%25"));
  assert(!calls[0].sql.includes("drop table"));
  assert.deepEqual(calls[0].values, ["%';drop table x--\\%%", 26]);
});

test("HTTP rejects mutations, coalesces/caches reads, limits traffic and hides DB errors", async (t) => {
  let calls = 0,
    now = 0;
  const server = createApi(
    {
      async read(r) {
        calls++;
        if (r.route === "ready") throw Error("postgres://user:secret@host");
        return { items: [] };
      },
      async close() {},
    },
    { now: () => now, maxPerMinute: 4 },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal(
    (await fetch(url + "/v1/pools", { method: "POST" })).status,
    405,
  );
  await Promise.all([fetch(url + "/v1/pools"), fetch(url + "/v1/pools")]);
  assert.equal(calls, 1);
  const head = await fetch(url + "/v1/pools", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const error = await fetch(url + "/ready");
  assert.equal(error.status, 503);
  assert.deepEqual(await error.json(), {
    error: "data_temporarily_unavailable",
  });
  assert.equal((await fetch(url + "/v1/pools")).status, 429);
  assert.equal((await fetch(url + "/health")).status, 200);
  now = 61000;
  assert.equal((await fetch(url + "/v1/pools")).status, 200);
  assert.equal(calls, 3);
});

test("feed fails closed if streams are absent or have no shared indexed interval", async () => {
  const req = parseRequest(`/v1/feed?pools=${hash("a")}`);
  await assert.rejects(
    readData(async () => ({ rows: [] }), req),
    /feed_coverage_unavailable/,
  );
  await assert.rejects(
    readData(
      async () => ({ rows: [{ start_block: "100", cursor_block: null }] }),
      req,
    ),
    /feed_coverage_unavailable/,
  );
});
