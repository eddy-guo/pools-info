import { test } from "node:test";
import assert from "node:assert/strict";
import { indexedFeed } from "./indexed-feed";

const pool = `0x${"1".repeat(64)}`;
const fixture = () => ({
  source: "indexed_chain_events",
  fromBlock: 100,
  toBlock: 110,
  toTimestamp: 1000,
  generatedAt: "2026-09-14T00:00:00.000Z",
  truncated: false,
  events: [
    {
      poolId: pool,
      txHash: `0x${"2".repeat(64)}`,
      logIndex: 2,
      block: 105,
      timestamp: 995,
      amount0: "-1000000000000000000",
      amount1: "123456789012345678901234567890",
      transactionSender: null,
    },
  ],
});

test("indexed feed preserves exact amounts and a quiet checkpoint's timestamp", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, "/v1/feed");
    assert.equal(url.searchParams.get("pools"), pool);
    assert.equal(options.redirect, "error");
    return Response.json(fixture());
  });
  const data = await indexedFeed("https://index.example", [pool]);
  assert.equal(data.toTimestamp, 1000);
  assert.equal(data.events[0].amount1, "123456789012345678901234567890");
});

test("indexed feed rejects failed reads and mismatched or malformed evidence", async (t) => {
  let result: unknown = fixture();
  let status = 200;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(result, { status }),
  );
  status = 503;
  await assert.rejects(
    indexedFeed("https://index.example", [pool]),
    /unavailable/,
  );
  status = 200;
  for (const change of [
    { source: "unverified" },
    { fromBlock: 111 },
    { toTimestamp: 994 },
    { events: [{ ...fixture().events[0], poolId: `0x${"3".repeat(64)}` }] },
    { events: [{ ...fixture().events[0], amount0: 1.5 }] },
    { events: [{ ...fixture().events[0], block: 99 }] },
  ]) {
    result = { ...fixture(), ...change };
    await assert.rejects(
      indexedFeed("https://index.example", [pool]),
      /Invalid indexed feed/,
    );
  }
});

test("feed route preserves valid upstream waits and falls back for invalid waits", async (t) => {
  const before = process.env.INDEXER_API_URL;
  const disabled = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://index.example";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (before === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = before;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  const { GET } = await import("../app/api/trades/route");
  let status = 429;
  let retryAfter: string | null = "37";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "request_limit" },
      {
        status,
        headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
      },
    ),
  );
  const request = new Request(`https://site.example/api/trades/?pools=${pool}`);
  for (const [upstreamStatus, upstreamWait, expected] of [
    [429, "37", "37"],
    [503, "86400", "86400"],
    [429, "86401", "86400"],
    [503, "999999999999999999999999999", "86400"],
    [503, "1.5", "15"],
    [503, null, "15"],
    [500, "37", "15"],
  ] as const) {
    status = upstreamStatus;
    retryAfter = upstreamWait;
    const response = await GET(request);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), expected);
    assert.deepEqual(await response.json(), {
      error: "Recent swaps unavailable. Retain the last observed events.",
    });
  }
});
