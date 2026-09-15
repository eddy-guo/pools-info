import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseFollowingWallets } from "@pools/core";
import { parseRequest } from "./request";
import { readFollowing } from "./following-read";
import { createApi } from "./server";

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
test("empty following performs no database query and reports no invented freshness", async () => {
  const result = await readFollowing(async () => {
    throw Error("Unexpected database query");
  }, []);
  assert.deepEqual(result.items, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.coverage.asOf, null);
  assert.equal(result.coverage.complete, false);
});
test("following HTTP polls bypass saved response cache after a source rewind", async (t) => {
  let reads = 0;
  const server = createApi({
    read: async () => ({ items: reads++ ? [] : [{ id: "before-rewind" }] }),
    close: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const url = `http://127.0.0.1:${bound.port}/v1/following?wallets=${address(1)}`;
  assert.equal((await (await fetch(url)).json()).items.length, 1);
  assert.equal((await (await fetch(url)).json()).items.length, 0);
  assert.equal(reads, 2);
});
