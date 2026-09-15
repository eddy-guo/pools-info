import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApi } from "./server";
import { parseRequest } from "./request";
import { readLiveTrades } from "./live-read";

const hash = "0x" + "a".repeat(64);
test("recent feed accepts only an optional validated pool and never caller-controlled bounds", () => {
  assert.equal(parseRequest("/v1/live-trades").route, "live-trades");
  assert.equal(parseRequest(`/v1/live-trades?poolId=${hash}`).poolId, hash);
  for (const suffix of [
    "?limit=1000",
    "?poolId=bad",
    `?poolId=${hash}&poolId=${hash}`,
    "?cursor=abc",
    "?q=pepe",
  ])
    assert.throws(() => parseRequest("/v1/live-trades" + suffix));
});
test("recent feed distinguishes uninitialized, quiet current and stale worker without RPC or trade-time freshness", async () => {
  const now = Date.parse("2026-09-14T12:00:00Z"),
    seconds = now / 1000;
  let rows: any[] = [];
  const query = async (sql: string) => ({
    rows: sql.includes("SELECT 1 FROM recent_pools")
      ? []
      : sql.includes("FROM recent_streams")
        ? rows
        : sql.includes("count(*)")
          ? [{ count: "5" }]
          : [],
  });
  let result = await readLiveTrades(query, null, now);
  assert.equal(result.coverage.state, "uninitialized");
  assert.deepEqual(result.events, []);
  rows = ["discovery", "swaps"].map((stream_key) => ({
    stream_key,
    start_block: "100",
    cursor_block: "200",
    cursor_hash: hash,
    boundary_hash: hash,
    boundary_timestamp: seconds - 15,
    cursor_timestamp: seconds - 15,
    head_block: "328",
    head_timestamp: seconds - 2,
    checked_at: new Date(now - 1000),
  }));
  result = await readLiveTrades(query, null, now);
  assert.equal(result.coverage.state, "current");
  assert.equal(result.coverage.lagBlocks, 128);
  assert.equal(result.coverage.asOf, seconds - 15);
  assert.equal(result.events.length, 0); // A quiet chain has fresh header evidence too.
  result = await readLiveTrades(query, null, now + 121000);
  assert.equal(result.coverage.state, "stale");
  rows[0].boundary_hash = "0x" + "b".repeat(64);
  await assert.rejects(
    readLiveTrades(query, null, now),
    /recent_boundary_unavailable/,
  );
  rows[0].boundary_hash = hash;
  rows[0].cursor_block = null;
  result = await readLiveTrades(query, null, now);
  assert.equal(result.coverage.state, "uninitialized");
});
test("recent feed HTTP reads replace rewound windows immediately instead of retaining the response cache", async (t) => {
  let events = [{ id: "old:1" }],
    calls = 0;
  const server = createApi({
    async read() {
      calls++;
      return { events, replacement: true };
    },
    async close() {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/live-trades`;
  assert.deepEqual((await (await fetch(url)).json()).events, events);
  events = [];
  const replaced = await fetch(url);
  assert.deepEqual((await replaced.json()).events, []);
  assert.equal(replaced.headers.get("cache-control"), "no-store");
  assert.equal(calls, 2);
});
