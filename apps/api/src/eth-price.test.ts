import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { EthPriceResponse } from "@pools/core";
import { createEthPriceService } from "./eth-price";
import { RequestError } from "./request";
import { createApi } from "./server";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const isUnavailable = (e: unknown) =>
  e instanceof RequestError &&
  e.status === 503 &&
  e.code === "price_unavailable" &&
  e.retryAfter === 30;

test("serves a fresh price and reuses the same cached value inside the fresh window", async () => {
  let now = 1_000_000;
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse({ data: { amount: "2500.5", base: "ETH", currency: "USD" } });
  }) as typeof fetch;
  const service = createEthPriceService({ fetchImpl, now: () => now });
  const first = await service.read();
  assert.equal(calls, 1);
  assert.equal(first.usdPerEth, 2500.5);
  assert.equal(first.source, "coinbase");
  assert.equal(first.asOf, new Date(now).toISOString());
  now += 59_000;
  const second = await service.read();
  assert.equal(calls, 1);
  assert.equal(second, first);
});

test("serves a stale value immediately and refreshes in the background at most once per minute, single-flight", async () => {
  let now = 0;
  let calls = 0;
  let amount = "2000";
  let hang = false;
  const releases: ((r: Response) => void)[] = [];
  const fetchImpl = (async () => {
    calls++;
    if (hang) return new Promise<Response>((resolve) => releases.push(resolve));
    return jsonResponse({ data: { amount } });
  }) as typeof fetch;
  const service = createEthPriceService({ fetchImpl, now: () => now });
  const first = await service.read();
  assert.equal(first.usdPerEth, 2000);
  assert.equal(calls, 1);
  // Past the 60 s fresh window, inside the 10-minute stale window.
  now = 61_000;
  hang = true;
  amount = "3000";
  const second = await service.read();
  assert.equal(second.usdPerEth, 2000, "stale value served without waiting on the network");
  assert.equal(calls, 2, "a background refresh was triggered");
  // A second stale read one second later must not start another fetch:
  // the refresh is both already in flight and rate-limited to once/minute.
  now += 1000;
  const third = await service.read();
  assert.equal(third.usdPerEth, 2000);
  assert.equal(calls, 2);
  releases.forEach((resolve) => resolve(jsonResponse({ data: { amount } })));
  await new Promise((resolve) => setImmediate(resolve));
  hang = false;
  const fourth = await service.read();
  assert.equal(fourth.usdPerEth, 3000, "the background refresh's value is now served");
  assert.equal(calls, 2, "the fresh replacement needs no further fetch");
});

test("a failed background refresh leaves the existing stale value in place", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const fetchImpl = (async () => {
    calls++;
    if (fail) throw Error("network down");
    return jsonResponse({ data: { amount: "1800" } });
  }) as typeof fetch;
  const service = createEthPriceService({ fetchImpl, now: () => now });
  const first = await service.read();
  assert.equal(first.usdPerEth, 1800);
  now = 65_000;
  fail = true;
  const second = await service.read();
  assert.equal(second.usdPerEth, 1800);
  assert.equal(calls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  now += 1000;
  const third = await service.read();
  assert.equal(third.usdPerEth, 1800, "still served from the same stale entry");
  assert.equal(calls, 2, "the retry interval has not elapsed");
});

test("upstream failure with nothing cached answers 503 price_unavailable and never retries more than once per minute", async () => {
  let now = 0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw Error("network down");
  }) as typeof fetch;
  const service = createEthPriceService({ fetchImpl, now: () => now });
  await assert.rejects(service.read(), isUnavailable);
  assert.equal(calls, 1);
  now += 1000;
  await assert.rejects(service.read(), isUnavailable);
  assert.equal(calls, 1, "rate-limited: no second attempt one second later");
  now += 60_000;
  await assert.rejects(service.read(), isUnavailable);
  assert.equal(calls, 2, "the minute has elapsed, so a retry is allowed");
});

test("a non-200 upstream status is treated as a failure", async () => {
  const fetchImpl = (async () => jsonResponse({ error: "rate limited" }, 429)) as typeof fetch;
  const service = createEthPriceService({ fetchImpl, now: () => 0 });
  await assert.rejects(service.read(), isUnavailable);
});

test("concurrent cold reads share a single in-flight fetch", async () => {
  let calls = 0;
  let resolve!: (r: Response) => void;
  const fetchImpl = (async () => {
    calls++;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  }) as typeof fetch;
  const service = createEthPriceService({ fetchImpl, now: () => 0 });
  const first = service.read();
  const second = service.read();
  assert.equal(calls, 1);
  resolve(jsonResponse({ data: { amount: "2100" } }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.usdPerEth, 2100);
  assert.equal(b.usdPerEth, 2100);
});

test("a fetch past its deadline aborts and answers 503 without a cached value", async (t) => {
  // A real server that never responds, not a synthetic pending promise: a
  // fake promise hanging on AbortSignal.timeout()'s own unref'd timer with
  // nothing else keeping the loop alive would let the test runner see an
  // idle loop and cancel the test instead of observing the timeout, exactly
  // as `packages/token-image/src/index.test.ts`'s `deadline()` helper notes.
  // This server's listening socket keeps the loop alive until it fires for real.
  const server = createServer(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const service = createEthPriceService({
    now: () => 0,
    fetchTimeoutMs: 200,
    url: `http://127.0.0.1:${address.port}/`,
  });
  await assert.rejects(service.read(), isUnavailable);
});

test("rejects non-finite, non-positive and malformed amounts", async () => {
  const bodies: unknown[] = [
    { data: { amount: "0" } },
    { data: { amount: "-5" } },
    { data: { amount: "NaN" } },
    { data: { amount: "Infinity" } },
    { data: { amount: 2500 } },
    { data: {} },
    {},
    null,
  ];
  for (const body of bodies) {
    const fetchImpl = (async () => jsonResponse(body)) as typeof fetch;
    const service = createEthPriceService({ fetchImpl, now: () => 0 });
    await assert.rejects(
      service.read(),
      isUnavailable,
      `expected rejection for ${JSON.stringify(body)}`,
    );
  }
});

test("HTTP route serves the price with the shared 60 s / 10-minute cache headers, rejects query parameters, and answers 503 with Retry-After when unavailable", async (t) => {
  let outcome: EthPriceResponse | RequestError = new RequestError(
    503,
    "price_unavailable",
    { retryAfter: 30 },
  );
  const ethPrice = {
    async read() {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const reader = { read: async () => ({}), close: async () => {} };
  const server = createApi(reader, { ethPrice });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/prices/eth-usd`;
  let res = await fetch(url);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.deepEqual(await res.json(), { error: "price_unavailable" });
  outcome = {
    usdPerEth: 2500.25,
    asOf: "2026-09-17T00:00:00.000Z",
    source: "coinbase",
  };
  res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=540",
  );
  assert.deepEqual(await res.json(), outcome);
  res = await fetch(url + "?foo=bar");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_parameter" });
});
