import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseFollowingWallets } from "@pools/core";
import type { WalletHistoryTrade } from "@pools/core";
import {
  createBlockscoutClient,
  createCreditBudget,
  type PageParams,
} from "./blockscout-client";
import {
  createFollowing,
  followingPolicy,
  type Following,
} from "./following-read";
import { parseRequest, RequestError } from "./request";
import { createApi } from "./server";
import { createTokenRegistry, type TokenRegistry } from "./token-registry";
import {
  createWalletHistory,
  type TradesSnapshot,
  type WalletHistory,
} from "./wallet-history";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
test("following requests bound, normalize and scope the explicit local list", () => {
  assert.deepEqual(parseFollowingWallets(null), []);
  assert.deepEqual(parseFollowingWallets(""), []);
  assert.equal(parseRequest("/v1/following").limit, 50);
  assert.deepEqual(
    parseRequest(
      `/v1/following?wallets=${address(12).toUpperCase()},${address(11)}`,
    ).wallets,
    [address(11), address(12)],
  );
  assert.equal(
    parseRequest(`/v1/following?wallets=${address(11)},${address(12)}`)
      .cacheKey,
    parseRequest(`/v1/following?wallets=${address(12)},${address(11)}`)
      .cacheKey,
  );
  assert.notEqual(
    parseRequest(`/v1/following?wallets=${address(11)}`).cacheKey,
    parseRequest(`/v1/following?wallets=${address(12)}`).cacheKey,
  );
  for (const suffix of [
    "?limit=0",
    "?limit=51",
    "?limit=2&limit=3",
    "?wallets=&wallets=",
    "?wallets=bad",
    `?wallets=${address(1)},`,
    `?wallets=${address(1)},${address(1)}`,
    `?wallets=${Array.from({ length: 201 }, (_, i) => address(i)).join(",")}`,
    "?q=all",
    "?cursor=123",
  ])
    assert.throws(() => parseRequest(`/v1/following${suffix}`));
  assert.equal(
    parseRequest(
      `/v1/following?wallets=${Array.from({ length: 200 }, (_, i) => address(i)).join(",")}`,
    ).wallets.length,
    200,
  );
});
const token = (n: number) => `0x${(0xa000 + n).toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function trade(
  block: number,
  logIndex: number,
  tokenN = 1,
  side: "buy" | "sell" = "buy",
): WalletHistoryTrade {
  return {
    transactionHash: hash(block * 1000 + logIndex),
    logIndex,
    block,
    timestamp: block,
    side,
    token: {
      address: token(tokenN),
      symbol: `T${tokenN}`,
      name: `Token ${tokenN}`,
      decimals: 18,
      type: "ERC-20",
    },
    tokenRaw: "1000000000000000000",
    method: "execute",
  };
}
function registryOf(tokens: number[]): TokenRegistry {
  const set = new Set(tokens.map(token));
  return {
    current: async () => set,
    poolOf: (t) =>
      set.has(t) ? hash(0xb000 + parseInt(t.slice(-4), 16)) : null,
  };
}
/** An explorer cache over scripted first pages, counting reads per wallet. */
function fakeHistory(clock: () => number) {
  const pages = new Map<
    string,
    { items: WalletHistoryTrade[]; next: PageParams | null }
  >();
  const cache = new Map<string, TradesSnapshot>();
  const reads: string[] = [];
  let fail: RequestError | null = null;
  const history: WalletHistory = {
    read: async () => {
      throw Error("Unexpected history read");
    },
    peekTrades: (w) => cache.get(w) ?? null,
    async refreshTrades(w, options) {
      assert.equal(options?.reserveShare, followingPolicy.reserveShare);
      reads.push(w);
      if (fail) {
        const last = cache.get(w);
        if (!last) throw fail;
        return { ...last, stale: true, reason: fail.reason as never };
      }
      const page = pages.get(w) ?? { items: [], next: null };
      const snapshot = {
        ...page,
        fetchedAt: clock(),
        stale: false,
        reason: null,
      };
      cache.set(w, snapshot);
      return snapshot;
    },
  };
  return {
    history,
    pages,
    reads,
    failWith(error: RequestError | null) {
      fail = error;
    },
  };
}

test("empty following reads nothing and reports no invented coverage", async () => {
  const following = createFollowing({
    history: fakeHistory(Date.now).history,
    registry: {
      current: async () => {
        throw Error("Unexpected registry read");
      },
      poolOf: () => null,
    },
    activity: async () => {
      throw Error("Unexpected ledger read");
    },
  });
  const result = await following.read([], 50);
  assert.deepEqual(result.items, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.coverage.requestedWallets, 0);
  assert.deepEqual(result.coverage.wallets, []);
  assert.equal(result.coverage.complete, false);
});

test("following merges each wallet's newest explorer trades, disclosing where each wallet's page ends, with no ETH figure", async () => {
  const now = 1_790_000_000_000;
  const fake = fakeHistory(() => now);
  // Wallet 1's page reaches its first transfer; wallet 2's ends at block 50,
  // so wallet 2 may have older trades than its page shows, but that never
  // hides wallet 1's older trades.
  fake.pages.set(address(1), {
    items: [trade(90, 3), trade(40, 1, 2, "sell"), trade(10, 0)],
    next: null,
  });
  fake.pages.set(address(2), {
    items: [trade(95, 7, 1, "sell"), trade(50, 4)],
    next: { block_number: "50", index: "4" },
  });
  // A token the registry no longer holds drops even from a cached page.
  fake.pages.set(address(3), { items: [trade(99, 1, 9)], next: null });
  const following = createFollowing({
    history: fake.history,
    registry: registryOf([1, 2]),
    activity: async () => new Map(),
    now: () => now,
  });
  const result = await following.read([address(2), address(1), address(3)], 50);
  assert.deepEqual(
    result.items.map((i) => [i.wallet, i.block, i.logIndex, i.side]),
    [
      [address(2), 95, 7, "sell"],
      [address(1), 90, 3, "buy"],
      [address(2), 50, 4, "buy"],
      [address(1), 40, 1, "sell"],
      [address(1), 10, 0, "buy"],
    ],
  );
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items[0], {
    id: `${hash(95007)}:7`,
    wallet: address(2),
    poolId: hash(0xb000 + 0xa001),
    token: token(1),
    symbol: "T1",
    name: "Token 1",
    decimals: 18,
    txHash: hash(95007),
    logIndex: 7,
    block: 95,
    timestamp: 95,
    side: "sell",
    tokenRaw: "1000000000000000000",
    method: "execute",
  });
  for (const item of result.items) {
    assert.equal("ethWei" in item, false);
    assert.equal("priceWei" in item, false);
  }
  assert.equal(result.source, "blockscout");
  assert.equal(result.scope, "explorer_registry_trades");
  assert.equal(result.coverage.returnedTokens, 2);
  assert.deepEqual(
    result.coverage.wallets.map((w) => [
      w.wallet,
      w.status,
      w.olderTrades,
      w.horizonBlock,
    ]),
    [
      [address(1), "read", false, null],
      [address(2), "read", true, 50],
      [address(3), "read", false, null],
    ],
  );
  assert.equal(
    result.coverage.wallets[0].fetchedAt,
    new Date(now).toISOString(),
  );
  // The limit cuts the merged list and says so.
  const one = await following.read([address(1)], 2);
  assert.deepEqual(
    one.items.map((i) => i.block),
    [90, 40],
  );
  assert.equal(one.hasMore, true);
  const all = await following.read([address(1)], 3);
  assert.equal(all.hasMore, false);
});

test("following reads a wallet again only on newer ledger activity or age, within the answer's read bound", async () => {
  let now = 1_790_000_000_000;
  const seconds = () => Math.floor(now / 1000);
  const fake = fakeHistory(() => now);
  const ledger = new Map<string, number>();
  let signal = true;
  const following = createFollowing({
    history: fake.history,
    registry: registryOf([1]),
    activity: async (wallets) => {
      assert.ok(wallets.length);
      return signal ? ledger : null;
    },
    now: () => now,
  });
  const wallets = Array.from({ length: 25 }, (_, i) => address(100 + i));
  for (const wallet of wallets) ledger.set(wallet, 0);
  // The most recently active wallets are read first; the rest wait.
  ledger.set(address(124), seconds() - 10);
  ledger.set(address(123), seconds() - 20);
  let result = await following.read(wallets, 50);
  assert.equal(fake.reads.length, 8);
  assert.deepEqual(fake.reads.slice(0, 2), [address(124), address(123)]);
  assert.equal(
    result.coverage.wallets.filter((w) => w.status === "pending").length,
    17,
  );
  assert.equal(
    result.coverage.wallets.find((w) => w.status === "pending")?.fetchedAt,
    null,
  );
  await following.read(wallets, 50);
  await following.read(wallets, 50);
  result = await following.read(wallets, 50);
  assert.equal(fake.reads.length, 25);
  assert.ok(result.coverage.wallets.every((w) => w.status === "read"));
  assert.equal(new Set(fake.reads).size, 25);
  // Quiet wallets and activity already listed cost nothing.
  fake.reads.length = 0;
  now += 3_000_000;
  fake.pages.set(address(100), {
    items: [trade(seconds() - 5, 1)],
    next: null,
  });
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, []);
  // A new trade in the ledger is read once the page is two minutes old...
  ledger.set(address(100), seconds() - 5);
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, [address(100)]);
  // ...and once the page lists it, never again for it.
  now += 600_000;
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, [address(100)]);
  // Activity the page cannot list (the explorer is behind) is retried every
  // five minutes while it is younger than fifteen, then left to the age limit.
  fake.reads.length = 0;
  ledger.set(address(101), seconds() - 1);
  now += 120_000;
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, [address(101)]);
  now += 120_000;
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, [address(101)]);
  now += 180_000;
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, [address(101), address(101)]);
  now += 900_000;
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, [address(101), address(101)]);
  // Every page is read again after six hours, eight per answer.
  fake.reads.length = 0;
  now += followingPolicy.maxAgeMs;
  await following.read(wallets, 50);
  assert.equal(fake.reads.length, 8);
  // Without a ledger signal a page is read again after ten minutes.
  for (let i = 0; i < 3; i++) await following.read(wallets, 50);
  assert.equal(fake.reads.length, 25);
  fake.reads.length = 0;
  signal = false;
  now += 599_000;
  await following.read(wallets, 50);
  assert.deepEqual(fake.reads, []);
  now += 1_000;
  await following.read(wallets, 50);
  assert.equal(fake.reads.length, 8);
});

test("a wallet missing from ledger activity refreshes after ten minutes", async () => {
  let now = 1_790_000_000_000;
  const fake = fakeHistory(() => now);
  const wallet = address(1);
  const following = createFollowing({
    history: fake.history,
    registry: registryOf([1]),
    activity: async () => new Map([[address(2), Math.floor(now / 1000)]]),
    now: () => now,
  });
  await following.read([wallet], 50);
  now += followingPolicy.unsignalledRefreshMs - 1;
  await following.read([wallet], 50);
  assert.deepEqual(fake.reads, [wallet]);
  now += 1;
  await following.read([wallet], 50);
  assert.deepEqual(fake.reads, [wallet, wallet]);
});

test("following discloses a failed or spent explorer per wallet and never fills it", async () => {
  let now = 1_790_000_000_000;
  const fake = fakeHistory(() => now);
  fake.pages.set(address(1), { items: [trade(90, 1)], next: null });
  const following = createFollowing({
    history: fake.history,
    registry: registryOf([1]),
    activity: async () => {
      throw Error("ledger statement cancelled");
    },
    now: () => now,
  });
  const writes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await following.read([address(1)], 50);
    const spent = new RequestError(503, "wallet_history_unavailable", {
      reason: "budget_exhausted",
      retryAfter: 600,
    });
    fake.failWith(spent);
    now += followingPolicy.maxAgeMs;
    const result = await following.read([address(1), address(2)], 50);
    assert.deepEqual(
      result.items.map((i) => i.block),
      [90],
    );
    assert.deepEqual(result.coverage.wallets, [
      {
        wallet: address(1),
        status: "stale",
        fetchedAt: new Date(now - followingPolicy.maxAgeMs).toISOString(),
        reason: "budget_exhausted",
        olderTrades: false,
        horizonBlock: null,
      },
      {
        wallet: address(2),
        status: "unavailable",
        fetchedAt: null,
        reason: "budget_exhausted",
        olderTrades: false,
        horizonBlock: null,
      },
    ]);
    // Nothing read for any wallet: the answer is the explorer's own 503.
    await assert.rejects(
      following.read([address(2), address(3)], 50),
      (e: RequestError) =>
        e.status === 503 &&
        e.code === "wallet_history_unavailable" &&
        e.reason === "budget_exhausted" &&
        e.retryAfter === 600,
    );
  } finally {
    process.stderr.write = write;
  }
  assert.ok(
    writes.every((w) => w === '{"event":"following_activity_failed"}\n'),
  );
  await assert.rejects(
    createFollowing({
      history: fake.history,
      registry: null,
      activity: async () => null,
    }).read([address(1)], 50),
    (e: RequestError) => e.status === 503 && e.reason === "not_configured",
  );
  await assert.rejects(following.read([address(1)], 51), /invalid_limit/);
});

test("following leaves the wallet page a fifth of the day's credits and shares the explorer cache with it", async () => {
  const wallet = address(7);
  let calls = 0;
  const budget = createCreditBudget({ dailyCap: 300 });
  const history = createWalletHistory({
    client: {
      budget,
      async readPage(
        kind: string,
        _wallet: string,
        _page: unknown,
        reserveShare = 0,
      ) {
        assert.equal(kind, "trades");
        budget.spend(30, Math.ceil(budget.snapshot().dailyCap * reserveShare));
        calls++;
        await new Promise((resolve) => setImmediate(resolve));
        return {
          items: [trade(90, 1), trade(80, 1, 9)],
          nextPageParams: null,
        };
      },
    } as never,
    registry: createTokenRegistry(async () => [
      { ref: 1, poolId: hash(1), token: token(1) },
    ]),
  });
  // Concurrent reads of one page share one call.
  const [a, b] = await Promise.all([
    history.refreshTrades(wallet, { reserveShare: 0.2 }),
    history.read({ wallet, kind: "trades", page: null, scope: "s" }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(
    a.items.map((i) => i.token.address),
    [token(1)],
  );
  assert.deepEqual(b.items, a.items);
  assert.equal(history.peekTrades(wallet)?.fetchedAt, a.fetchedAt);
  // 240 of 300 credits is Following's share; past it the page is served stale.
  for (let i = 1; i < 8; i++)
    await history.refreshTrades(address(100 + i), { reserveShare: 0.2 });
  assert.equal(budget.snapshot().spent, 240);
  const refused = await history.refreshTrades(wallet, { reserveShare: 0.2 });
  assert.equal(calls, 8);
  assert.equal(refused.stale, true);
  assert.equal(refused.reason, "budget_exhausted");
  await assert.rejects(
    history.refreshTrades(address(9), { reserveShare: 0.2 }),
    (e: RequestError) => e.reason === "budget_exhausted",
  );
  // The wallet page still reads its own.
  await history.read({
    wallet: address(9),
    kind: "trades",
    page: null,
    scope: "s",
  });
  assert.equal(calls, 9);
});

test("concurrent following refreshes keep the wallet-page credit reserve", async () => {
  let calls = 0;
  const client = createBlockscoutClient({
    key: "test-key",
    baseUrl: "https://example.test/api/v2",
    dailyCreditCap: 300,
    limiter: {
      acquire: async () =>
        new Promise<void>((resolve) => setImmediate(resolve)),
    },
    fetchImpl: async () => {
      calls++;
      return new Response(
        JSON.stringify({ items: [], next_page_params: null }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  const history = createWalletHistory({
    client,
    registry: createTokenRegistry(async () => [
      { ref: 1, poolId: hash(1), token: token(1) },
    ]),
  });
  const results = await Promise.allSettled(
    Array.from({ length: 9 }, (_, i) =>
      history.refreshTrades(address(i + 1), { reserveShare: 0.2 }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 8);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(client.budget.snapshot().spent, 240);
  assert.equal(calls, 8);
  await history.read({
    wallet: address(10),
    kind: "trades",
    page: null,
    scope: "s",
  });
  assert.equal(client.budget.snapshot().spent, 270);
});

test("following HTTP answers are never served from the response cache, and 503 without the explorer", async (t) => {
  let reads = 0;
  const reader = {
    read: async () => {
      throw Error("Following is not a database route");
    },
    close: async () => {},
  };
  const following = {
    read: async () => ({ items: reads++ ? [] : [{ id: "first" }] }),
  } as unknown as Following;
  const servers = [createApi(reader, { following }), createApi(reader)];
  for (const s of servers) {
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    t.after(() => new Promise<void>((resolve) => s.close(() => resolve())));
  }
  const url = (i: number) => {
    const bound = servers[i].address();
    assert.ok(bound && typeof bound !== "string");
    return `http://127.0.0.1:${bound.port}/v1/following?wallets=${address(1)}`;
  };
  assert.equal((await (await fetch(url(0))).json()).items.length, 1);
  assert.equal((await (await fetch(url(0))).json()).items.length, 0);
  assert.equal(reads, 2);
  const unconfigured = await fetch(url(1));
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.headers.get("retry-after"), "3600");
  assert.deepEqual(await unconfigured.json(), {
    error: "wallet_history_unavailable",
    reason: "not_configured",
  });
});
