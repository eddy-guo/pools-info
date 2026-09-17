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

test("creators requests validate their own vocabulary", () => {
  const parsed = parseRequest("/v1/creators");
  assert.equal(parsed.route, "creators");
  assert.deepEqual(parsed.creators, {
    window: "All",
    limit: 25,
    offset: 0,
    sort: "launches",
    direction: "desc",
  });
  assert.equal(
    parseRequest("/v1/creators?sort=median&direction=asc&window=7d&limit=100")
      .creators.sort,
    "median",
  );
  for (const [url, code] of [
    ["/v1/creators?sort=launch", "invalid_sort"],
    ["/v1/creators?sort=trades", "invalid_sort"],
    ["/v1/creators?direction=up", "invalid_direction"],
    ["/v1/creators?window=1d", "invalid_window"],
    ["/v1/creators?limit=0", "invalid_limit"],
    ["/v1/creators?limit=101", "invalid_limit"],
    ["/v1/creators?offset=-1", "invalid_offset"],
    ["/v1/creators?q=x", "invalid_parameter"],
    ["/v1/creators?sort=volume&sort=volume", "invalid_parameter"],
  ])
    assert.throws(
      () => parseRequest(url),
      (error: unknown) =>
        error instanceof RequestError &&
        error.status === 400 &&
        error.code === code,
      url,
    );
});

test("SQL text search is parameterized and wildcards are escaped", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  await readData(async (sql, values) => {
    calls.push({ sql, values });
    return { rows: [] };
  }, parseRequest("/v1/pools?q=%27%3Bdrop%20table%20x--%25"));
  assert(!calls.at(-1)!.sql.includes("drop table"));
  assert.deepEqual(calls.at(-1)!.values, ["%';drop table x--\\%%", 26]);
});

test("HTTP rejects mutations, coalesces/caches reads, limits traffic and hides DB errors", async (t) => {
  let calls = 0,
    now = 0;
  const server = createApi(
    {
      async read(r) {
        calls++;
        if (r.route === "ready")
          throw Object.assign(Error("postgres://user:secret@host"), {
            code: "57014",
          });
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
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const error = await fetch(url + "/ready").finally(() => {
    process.stderr.write = write;
  });
  assert.equal(error.status, 503);
  assert.deepEqual(await error.json(), {
    error: "data_temporarily_unavailable",
  });
  // The log names the failure class by SQLSTATE and never the message.
  assert.deepEqual(lines, ['{"event":"read_failed","code":"57014"}\n']);
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
