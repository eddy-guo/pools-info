import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import { ingressSettings } from "./ingress";
import { readData } from "./reader";
import type { TokenImageService } from "./token-image-store";
import type { WalletHistory } from "./wallet-history";

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

test("a wallet-position request names the wallet and the pool, lowercased, and takes a window and nothing else", () => {
  const address = "0x" + "AB".repeat(20);
  const request = parseRequest(
    `/v1/wallets/${address}/positions/${hash("C")}?window=7d`,
  );
  assert.deepEqual(
    [request.route, request.wallet, request.poolId, request.window],
    ["position", address.toLowerCase(), hash("c"), "7d"],
  );
  assert.equal(
    parseRequest(`/v1/wallets/${address}/positions/${hash("c")}`).window,
    "All",
  );
  // Two windows of one position, and two positions of one wallet, never
  // share a cache entry; a wallet page and its position never do either.
  assert.notEqual(
    request.cacheKey,
    parseRequest(`/v1/wallets/${address}/positions/${hash("c")}`).cacheKey,
  );
  assert.notEqual(
    request.cacheKey,
    parseRequest(`/v1/wallets/${address}/positions/${hash("d")}?window=7d`)
      .cacheKey,
  );
  assert.notEqual(
    request.cacheKey,
    parseRequest(`/v1/wallets/${address}?window=7d`).cacheKey,
  );
  for (const url of [
    `/v1/wallets/${address}/positions/${hash("c")}?limit=1`,
    `/v1/wallets/${address}/positions/${hash("c")}?window=2d`,
    `/v1/wallets/${address}/positions/${hash("c")}?window=7d&window=All`,
    `/v1/wallets/${address}/positions/0xc`,
    `/v1/wallets/0xc/positions/${hash("c")}`,
    `/v1/wallet/${address}/positions/${hash("c")}`,
    `/v1/wallets/${address}/positions/${hash("c")}/`,
    `/v1/wallets/${address}/positions`,
  ])
    assert.throws(() => parseRequest(url), RequestError, url);
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
        if (r.route === "health") return { ok: true, ledger: null };
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
  // The probe drew on its own allowance, so a fourth JSON read still fits
  // under the shared ceiling of four; the fifth does not.
  assert.equal((await fetch(url + "/v1/pools")).status, 200);
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

/** A reader that answers every route at once, so only the ingress decides. */
const stubReader = () => ({
  async read() {
    return { items: [] };
  },
  async close() {},
});
async function listen(
  t: import("node:test").TestContext,
  server: ReturnType<typeof createApi>,
) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function refusal(response: Response, reason: string, retryAfter: string) {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), retryAfter);
  assert.deepEqual(await response.json(), { error: "request_limit", reason });
}

test("a client's spent budget refuses that client alone, names its wait exactly, and starves neither other clients nor probes", async (t) => {
  let now = 0;
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => now,
      maxPerMinute: 1000,
      cacheMs: 100000,
      // The loopback peer is the trusted proxy; the address it appends last
      // is the client, whatever the caller wrote before it.
      ingress: ingressSettings({
        TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
        CLIENT_TOKENS_PER_MINUTE: "60",
        CLIENT_TOKEN_BURST: "60",
      }),
    }),
  );
  const as = (client: string, path = "/v1/status") =>
    fetch(url + path, {
      headers: { "x-forwarded-for": `203.0.113.99, ${client}` },
    });
  // 60 tokens: one status miss (2) and 58 cache hits (1 each) spend them.
  const first = await as("203.0.113.1");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-data-cache"), "MISS");
  for (let i = 0; i < 58; i++) {
    const hit = await as("203.0.113.1");
    assert.equal(hit.status, 200, `request ${i + 2}`);
    assert.equal(hit.headers.get("x-data-cache"), "HIT");
  }
  // One token a second: the next hit waits one whole second.
  await refusal(await as("203.0.113.1"), "client_budget", "1");
  // Another client and the readiness probe are untouched; a request the
  // proxy attributes to the first client shares its refusal.
  assert.equal((await as("203.0.113.2")).status, 200);
  assert.equal((await fetch(url + "/ready")).status, 200);
  await refusal(
    await fetch(url + "/v1/status", {
      headers: { "x-forwarded-for": "203.0.113.1" },
    }),
    "client_budget",
    "1",
  );
  // The wait is exact: a millisecond early is refused, on time is admitted.
  now = 999;
  await refusal(await as("203.0.113.1"), "client_budget", "1");
  now = 1000;
  assert.equal((await as("203.0.113.1")).status, 200);
});

test("one client's cached reads stop at its burst before the shared JSON ceiling", async (t) => {
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => 0,
      cacheMs: 100000,
      ingress: ingressSettings({ TRUSTED_PROXY_ADDRESSES: "127.0.0.1" }),
    }),
  );
  const as = (client: string) =>
    fetch(url + "/v1/status", { headers: { "x-forwarded-for": client } });
  const first = await as("203.0.113.1");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-data-cache"), "MISS");
  for (let i = 0; i < 118; i++) {
    const hit = await as("203.0.113.1");
    assert.equal(hit.status, 200, `cached request ${i + 1}`);
    assert.equal(hit.headers.get("x-data-cache"), "HIT");
  }
  await refusal(await as("203.0.113.1"), "client_budget", "1");
  assert.equal((await as("203.0.113.2")).status, 200);
});

test("forwarded headers on direct traffic never make an identity, and an unconfigured api keeps only its shared ceiling", async (t) => {
  // The trusted proxy is some other address: every request here is direct
  // traffic from the loopback peer, whatever it claims to forward.
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => 0,
      maxPerMinute: 1000,
      cacheMs: 100000,
      ingress: ingressSettings({
        TRUSTED_PROXY_ADDRESSES: "10.0.0.1",
        TRUSTED_PROXY_SECRET: randomBytes(32).toString("hex"),
        CLIENT_TOKENS_PER_MINUTE: "10",
        CLIENT_TOKEN_BURST: "10",
      }),
    }),
  );
  // 10 tokens: a miss (2) and eight hits; the tenth request is refused no
  // matter which address it claims, with a secret it does not hold.
  for (let i = 0; i < 9; i++)
    assert.equal(
      (
        await fetch(url + "/v1/status", {
          headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
        })
      ).status,
      200,
      `request ${i + 1}`,
    );
  await refusal(
    await fetch(url + "/v1/status", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "x-pools-proxy-secret": "0123456789abcdeF",
        "x-pools-client-address": "203.0.113.51",
      },
    }),
    "client_budget",
    "6",
  );
  // The same traffic against an api with no identity contract at all is
  // never refused for a client's sake: only the shared ceiling applies.
  const plain = await listen(
    t,
    createApi(stubReader(), {
      now: () => 0,
      maxPerMinute: 1000,
      cacheMs: 100000,
    }),
  );
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await fetch(plain + "/v1/status", {
          headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
        })
      ).status,
      200,
      `plain request ${i + 1}`,
    );
});

test("the proxy secret names the visitor the site proxy vouches for, and nobody else", async (t) => {
  const secret = randomBytes(32).toString("hex");
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => 0,
      maxPerMinute: 1000,
      cacheMs: 100000,
      ingress: ingressSettings({
        TRUSTED_PROXY_SECRET: secret,
        CLIENT_TOKENS_PER_MINUTE: "10",
        CLIENT_TOKEN_BURST: "10",
      }),
    }),
  );
  const via = (visitor: string, presented = secret) =>
    fetch(url + "/v1/status", {
      headers: {
        "x-pools-proxy-secret": presented,
        "x-pools-client-address": visitor,
      },
    });
  for (let i = 0; i < 9; i++)
    assert.equal((await via("203.0.113.1")).status, 200, `request ${i + 1}`);
  await refusal(await via("203.0.113.1"), "client_budget", "6");
  assert.equal((await via("203.0.113.2")).status, 200);
  // Without the secret, or with a wrong one, the request is direct traffic
  // this api has no contract to identify: the shared ceiling alone applies,
  // and the spent visitor's name buys no refusal for it.
  for (let i = 0; i < 20; i++) {
    assert.equal((await fetch(url + "/v1/status")).status, 200);
    assert.equal((await via("203.0.113.1", "wrong-" + secret)).status, 200);
  }
});

test("the shared ceiling still holds across clients, and a request it refuses costs its client nothing", async (t) => {
  let now = 0;
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => now,
      maxPerMinute: 6,
      cacheMs: 100000,
      ingress: ingressSettings({
        TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
        CLIENT_TOKENS_PER_MINUTE: "10",
        CLIENT_TOKEN_BURST: "10",
      }),
    }),
  );
  const as = (client: string, path = "/v1/status") =>
    fetch(url + path, { headers: { "x-forwarded-for": client } });
  // A second before the shared window ends, one client spends 8 of its 10
  // tokens on two catalog-wide reads and four others fill the ceiling.
  now = 59000;
  assert.equal((await as("203.0.113.1", "/v1/explore")).status, 200);
  assert.equal((await as("203.0.113.1", "/v1/creators")).status, 200);
  for (let i = 2; i <= 5; i++)
    assert.equal((await as(`203.0.113.${i}`)).status, 200, `client ${i}`);
  // The first client's next read (2) is inside its own budget but meets the
  // shared ceiling: refused for the window's last second, and refunded.
  await refusal(await as("203.0.113.1", "/v1/stats"), "shared_budget", "1");
  await refusal(await as("203.0.113.6"), "shared_budget", "1");
  // Once the window resets, the refunded read fits (2 tokens and a sixth of
  // one refilled); had the refusal been charged, this would be 11 seconds away.
  now = 60000;
  assert.equal((await as("203.0.113.1", "/v1/stats")).status, 200);
  await refusal(await as("203.0.113.1", "/v1/stats"), "client_budget", "5");
  assert.equal((await as("203.0.113.6")).status, 200);
});

test("readiness keeps its own probe allowance; a probe flood spends no visitor budget and health is never limited", async (t) => {
  let now = 0;
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => now,
      maxPerMinute: 3,
      cacheMs: 100000,
      ingress: ingressSettings({
        TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
        CLIENT_TOKENS_PER_MINUTE: "10",
        CLIENT_TOKEN_BURST: "10",
      }),
    }),
  );
  const probe = () =>
    fetch(url + "/ready", { headers: { "x-forwarded-for": "203.0.113.1" } });
  // Visitors spend the whole shared ceiling; readiness still answers.
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await fetch(url + "/v1/status", {
          headers: { "x-forwarded-for": `203.0.113.${i + 2}` },
        })
      ).status,
      200,
    );
  await refusal(
    await fetch(url + "/v1/status", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    }),
    "shared_budget",
    "60",
  );
  for (let i = 0; i < 60; i++)
    assert.equal((await probe()).status, 200, `probe ${i + 1}`);
  await refusal(await probe(), "probe_budget", "60");
  assert.equal((await fetch(url + "/health")).status, 200);
  // The probing client's own budget is untouched by its 61 probes.
  now = 60000;
  for (let i = 0; i < 9; i++)
    assert.equal(
      (
        await fetch(url + "/v1/status", {
          headers: { "x-forwarded-for": "203.0.113.1" },
        })
      ).status,
      i < 3 ? 200 : 429,
      `request ${i + 1}`,
    );
});

test("a request costs its client by the work it starts: cached, light, heavy or paid", async (t) => {
  const history: WalletHistory = {
    read: async () => ({ items: [] }) as never,
    peekTrades: () => null,
    refreshTrades: async () => {
      throw Error("Unexpected trades refresh");
    },
  };
  const url = await listen(
    t,
    createApi(stubReader(), {
      now: () => 0,
      maxPerMinute: 1000,
      cacheMs: 100000,
      history,
      ingress: ingressSettings({
        TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
        CLIENT_TOKENS_PER_MINUTE: "10",
        CLIENT_TOKEN_BURST: "10",
      }),
    }),
  );
  const as = (client: string, path: string) =>
    fetch(url + path, { headers: { "x-forwarded-for": client } });
  // Two catalog-wide reads (4 each) leave 2; a cache hit (1) leaves 1; a
  // bounded database read (2) is refused, six seconds short of its cost,
  // while another hit (1) still fits.
  assert.equal((await as("203.0.113.1", "/v1/explore")).status, 200);
  assert.equal((await as("203.0.113.1", "/v1/creators")).status, 200);
  const hit = await as("203.0.113.1", "/v1/explore");
  assert.equal(hit.headers.get("x-data-cache"), "HIT");
  await refusal(await as("203.0.113.1", "/v1/status"), "client_budget", "6");
  assert.equal((await as("203.0.113.1", "/v1/creators")).status, 200);
  await refusal(await as("203.0.113.1", "/v1/creators"), "client_budget", "6");
  // A paid explorer page (8) leaves 2: a second one is 36 seconds away.
  const wallet = "0x" + "2".repeat(40);
  assert.equal(
    (await as("203.0.113.2", `/v1/wallets/${wallet}/history`)).status,
    200,
  );
  await refusal(
    await as("203.0.113.2", `/v1/wallets/${wallet}/history`),
    "client_budget",
    "36",
  );
});

test("a read coalesced with an identical one in flight costs what a cache hit costs", async (t) => {
  const releases: (() => void)[] = [];
  const url = await listen(
    t,
    createApi(
      {
        async read() {
          await new Promise<void>((resolve) => releases.push(resolve));
          return { items: [] };
        },
        async close() {},
      },
      {
        now: () => 0,
        maxPerMinute: 1000,
        ingress: ingressSettings({
          TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
          CLIENT_TOKENS_PER_MINUTE: "10",
          CLIENT_TOKEN_BURST: "10",
        }),
      },
    ),
  );
  const pool = `/v1/pools/${"0x" + "3".repeat(64)}`;
  const as = () =>
    fetch(url + pool, { headers: { "x-forwarded-for": "203.0.113.1" } });
  // The first pool read (2) is held open; eight identical requests join it
  // for a token each, and the tenth is refused while the read is still pending.
  const held = [as()];
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 8; i++) held.push(as());
  await new Promise((r) => setTimeout(r, 20));
  await refusal(await as(), "client_budget", "6");
  assert.equal(releases.length, 1);
  releases[0]();
  for (const response of await Promise.all(held))
    assert.equal(response.status, 200);
});
