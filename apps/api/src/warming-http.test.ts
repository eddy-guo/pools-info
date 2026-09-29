import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApi } from "./server";
import { DatabaseWarmth } from "./database-warmth";
import { RequestError } from "./request";
import type { WalletHistory } from "./wallet-history";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const hash = "0x" + "1".repeat(64),
  wallet = "0x" + "2".repeat(40);
test("warming refuses all database routes before reads/cache/budget while health and independent upstreams retain their contracts", async (t) => {
  let reads = 0;
  const warmth = new DatabaseWarmth(async (c) => c.identity("db"));
  const server = createApi(
    {
      assertReady: (v) => warmth.assertReady(v),
      read: async (r) => {
        if (r.route === "ready") return { ready: true };
        reads++;
        return { reads };
      },
      close: async () => {},
    },
    {
      maxPerMinute: 100,
      history: {
        read: async () => {
          throw new RequestError(503, "history_unavailable", {
            reason: "upstream",
            retryAfter: 17,
          });
        },
        peekTrades: () => null,
        refreshTrades: async () => {
          throw Error("Unexpected trades refresh");
        },
      },
      ethPrice: {
        read: async () => {
          throw new RequestError(503, "eth_price_unavailable", {
            reason: "rate",
            retryAfter: 19,
          });
        },
      },
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await warmth.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await warmth.refresh();
  assert.equal((await fetch(base + "/v1/explore")).status, 200);
  assert.equal(
    (await fetch(base + "/v1/explore")).headers.get("x-data-cache"),
    "HIT",
  );
  warmth.invalidate("restart");
  for (const path of [
    "/v1/status",
    "/v1/pools",
    "/v1/trades",
    "/v1/live-trades",
    `/v1/feed?pools=${hash}`,
    `/v1/following?wallets=${wallet}`,
    "/v1/explore?sort=launch&limit=6",
    "/v1/explore",
    "/v1/leaderboard?window=24h&limit=5&minTrades=10",
    "/v1/creators",
    "/v1/search?q=abc",
    `/v1/pools/${hash}`,
    `/v1/pools/${hash}/image`,
    `/v1/wallets/${wallet}`,
    `/v1/wallets/${wallet}/activity`,
    `/v1/trades/${hash}/${hash}/0?wallet=${wallet}`,
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("retry-after"), "5", path);
    assert.deepEqual(
      await response.json(),
      { error: "data_temporarily_unavailable", reason: "warming" },
      path,
    );
  }
  assert.equal(reads, 1);
  assert.equal((await fetch(base + "/ready")).status, 503);
  assert.equal((await fetch(base + "/health")).status, 200);
  for (const [path, reason, retry] of [
    [`/v1/wallets/${wallet}/history`, "upstream", "17"],
    ["/v1/prices/eth-usd", "rate", "19"],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), retry);
    assert.equal((await response.json()).reason, reason);
  }
  await warmth.refresh();
  assert.equal((await fetch(base + "/ready")).status, 200);
  const fresh = await fetch(base + "/v1/explore");
  assert.equal(fresh.headers.get("x-data-cache"), "MISS");
  assert.deepEqual(await fresh.json(), { reads: 2 });
});

test("readiness follows a pending warm set on the fake clock", async (t) => {
  let time = 0;
  const finish = deferred();
  const warmth = new DatabaseWarmth(
    async (context) => {
      context.identity("db");
      await finish.promise;
    },
    { now: () => time },
  );
  const server = createApi(
    {
      assertReady: (version) => warmth.assertReady(version),
      read: async () => ({ ready: true }),
      close: async () => {},
    },
    { now: () => time },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await warmth.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const warming = warmth.refresh();
  assert.equal((await fetch(base + "/ready")).status, 503);
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/v1/status")).status, 503);
  time += 10_000;
  assert.equal((await fetch(base + "/ready")).status, 503);
  finish.resolve();
  await warming;
  assert.equal((await fetch(base + "/ready")).status, 200);
  assert.equal((await fetch(base + "/v1/status")).status, 200);
});

test("slow explorer reads cannot occupy database slots", async (t) => {
  const releases: (() => void)[] = [];
  let started = 0;
  const history = {
    read: async () => {
      started++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return { items: [] };
    },
    peekTrades: () => null,
    refreshTrades: async () => {},
  };
  const server = createApi(
    { read: async () => ({ items: [] }), close: async () => {} },
    { history: history as unknown as WalletHistory, maxPerMinute: 1000 },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    releases.forEach((release) => release());
    server.close();
    await once(server, "close");
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const held = Array.from({ length: 8 }, (_, i) =>
    fetch(`${base}/v1/wallets/0x${i.toString(16).padStart(40, "0")}/history`),
  );
  try {
    while (started < 8) await new Promise((resolve) => setImmediate(resolve));
    const excess = await fetch(
      `${base}/v1/wallets/0x${"f".repeat(40)}/history`,
      { signal: AbortSignal.timeout(1000) },
    );
    assert.equal(excess.status, 503);
    assert.deepEqual(await excess.json(), {
      error: "busy",
      reason: "explorer_slots",
    });
    const following = await fetch(
      `${base}/v1/following?wallets=0x${"b".repeat(40)}`,
    );
    assert.equal(following.status, 503);
    assert.deepEqual(await following.json(), {
      error: "busy",
      reason: "explorer_slots",
    });
    for (const path of ["/v1/explore", `/v1/pools/0x${"a".repeat(64)}`])
      assert.equal((await fetch(base + path)).status, 200, path);
  } finally {
    releases.forEach((release) => release());
    await Promise.allSettled(held);
  }
});

test("a response started before invalidation cannot be served or cached after recovery", async (t) => {
  const started = deferred(),
    finish = deferred();
  const warmth = new DatabaseWarmth(async (c) => c.identity("db"));
  await warmth.refresh();
  let calls = 0;
  const server = createApi({
    assertReady: (v) => warmth.assertReady(v),
    read: async () => {
      if (++calls === 1) {
        started.resolve();
        await finish.promise;
      }
      return { calls };
    },
    close: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await warmth.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/explore`;
  const old = fetch(url);
  await started.promise;
  warmth.invalidate("restart");
  await warmth.refresh();
  finish.resolve();
  assert.equal((await old).status, 503);
  const fresh = await fetch(url);
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { calls: 2 });
});
