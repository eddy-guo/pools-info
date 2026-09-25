import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import type { WalletHistoryResponse } from "@pools/core";
import {
  BlockscoutError,
  createBlockscoutClient,
  createCreditBudget,
  createRateLimiter,
  defaultBlockscoutTimeoutMs,
  normalizeTokenTransfer,
  normalizeTrade,
  normalizeTransaction,
  pageParams,
  poolManager,
} from "./blockscout-client";
import { decodeHistoryCursor, encodeHistoryCursor } from "./history-cursor";
import { parseRequest, RequestError } from "./request";
import { createApi } from "./server";
import {
  createWalletHistory,
  createWalletHistoryFromEnv,
  tradesMaxPages,
  tradesPageTarget,
} from "./wallet-history";

const wallet = "0x42a68318a6d78644870d3a37ec9e708e3ea904f5";
const key = "proapi_test_key_never_logged";
const fixtures = new URL("../fixtures/blockscout/", import.meta.url);
async function fixture(name: string) {
  return readFile(new URL(name + ".json", fixtures), "utf8");
}

/** A fake PRO host: the test decides each answer, the client never sees the
 * real explorer. */
async function upstream(
  t: test.TestContext,
  answer: (req: IncomingMessage) => Promise<{
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    hang?: boolean;
  }>,
) {
  const seen: IncomingMessage[] = [];
  const server = createServer(async (req, res) => {
    seen.push(req);
    const a = await answer(req);
    if (a.hang) return;
    res.writeHead(a.status ?? 200, {
      "content-type": "application/json; charset=utf-8",
      ...a.headers,
    });
    res.end(a.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, seen };
}
function client(baseUrl: string, extra = {}) {
  return createBlockscoutClient({
    key,
    baseUrl,
    dailyCreditCap: 1000,
    limiter: createRateLimiter({ sleep: async () => {} }),
    ...extra,
  });
}
function captureStderr(t: test.TestContext) {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
  return lines;
}

test("recorded pages normalize to the stable display shape", async () => {
  const tx = JSON.parse(await fixture("transactions-page1")).items.map(
    normalizeTransaction,
  );
  assert.deepEqual(tx[0], {
    hash: "0x309d92c89d2327a841d571c438f00198ebf52c9c31a88fc6ce839f0eadbdf83b",
    block: 63744405,
    timestamp: 1789484191,
    from: wallet,
    to: "0x8876789976decbfcbbbe364623c63652db8c0904",
    method: "execute",
    status: "ok",
    value: "0",
    fee: "6790328640000",
  });
  assert.equal(tx[3].status, "error");
  assert.equal(tx[3].method, "0xd04c6983");
  assert.equal(tx[5].value, "65200000000000000");
  const transfers = JSON.parse(
    await fixture("token-transfers-page1"),
  ).items.map(normalizeTokenTransfer);
  assert.deepEqual(transfers[0], {
    transactionHash:
      "0x309d92c89d2327a841d571c438f00198ebf52c9c31a88fc6ce839f0eadbdf83b",
    logIndex: 10,
    block: 63744405,
    timestamp: 1789484191,
    from: wallet,
    to: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    token: {
      address: "0x163da2c74cc56d8c71671f7374b0522d9d16006c",
      symbol: "STACK",
      name: "Stack Btc 7",
      decimals: 18,
      type: "ERC-20",
    },
    value: "539456082647569976419888",
    tokenId: null,
    method: "0x3593564c",
  });
  // Pending, contract creation, ERC-721 and unknown decimals stay explicit.
  const pending = normalizeTransaction({
    hash: "0x" + "a".repeat(64),
    block_number: null,
    timestamp: null,
    from: { hash: wallet },
    to: null,
    method: null,
    status: null,
    value: "1",
    fee: null,
  });
  assert.deepEqual(
    [pending.block, pending.timestamp, pending.to, pending.status, pending.fee],
    [null, null, null, "pending", null],
  );
  const nft = normalizeTokenTransfer({
    transaction_hash: "0x" + "b".repeat(64),
    log_index: 3,
    block_number: 5,
    timestamp: "2026-09-15T00:00:00.000000Z",
    from: { hash: wallet },
    to: { hash: wallet },
    token: {
      address_hash: wallet,
      symbol: null,
      name: null,
      decimals: "1e3",
      type: "ERC-721",
    },
    total: { token_id: "7", token_instance: null },
    method: "transferFrom",
  });
  assert.deepEqual(
    [nft.value, nft.tokenId, nft.token.decimals],
    [null, "7", null],
  );
  const first = JSON.parse(await fixture("transactions-page1")).items[0];
  for (const bad of [
    { ...first, hash: "0x1" },
    { ...first, from: null },
    { ...first, value: "1.5" },
    { ...first, status: "maybe" },
  ])
    assert.throws(() => normalizeTransaction(bad), /invalid_item/);
  const transfer = JSON.parse(await fixture("token-transfers-page1")).items[0];
  assert.throws(
    () => normalizeTokenTransfer({ ...transfer, log_index: "10" }),
    /invalid_item/,
  );
});

test("trades keep only the wallet's ERC-20 legs against the PoolManager, sided by direction", async () => {
  const launcher = "0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388";
  const rows = JSON.parse(await fixture("trades-page1")).items;
  const trades = rows.map((row: unknown) => normalizeTrade(row, launcher));
  // The two spoofed-token poisoning logs are the wallet's transfers but no
  // trade; the sell and the launch's own buy are.
  assert.deepEqual(
    trades.map((t: { side: string } | null) => t?.side ?? null),
    [null, null, "sell", "buy"],
  );
  assert.deepEqual(trades[2], {
    transactionHash:
      "0xc2157c941eeed5d29cdc94fcfb8350f62225500b1c99e8d3765952cb86533f16",
    logIndex: 30,
    block: 67951067,
    timestamp: 1789908571,
    side: "sell",
    token: {
      address: "0xecff71414f3803d6d936c4b40b19feab060e38e7",
      symbol: "FOMOEGG",
      name: "fomoegg",
      decimals: 18,
      type: "ERC-20",
    },
    tokenRaw: "261603454168184627578164308",
    method: "0x3593564c",
  });
  assert.equal(trades[3].tokenRaw, "373719220240263753683091868");
  // The same legs seen from the PoolManager or a stranger are no trade.
  assert.equal(normalizeTrade(rows[2], poolManager), null);
  assert.equal(normalizeTrade(rows[2], wallet), null);
  // A malformed row that is no trade never fails the page; a malformed or
  // non-fungible PoolManager leg does.
  assert.equal(normalizeTrade({ ...rows[0], log_index: "x" }, launcher), null);
  assert.equal(normalizeTrade({ from: null, to: 7 }, launcher), null);
  assert.throws(
    () => normalizeTrade({ ...rows[2], log_index: "x" }, launcher),
    /invalid_item/,
  );
  assert.throws(
    () => normalizeTrade({ ...rows[2], total: { token_id: "1" } }, launcher),
    /invalid_item/,
  );
});

test("display strings map an empty upstream value to null and clip past 256 characters, the website validator's exact bound", () => {
  const over = "x".repeat(300);
  const emptyTx = normalizeTransaction({
    hash: "0x" + "c".repeat(64),
    block_number: 1,
    timestamp: "2026-09-15T00:00:00.000000Z",
    from: { hash: wallet },
    to: { hash: wallet },
    method: "",
    status: "ok",
    value: "1",
    fee: null,
  });
  assert.equal(emptyTx.method, null);
  const longTx = normalizeTransaction({
    hash: "0x" + "d".repeat(64),
    block_number: 1,
    timestamp: "2026-09-15T00:00:00.000000Z",
    from: { hash: wallet },
    to: { hash: wallet },
    method: over,
    status: "ok",
    value: "1",
    fee: null,
  });
  assert.equal(longTx.method, over.slice(0, 256));
  assert.equal(longTx.method!.length, 256);
  const transfer = normalizeTokenTransfer({
    transaction_hash: "0x" + "e".repeat(64),
    log_index: 1,
    block_number: 1,
    timestamp: "2026-09-15T00:00:00.000000Z",
    from: { hash: wallet },
    to: { hash: wallet },
    token: {
      address_hash: wallet,
      symbol: "",
      name: over,
      decimals: "18",
      type: "",
    },
    total: { value: "1" },
    method: "",
  });
  assert.equal(transfer.token.symbol, null);
  assert.equal(transfer.token.type, null);
  assert.equal(transfer.token.name, over.slice(0, 256));
  assert.equal(transfer.method, null);
});

test("client authenticates with the key, passes page parameters through and reads the credit header", async (t) => {
  const { baseUrl, seen } = await upstream(t, async (req) => ({
    body: await fixture(
      req.url!.includes("token-transfers")
        ? req.url!.includes("?")
          ? "token-transfers-page2"
          : "token-transfers-page1"
        : req.url!.includes("?")
          ? "transactions-page2"
          : "transactions-page1",
    ),
    headers: { "x-credits-remaining": "99880" },
  }));
  const c = client(baseUrl);
  const first = await c.readPage("transactions", wallet, null);
  assert.equal(seen[0].headers.authorization, `Bearer ${key}`);
  assert.equal(seen[0].headers.accept, "application/json");
  assert.match(String(seen[0].headers["user-agent"]), /^pools-info-api\//);
  assert.equal(seen[0].url, `/addresses/${wallet}/transactions`);
  assert.equal(first.items.length, 6);
  assert.deepEqual(first.nextPageParams, {
    block_number: "62905772",
    fee: "26489045362000",
    hash: "0x0e4220297ac84efaa3ecb54200ff72a50170e8fb8db6cade0d8023a69ac69be8",
    index: "6",
    inserted_at: "2026-09-14T15:13:54.207069Z",
    items_count: "50",
    value: "0",
  });
  const second = await c.readPage("transactions", wallet, first.nextPageParams);
  const query = new URL(seen[1].url!, baseUrl).searchParams;
  assert.equal(query.get("block_number"), "62905772");
  assert.equal(query.get("items_count"), "50");
  assert.equal(second.items.length, 5);
  const transfers = await c.readPage("token-transfers", wallet, null);
  assert.deepEqual(transfers.nextPageParams, {
    block_number: "61818238",
    index: "10",
  });
  const last = await c.readPage(
    "token-transfers",
    wallet,
    transfers.nextPageParams,
  );
  assert.equal(
    seen[3].url,
    `/addresses/${wallet}/token-transfers?block_number=61818238&index=10`,
  );
  assert.equal(last.items.length, 5);
  assert.deepEqual(c.budget.snapshot().spent, 20 + 20 + 30 + 30);
  await assert.rejects(
    c.readPage("transactions", "not-an-address", null),
    /Invalid wallet/,
  );
});

test("client reads trades from the ERC-20 transfer page with a filter no cursor can replace", async (t) => {
  const launcher = "0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388";
  const { baseUrl, seen } = await upstream(t, async (req) => ({
    body: await fixture(
      req.url!.includes("index=") ? "trades-page2" : "trades-page1",
    ),
  }));
  const c = client(baseUrl);
  const first = await c.readPage("trades", launcher, null);
  assert.equal(
    seen[0].url,
    `/addresses/${launcher}/token-transfers?type=ERC-20`,
  );
  assert.deepEqual(
    first.items.map((i) => [i.side, i.logIndex]),
    [
      ["sell", 30],
      ["buy", 47],
    ],
  );
  assert.deepEqual(first.nextPageParams, {
    block_number: "67884997",
    index: "14",
  });
  const second = await c.readPage("trades", launcher, {
    ...first.nextPageParams!,
    type: "ERC-721",
  });
  assert.equal(
    seen[1].url,
    `/addresses/${launcher}/token-transfers?block_number=67884997&index=14&type=ERC-20`,
  );
  assert.equal(second.items.length, 3);
  assert(second.items.every((i) => i.side === "sell"));
  assert.equal(c.budget.snapshot().spent, 30 + 30);
});

test("client maps upstream failures, bounds time and size, and never logs the key", async (t) => {
  const stderr = captureStderr(t);
  let mode = "401";
  const { baseUrl } = await upstream(t, async () => {
    if (mode === "hang") return { hang: true };
    if (mode === "big")
      return {
        body: JSON.stringify({
          items: [],
          next_page_params: null,
          pad: "x".repeat(5000),
        }),
      };
    if (mode === "html") return { status: 200, body: "<html>challenge</html>" };
    if (mode === "shape")
      return {
        body: JSON.stringify({ items: [{ hash: 1 }], next_page_params: null }),
      };
    if (mode === "cursor")
      return {
        body: JSON.stringify({ items: [], next_page_params: { "bad key": 1 } }),
      };
    return {
      status: Number(mode),
      body: await fixture(mode === "402" ? "error-402" : "error-401"),
    };
  });
  const expect = async (kind: string, retryAfter?: number, extra = {}) => {
    const c = client(baseUrl, { timeoutMs: 200, maxBytes: 4096, ...extra });
    await assert.rejects(
      c.readPage("transactions", wallet, null),
      (error: unknown) => {
        assert(error instanceof BlockscoutError);
        assert.equal(error.kind, kind);
        if (retryAfter !== undefined)
          assert.equal(error.retryAfter, retryAfter);
        return true;
      },
    );
  };
  await expect("misconfigured_key", 3600);
  mode = "403";
  await expect("misconfigured_key", 3600);
  mode = "402";
  await expect("key_rejected", 3600);
  mode = "429";
  await expect("upstream_unavailable", 5);
  mode = "500";
  await expect("upstream_unavailable", 30);
  mode = "404";
  await expect("upstream_unavailable", 30);
  for (mode of ["hang", "big", "html", "shape", "cursor"])
    await expect("upstream_unavailable");
  assert(stderr.length >= 11);
  assert(!stderr.join("").includes(key));
  assert(!stderr.join("").includes(baseUrl));
  assert(stderr.some((l) => l.includes('"status":402')));
  assert(stderr.some((l) => l.includes("TimeoutError")));
  // The timeout failure logs how long the attempt actually ran, so a real
  // outage is distinguishable from a slow-but-live explorer.
  assert(
    stderr.some(
      (l) => l.includes("blockscout_request_failed") && /"ms":\d+/.test(l),
    ),
  );
  assert.throws(
    () => createBlockscoutClient({ key: "", dailyCreditCap: 1 }),
    /BLOCKSCOUT_API_KEY/,
  );
  assert.throws(
    () =>
      createBlockscoutClient({ key, baseUrl: "ftp://x", dailyCreditCap: 1 }),
    /BLOCKSCOUT_API_URL/,
  );
  // The construction guard's cap sits at the same value as the default, so
  // an override can raise it no further.
  assert.equal(defaultBlockscoutTimeoutMs, 12000);
  assert.doesNotThrow(() =>
    createBlockscoutClient({
      key,
      dailyCreditCap: 1,
      timeoutMs: defaultBlockscoutTimeoutMs,
    }),
  );
  assert.throws(
    () =>
      createBlockscoutClient({
        key,
        dailyCreditCap: 1,
        timeoutMs: defaultBlockscoutTimeoutMs + 1,
      }),
    /timeout/,
  );
});

test("rate limiter never starts more than five calls in any second and bounds the wait", async () => {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const limiter = createRateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    maxWaitMs: 1500,
  });
  for (let i = 0; i < 5; i++) await limiter.acquire();
  assert.deepEqual(sleeps, []);
  await limiter.acquire();
  assert.deepEqual(sleeps, [1000]);
  for (let i = 0; i < 4; i++) await limiter.acquire();
  assert.deepEqual(sleeps, [1000]);
  assert.equal(now, 1_001_000);
  // Five more are reserved at +2000; the eleventh would wait beyond the bound.
  const reserved = [];
  for (let i = 0; i < 5; i++) {
    now = 1_001_000;
    reserved.push(limiter.acquire());
  }
  now = 1_001_000;
  await assert.rejects(
    limiter.acquire(),
    (e: BlockscoutError) => e.kind === "upstream_unavailable",
  );
  await Promise.all(reserved);
  // After the window passes, calls flow again without waiting.
  now = 1_010_000;
  sleeps.length = 0;
  await limiter.acquire();
  assert.deepEqual(sleeps, []);
});

test("credit budget spends per call, refuses past the cap, resets at UTC midnight and heeds the upstream header", () => {
  let now = Date.parse("2026-09-15T23:59:30Z");
  const budget = createCreditBudget({ dailyCap: 50, now: () => now });
  budget.spend(20);
  budget.spend(30);
  assert.deepEqual(budget.snapshot(), {
    day: "2026-09-15",
    spent: 50,
    dailyCap: 50,
  });
  assert.throws(
    () => budget.spend(20),
    (e: BlockscoutError) =>
      e.kind === "budget_exhausted" && e.retryAfter === 30,
  );
  assert.throws(() => budget.assertAvailable(1), BlockscoutError);
  now = Date.parse("2026-09-16T00:00:00Z");
  budget.spend(20);
  assert.deepEqual(budget.snapshot(), {
    day: "2026-09-16",
    spent: 20,
    dailyCap: 50,
  });
  budget.observeRemaining(1000, 30);
  budget.spend(20);
  budget.observeRemaining(29, 30);
  assert.throws(
    () => budget.spend(1),
    (e: BlockscoutError) =>
      e.kind === "budget_exhausted" && e.retryAfter === 3600,
  );
  now += 3600_000;
  budget.spend(1);
  assert.throws(() => createCreditBudget({ dailyCap: 0 }), /cap/);
});

test("page parameters accept only bounded query-safe scalars", () => {
  assert.equal(pageParams(null), null);
  assert.deepEqual(pageParams({ index: 6, hash: "0xab", flag: true }), {
    flag: "true",
    hash: "0xab",
    index: "6",
  });
  for (const bad of [
    [],
    "x",
    { "bad key": 1 },
    { a: {} },
    { a: "with space" },
    { a: "x".repeat(101) },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "1"])),
  ])
    assert.throws(() => pageParams(bad));
});

test("history cursors bind to scope and kind and round-trip through the parser", () => {
  const request = parseRequest(
    `/v1/wallets/${wallet.toUpperCase().replace("0X", "0x")}/history`,
  );
  assert.equal(request.route, "history");
  assert.equal(request.wallet, wallet);
  assert.equal(request.kind, "transactions");
  assert.equal(request.page, null);
  const cursor = encodeHistoryCursor(request.scope, "transactions", {
    block_number: "1",
    index: "2",
  });
  const paged = parseRequest(`/v1/wallets/${wallet}/history?cursor=${cursor}`);
  assert.deepEqual(paged.page, { block_number: "1", index: "2" });
  assert.notEqual(paged.cacheKey, request.cacheKey);
  const transfers = parseRequest(
    `/v1/wallets/${wallet}/history?kind=token-transfers`,
  );
  assert.equal(transfers.kind, "token-transfers");
  const trades = parseRequest(`/v1/wallets/${wallet}/history?kind=trades`);
  assert.equal(trades.kind, "trades");
  assert.notEqual(trades.cacheKey, transfers.cacheKey);
  const tradesCursor = encodeHistoryCursor(trades.scope, "trades", {
    block_number: "1",
    index: "2",
  });
  assert.deepEqual(
    parseRequest(
      `/v1/wallets/${wallet}/history?kind=trades&cursor=${tradesCursor}`,
    ).page,
    { block_number: "1", index: "2" },
  );
  assert.throws(
    () =>
      parseRequest(
        `/v1/wallets/${wallet}/history?kind=token-transfers&cursor=${tradesCursor}`,
      ),
    RequestError,
  );
  for (const url of [
    `/v1/wallets/${wallet}/history?kind=logs`,
    `/v1/wallets/${wallet}/history?limit=5`,
    `/v1/wallets/${wallet}/history?kind=token-transfers&cursor=${cursor}`,
    `/v1/wallets/${"0x" + "1".repeat(40)}/history?cursor=${cursor}`,
    `/v1/wallets/${wallet}/history?cursor=${encodeHistoryCursor(request.scope, "transactions", {})}`,
    `/v1/wallets/${wallet}/history?cursor=%00`,
    `/v1/wallets/${wallet}/history/`,
  ])
    assert.throws(() => parseRequest(url), RequestError);
  assert.throws(
    () => decodeHistoryCursor(cursor, "other", "transactions"),
    /cursor/,
  );
  // The existing activity and profile routes keep their meaning.
  assert.equal(parseRequest(`/v1/wallets/${wallet}/activity`).route, "wallet");
  assert.equal(parseRequest(`/v1/wallets/${wallet}`).route, "profile");
});

test("history serves fresh, cached, stale and unavailable pages by cache state", async () => {
  let now = Date.parse("2026-09-15T12:00:00Z");
  let fail: BlockscoutError | null = null;
  let calls = 0;
  const readPage = async (kind: string, _wallet: string, page: unknown) => {
    calls++;
    if (fail) throw fail;
    return {
      items: [{ hash: `0x${String(calls).padStart(64, "0")}` } as never],
      nextPageParams: page ? null : { block_number: "1", index: "2" },
    };
  };
  const history = createWalletHistory({
    client: { readPage, budget: createCreditBudget({ dailyCap: 1 }) } as never,
    now: () => now,
    firstPageTtlMs: 30000,
    pageTtlMs: 600000,
    staleMaxAgeMs: 3600000,
  });
  const scope = "scope";
  const first = await history.read({
    wallet,
    kind: "transactions",
    page: null,
    scope,
  });
  assert.equal(first.source, "blockscout");
  assert.equal(first.chainId, 4663);
  assert.equal(first.stale, false);
  assert.equal(first.fetchedAt, "2026-09-15T12:00:00.000Z");
  assert(first.nextCursor);
  assert.equal(
    first.note,
    "Explorer history for display only; not accounting or PnL evidence.",
  );
  now += 29000;
  assert.equal(
    await history.read({ wallet, kind: "transactions", page: null, scope }),
    first,
  );
  assert.equal(calls, 1);
  now += 2000;
  const refreshed = await history.read({
    wallet,
    kind: "transactions",
    page: null,
    scope,
  });
  assert.equal(calls, 2);
  assert.notEqual(refreshed, first);
  const page = decodeHistoryCursor(first.nextCursor!, scope, "transactions");
  const deep = await history.read({
    wallet,
    kind: "transactions",
    page,
    scope,
  });
  assert.equal(deep.nextCursor, null);
  now += 599000;
  assert.equal(
    await history.read({ wallet, kind: "transactions", page, scope }),
    deep,
  );
  assert.equal(calls, 3);
  // Kinds and wallets never share entries.
  await history.read({ wallet, kind: "token-transfers", page: null, scope });
  assert.equal(calls, 4);
  // Failures serve what is cached, marked stale, otherwise a reasoned 503.
  fail = new BlockscoutError("budget_exhausted", 120);
  now += 60000;
  const stale = await history.read({
    wallet,
    kind: "transactions",
    page: null,
    scope,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, refreshed.fetchedAt);
  assert.deepEqual(stale.items, refreshed.items);
  assert.equal(refreshed.stale, false);
  await assert.rejects(
    history.read({
      wallet: "0x" + "2".repeat(40),
      kind: "transactions",
      page: null,
      scope,
    }),
    (e: RequestError) =>
      e.status === 503 &&
      e.code === "wallet_history_unavailable" &&
      e.reason === "budget_exhausted" &&
      e.retryAfter === 120,
  );
  fail = new BlockscoutError("misconfigured_key", 3600);
  await assert.rejects(
    history.read({
      wallet: "0x" + "3".repeat(40),
      kind: "transactions",
      page: null,
      scope,
    }),
    (e: RequestError) => e.reason === "key_rejected" && e.retryAfter === 3600,
  );
  fail = new BlockscoutError("upstream_unavailable", 30);
  await assert.rejects(
    history.read({
      wallet: "0x" + "3".repeat(40),
      kind: "transactions",
      page: null,
      scope,
    }),
    (e: RequestError) => e.reason === "upstream_unavailable",
  );
  // Stale entries expire after the maximum age.
  now += 3600000;
  await assert.rejects(
    history.read({ wallet, kind: "transactions", page: null, scope }),
    (e: RequestError) => e.reason === "upstream_unavailable",
  );
  await assert.rejects(
    createWalletHistory({ client: null }).read({
      wallet,
      kind: "transactions",
      page: null,
      scope,
    }),
    (e: RequestError) =>
      e.status === 503 &&
      e.reason === "not_configured" &&
      e.retryAfter === 3600,
  );
});

test("a trades response reads whole explorer pages until it holds enough trades, and ends early at a failing page", async () => {
  assert.equal(tradesPageTarget, 25);
  assert.equal(tradesMaxPages, 3);
  const trade = (n: number) => ({ logIndex: n }) as never;
  let script: ({ items: number; next: boolean } | BlockscoutError)[] = [];
  const pages: unknown[] = [];
  const readPage = async (kind: string, _wallet: string, page: unknown) => {
    assert.equal(kind, "trades");
    pages.push(page);
    const step = script.shift()!;
    if (step instanceof BlockscoutError) throw step;
    const at = pages.length;
    return {
      items: Array.from({ length: step.items }, (_, i) => trade(at * 100 + i)),
      nextPageParams: step.next
        ? { block_number: String(at), index: "0" }
        : null,
    };
  };
  const history = createWalletHistory({
    client: { readPage, budget: createCreditBudget({ dailyCap: 1 }) } as never,
  });
  const read = (w: string, page: Record<string, string> | null = null) =>
    history.read({ wallet: w, kind: "trades", page, scope: "s" });
  const cursorPage = (cursor: string | null) =>
    cursor && decodeHistoryCursor(cursor, "s", "trades");
  // A page crowded by poisoning logs keeps reading, up to three pages.
  script = [
    { items: 4, next: true },
    { items: 0, next: true },
    { items: 9, next: true },
    { items: 50, next: true },
  ];
  let body = await read("0x" + "a".repeat(40));
  assert.equal(body.items.length, 13);
  assert.deepEqual(pages, [
    null,
    { block_number: "1", index: "0" },
    { block_number: "2", index: "0" },
  ]);
  assert.deepEqual(cursorPage(body.nextCursor), {
    block_number: "3",
    index: "0",
  });
  // A full page, or the explorer's last page, stops at once.
  pages.length = 0;
  script = [{ items: 25, next: true }];
  body = await read("0x" + "b".repeat(40));
  assert.equal(body.items.length, 25);
  assert.equal(pages.length, 1);
  pages.length = 0;
  script = [{ items: 2, next: false }];
  body = await read("0x" + "c".repeat(40));
  assert.deepEqual(
    [body.items.length, body.nextCursor, pages.length],
    [2, null, 1],
  );
  // A later page that fails ends the response with what was read and a
  // cursor at the page that failed; a first page that fails is the 503.
  pages.length = 0;
  script = [
    { items: 3, next: true },
    new BlockscoutError("upstream_unavailable", 30),
  ];
  body = await read("0x" + "d".repeat(40), { block_number: "9", index: "1" });
  assert.equal(body.items.length, 3);
  assert.equal(body.stale, false);
  assert.deepEqual(cursorPage(body.nextCursor), {
    block_number: "1",
    index: "0",
  });
  script = [new BlockscoutError("budget_exhausted", 60)];
  await assert.rejects(
    read("0x" + "e".repeat(40)),
    (e: RequestError) => e.reason === "budget_exhausted",
  );
  // Other kinds still read exactly one page.
  const once: string[] = [];
  const single = createWalletHistory({
    client: {
      readPage: async (kind: string) => {
        once.push(kind);
        return { items: [], nextPageParams: { block_number: "1" } };
      },
      budget: createCreditBudget({ dailyCap: 1 }),
    } as never,
  });
  await single.read({
    wallet,
    kind: "token-transfers",
    page: null,
    scope: "s",
  });
  assert.deepEqual(once, ["token-transfers"]);
});

test("HTTP route answers explorer pages, reasoned 503s with Retry-After, and 503 when unconfigured", async (t) => {
  let outcome: WalletHistoryResponse | RequestError | Error = new RequestError(
    503,
    "wallet_history_unavailable",
    { reason: "budget_exhausted", retryAfter: 77 },
  );
  const seen: unknown[] = [];
  const history = {
    async read(input: unknown) {
      seen.push(input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const reader = { read: async () => ({}), close: async () => {} };
  const server = createApi(reader, { history });
  const unconfigured = createApi(reader);
  for (const s of [server, unconfigured]) {
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    t.after(() => new Promise<void>((resolve) => s.close(() => resolve())));
  }
  const urlOf = (s: typeof server) => {
    const a = s.address();
    assert(a && typeof a !== "string");
    return `http://127.0.0.1:${a.port}/v1/wallets/${wallet}/history`;
  };
  let res = await fetch(urlOf(server));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "77");
  assert.deepEqual(await res.json(), {
    error: "wallet_history_unavailable",
    reason: "budget_exhausted",
  });
  outcome = {
    source: "blockscout",
    chainId: 4663,
    wallet,
    kind: "token-transfers",
    items: [],
    nextCursor: null,
    fetchedAt: "2026-09-15T12:00:00.000Z",
    stale: false,
    note: "Explorer history for display only; not accounting or PnL evidence.",
  };
  const cursor = encodeHistoryCursor(
    parseRequest(`/v1/wallets/${wallet}/history?kind=token-transfers`).scope,
    "token-transfers",
    { block_number: "5", index: "1" },
  );
  res = await fetch(urlOf(server) + `?kind=token-transfers&cursor=${cursor}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-data-cache"), "MISS");
  assert.deepEqual(await res.json(), outcome);
  assert.deepEqual(seen.at(-1), {
    wallet,
    kind: "token-transfers",
    page: { block_number: "5", index: "1" },
    scope: parseRequest(`/v1/wallets/${wallet}/history?kind=token-transfers`)
      .scope,
  });
  // The server's generic response cache stays out of the way of stale/fresh.
  res = await fetch(urlOf(server) + `?kind=token-transfers&cursor=${cursor}`);
  assert.equal(res.headers.get("x-data-cache"), "MISS");
  assert.equal(seen.length, 3);
  // Two kinds of one wallet read at once are two reads, never one coalesced.
  const kindOf = history.read;
  history.read = async (input: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { kind } = input as { kind: string };
    return { ...(outcome as WalletHistoryResponse), kind } as never;
  };
  const both = await Promise.all(
    ["trades", "token-transfers"].map((kind) =>
      fetch(urlOf(server) + `?kind=${kind}`).then((r) => r.json()),
    ),
  );
  assert.deepEqual(
    both.map((b) => b.kind),
    ["trades", "token-transfers"],
  );
  history.read = kindOf;
  res = await fetch(urlOf(server) + "?kind=logs");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_kind" });
  outcome = Error("postgres://user:secret@host");
  res = await fetch(urlOf(server));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "data_temporarily_unavailable" });
  res = await fetch(urlOf(unconfigured));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "3600");
  assert.deepEqual(await res.json(), {
    error: "wallet_history_unavailable",
    reason: "not_configured",
  });
});

test("startup reads the key and limits by name and never requires them", async () => {
  const missing = createWalletHistoryFromEnv({});
  await assert.rejects(
    missing.read({ wallet, kind: "transactions", page: null, scope: "s" }),
    (e: RequestError) => e.reason === "not_configured",
  );
  assert.throws(
    () =>
      createWalletHistoryFromEnv({
        BLOCKSCOUT_API_KEY: key,
        BLOCKSCOUT_DAILY_CREDIT_CAP: "100000",
      }),
    /BLOCKSCOUT_DAILY_CREDIT_CAP/,
  );
  assert.throws(
    () =>
      createWalletHistoryFromEnv({
        BLOCKSCOUT_API_KEY: key,
        BLOCKSCOUT_PAGE_TTL_SECONDS: "0",
      }),
    /BLOCKSCOUT_PAGE_TTL_SECONDS/,
  );
  // A configured client with an unreachable override host fails as upstream.
  const configured = createWalletHistoryFromEnv({
    BLOCKSCOUT_API_KEY: key,
    BLOCKSCOUT_API_URL: "http://127.0.0.1:9",
    BLOCKSCOUT_DAILY_CREDIT_CAP: "50",
  });
  await assert.rejects(
    configured.read({ wallet, kind: "transactions", page: null, scope: "s" }),
    (e: RequestError) =>
      e.reason === "upstream_unavailable" && e.retryAfter === 30,
  );
});
