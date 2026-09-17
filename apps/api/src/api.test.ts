import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import {
  encodeCursor,
  parseRequest,
  RequestError,
  searchPattern,
} from "./request";
import { createApi } from "./server";
import { readData } from "./reader";
import type { TokenImageService } from "./token-image-store";

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
  // Creators is a top-100-per-window-and-sort leaderboard: any offset and
  // limit combination up to the cap is fine, one row past it is not.
  assert.equal(
    parseRequest("/v1/creators?offset=75&limit=25").creators.offset,
    75,
  );
  for (const [url, code] of [
    ["/v1/creators?sort=launch", "invalid_sort"],
    ["/v1/creators?sort=trades", "invalid_sort"],
    ["/v1/creators?direction=up", "invalid_direction"],
    ["/v1/creators?window=1d", "invalid_window"],
    ["/v1/creators?limit=0", "invalid_limit"],
    ["/v1/creators?limit=101", "invalid_limit"],
    ["/v1/creators?offset=-1", "invalid_offset"],
    ["/v1/creators?offset=100", "invalid_offset"],
    ["/v1/creators?offset=76&limit=25", "invalid_offset"],
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
  // The log names the route, the failure class by SQLSTATE and the elapsed
  // time, and never the message.
  assert.deepEqual(lines, [
    '{"event":"read_failed","route":"ready","code":"57014","ms":0}\n',
  ]);
  assert.equal((await fetch(url + "/v1/pools")).status, 429);
  assert.equal((await fetch(url + "/health")).status, 200);
  now = 61000;
  assert.equal((await fetch(url + "/v1/pools")).status, 200);
  assert.equal(calls, 3);
});

test("503 busy on the JSON in-flight bound carries Retry-After", async (t) => {
  const pool = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const releases: (() => void)[] = [];
  let started = 0;
  const server = createApi(
    {
      async read() {
        started++;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { items: [] };
      },
      async close() {},
    },
    { maxPerMinute: 1000 },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  // 16 distinct pool ids hold the in-flight bound open; a 17th distinct id
  // must see the 503 busy answer, never the coalesced/cached path.
  const held = Array.from({ length: 16 }, (_, i) =>
    fetch(`${url}/v1/pools/${pool(i + 1)}`),
  );
  while (started < 16) await new Promise((resolve) => setImmediate(resolve));
  const busy = await fetch(`${url}/v1/pools/${pool(17)}`);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.deepEqual(await busy.json(), { error: "busy" });
  releases.forEach((release) => release());
  await Promise.all(held);
});

test("503 busy on the image in-flight bound carries Retry-After", async (t) => {
  const pool = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const releases: ((outcome: {
    kind: "missing";
    error: string;
    maxAge: number;
  }) => void)[] = [];
  const images: TokenImageService = {
    resolve: () =>
      new Promise<{ kind: "missing"; error: string; maxAge: number }>(
        (resolve) => releases.push(resolve),
      ),
    async close() {},
  };
  const server = createApi(
    {
      async read() {
        return { items: [] };
      },
      async close() {},
    },
    { maxPerMinute: 1000, maxImagesPerMinute: 1000, images },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  // The server's own `maxConnections` is also 64, so 64 held connections
  // would leave no room for a 65th to even reach the handler. Pipeline the
  // 64 holds over one socket instead, so the busy check below is a normal,
  // separate connection.
  const socket = net.connect(address.port, "127.0.0.1");
  await once(socket, "connect");
  t.after(() => socket.destroy());
  let raw = "";
  for (let i = 1; i <= 64; i++)
    raw += `GET /v1/pools/${pool(i)}/image HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`;
  socket.write(raw);
  while (releases.length < 64)
    await new Promise((resolve) => setImmediate(resolve));
  const url = `http://127.0.0.1:${address.port}`;
  const busy = await fetch(`${url}/v1/pools/${pool(65)}/image`);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.deepEqual(await busy.json(), { error: "busy" });
  releases.forEach((release) =>
    release({ kind: "missing", error: "test_cleanup", maxAge: 1 }),
  );
});

test("read_failed logs the route and elapsed milliseconds alongside the SQLSTATE", async (t) => {
  const server = createApi(
    {
      async read() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw Object.assign(Error("postgres://user:secret@host"), {
          code: "57014",
        });
      },
      async close() {},
    },
    {},
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const error = await fetch(url + "/v1/creators").finally(() => {
    process.stderr.write = write;
  });
  assert.equal(error.status, 503);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.event, "read_failed");
  assert.equal(logged.route, "creators");
  assert.equal(logged.code, "57014");
  assert.ok(
    logged.ms >= 40 && logged.ms < 5000,
    `expected ms near the injected 50 ms delay, got ${logged.ms}`,
  );
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
