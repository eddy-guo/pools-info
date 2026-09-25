import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApi } from "./server";
import { DatabaseWarmth } from "./database-warmth";
import { RequestError } from "./request";

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
  assert.equal((await fetch(base + "/ready")).status, 200);
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
  const fresh = await fetch(base + "/v1/explore");
  assert.equal(fresh.headers.get("x-data-cache"), "MISS");
  assert.deepEqual(await fresh.json(), { reads: 2 });
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
