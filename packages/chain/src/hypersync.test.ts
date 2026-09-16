import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toEventSelector } from "viem";
import {
  HyperSyncBudgetExceeded,
  HyperSyncClient,
  HyperSyncPageCapacity,
  HyperSyncRateLimitExhausted,
  HyperSyncRequestRejected,
  HyperSyncResponseCapacity,
  HyperSyncUnauthorized,
  checkedPage,
  chunkValues,
  collectLogPages,
  headerQuery,
  hypersyncPolicy,
  swapLogQuery,
  transferLogQuery,
  type HyperSyncQuery,
} from "./hypersync";
import { FakeHyperSync, word } from "./hypersync-fake";
import { contracts, swapEvent } from "./events";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/hypersync/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const from = 62688988,
  to = 62689007;
const ids = [
  "0x53a3e65a7b8a1810d2817613c3306b9fd90d24ad1ee228a61e8ef0d180289690",
  "0x04e6573d923e3b56bece9b517d729240a6683e2249683f6820c925c3ae149026",
  "0x7c937497e9c34c9e79a37a59bfcf9df70303c208c533d5a190dd4759ea7af9ec",
  "0xfb666aa663e2368def11a9fe82862190c40bf903d83ae9f343bcd38e7719e602",
];
const tokens = [
  "0x433025fe9550ed919d8b28b53a3f5419be678d0d",
  "0xb480aa907f5ca5364daa47508f06d248411f28be",
];
const token = "x".repeat(16);

test("query builders reproduce the recorded request bodies exactly", () => {
  assert.deepEqual(
    swapLogQuery({ fromBlock: from, toBlock: to }),
    fixture("swaps-unfiltered.request"),
  );
  assert.deepEqual(
    swapLogQuery({ fromBlock: from, toBlock: to }, ids),
    fixture("swaps-pool-filter.request"),
  );
  assert.deepEqual(
    transferLogQuery({ fromBlock: from, toBlock: to }, tokens),
    fixture("transfers-token-filter.request"),
  );
  assert.deepEqual(headerQuery(from), fixture("header-single-block.request"));
});

test("recorded responses validate with their verbatim encodings", () => {
  const cases: [string, HyperSyncQuery, [number, number, number], number][] = [
    [
      "swaps-unfiltered",
      swapLogQuery({ fromBlock: from, toBlock: to }),
      [73, 50, 19],
      64149078,
    ],
    [
      "swaps-pool-filter",
      swapLogQuery({ fromBlock: from, toBlock: to }, ids),
      [5, 5, 4],
      64149088,
    ],
    [
      "transfers-token-filter",
      transferLogQuery({ fromBlock: from, toBlock: to }, tokens),
      [9, 3, 3],
      64149136,
    ],
    ["header-single-block", headerQuery(from), [0, 0, 1], 64149147],
  ];
  for (const [name, query, counts, archive] of cases) {
    const raw = fixture(`${name}.response`);
    const page = checkedPage(query, raw, 1);
    assert.deepEqual(
      [page.logs.length, page.transactions.length, page.blocks.length],
      counts,
      name,
    );
    assert.equal(page.archiveHeight, archive);
    assert.equal(
      page.nextBlock,
      name === "header-single-block" ? from + 1 : to + 1,
    );
    assert.equal(page.rollbackGuard, null);
    // Rows keep exactly the selected keys and the server's encodings.
    for (const b of page.blocks) {
      assert.match(b.timestamp, /^0x[0-9a-f]+$/);
      assert.deepEqual(Object.keys(b), [
        "number",
        "hash",
        "parent_hash",
        "timestamp",
      ]);
    }
    for (const l of page.logs) {
      assert.equal(typeof l.block_number, "number");
      assert.equal(l.removed, false);
      assert.equal("topic3" in l, false);
    }
    for (const t of page.transactions) assert.equal(t.status, 1);
  }
  const unfiltered = checkedPage(
    swapLogQuery({ fromBlock: from, toBlock: to }),
    fixture("swaps-unfiltered.response"),
    1,
  );
  assert.equal(
    unfiltered.blocks.some((b) => b.number === 62688995),
    false,
  );
  assert.equal(new Set(unfiltered.logs.map((l) => l.topic1)).size, 41);
  const filtered = checkedPage(
    swapLogQuery({ fromBlock: from, toBlock: to }, ids),
    fixture("swaps-pool-filter.response"),
    1,
  );
  assert.deepEqual(
    filtered.logs,
    unfiltered.logs.filter((l) => ids.includes(String(l.topic1))),
  );
});

test("page validation fails closed on every malformed shape", () => {
  const query = swapLogQuery({ fromBlock: from, toBlock: to });
  const good = fixture("swaps-unfiltered.response");
  const mutate = (change: (r: any) => void) => {
    const r = structuredClone(good);
    change(r);
    return r;
  };
  // The documented struct form of `data` is accepted alongside the wire array.
  assert.equal(
    checkedPage(
      query,
      mutate((r) => (r.data = r.data[0])),
      1,
    ).logs.length,
    73,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.next_block = to + 2)),
        1,
      ),
    /invalid response envelope/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.next_block = from - 1)),
        1,
      ),
    /invalid response envelope/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].logs[0].block_number = to + 1)),
        1,
      ),
    /log outside the page/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].logs[0].removed = true)),
        1,
      ),
    /invalid log row/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => delete r.data[0].logs[0].topic1),
        1,
      ),
    /invalid log topic/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].logs[0].topic1 = "0x12")),
        1,
      ),
    /invalid log topic/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].logs[0].log_index = "0x14")),
        1,
      ),
    /invalid log row/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].transactions[0].status = 2)),
        1,
      ),
    /invalid transaction row/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].transactions[0].from = "0xabc")),
        1,
      ),
    /invalid transaction row/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].blocks[0].timestamp = 1783567659)),
        1,
      ),
    /invalid block row/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.data[0].blocks[0].number = from - 1)),
        1,
      ),
    /block outside the page/,
  );
  assert.throws(
    () =>
      checkedPage(
        query,
        mutate((r) => (r.rollback_guard = { hash: "0x1" })),
        1,
      ),
    /invalid rollback guard/,
  );
  assert.throws(
    () => checkedPage(query, good, 1, 50),
    HyperSyncResponseCapacity,
  );
});

test("selections are chunked and bounded by the measured request limit", () => {
  assert.deepEqual(chunkValues([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const many = Array.from(
    { length: hypersyncPolicy.topicValuesPerSelection * 2 },
    (_, i) => word(i + 1),
  );
  assert.equal(
    swapLogQuery({ fromBlock: from, toBlock: to }, many).logs?.length,
    2,
  );
  assert.throws(
    () =>
      swapLogQuery({ fromBlock: from, toBlock: to }, [...many, word(1000000)]),
    /Invalid HyperSync query/,
  );
  assert.throws(
    () => swapLogQuery({ fromBlock: from, toBlock: to }, [ids[0], ids[0]]),
    /Invalid HyperSync pool id selection/,
  );
  assert.throws(
    () => swapLogQuery({ fromBlock: from, toBlock: to }, []),
    /Invalid HyperSync pool id selection/,
  );
  assert.throws(
    () => transferLogQuery({ fromBlock: from, toBlock: to }, ["0x12"]),
    /Invalid HyperSync token selection/,
  );
  const tokens = Array.from(
    { length: hypersyncPolicy.topicValuesPerSelection * 2 + 1 },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
  );
  assert.equal(
    transferLogQuery({ fromBlock: from, toBlock: to }, tokens.slice(1)).logs
      ?.length,
    2,
  );
  assert.throws(
    () => transferLogQuery({ fromBlock: from, toBlock: to }, tokens),
    /Invalid HyperSync query/,
  );
  assert.throws(
    () => swapLogQuery({ fromBlock: to, toBlock: from }),
    /Invalid HyperSync block range/,
  );
});

function client(
  fake: FakeHyperSync,
  options: Partial<ConstructorParameters<typeof HyperSyncClient>[0]> = {},
) {
  return new HyperSyncClient({
    url: "https://4663.hypersync.xyz",
    token,
    fetch: fake.fetch,
    minIntervalMs: 0,
    retryBaseMs: 1,
    ...options,
  });
}
const swapLog = (block: number, index: number, pool = ids[0]) => ({
  block,
  logIndex: index,
  transactionHash: word(block * 1000 + index),
  address: contracts.manager,
  topics: [toEventSelector(swapEvent), pool, word(4)],
  data: `0x${"00".repeat(192)}`,
  from: "0x2222222222222222222222222222222222222222",
});

test("the client sends bearer auth, paces requests and reads height without a token", async () => {
  const fake = new FakeHyperSync({ height: 100, logs: [swapLog(10, 0)] });
  const keyless = new HyperSyncClient({
    url: "https://4663.hypersync.xyz",
    fetch: fake.fetch,
    minIntervalMs: 0,
  });
  assert.equal(await keyless.height(), 100);
  assert.equal(fake.requests[0].headers.authorization, undefined);
  assert.equal(keyless.authenticated, false);
  await assert.rejects(
    keyless.query(swapLogQuery({ fromBlock: 0, toBlock: 20 })),
    HyperSyncUnauthorized,
  );
  assert.equal(fake.requests.length, 1);
  const paced = client(fake, { minIntervalMs: 40 });
  const started = Date.now();
  const page = await paced.query(swapLogQuery({ fromBlock: 0, toBlock: 20 }));
  await paced.height();
  assert.ok(Date.now() - started >= 40);
  assert.equal(fake.requests[1].headers.authorization, `Bearer ${token}`);
  assert.equal(fake.requests[1].headers["content-type"], "application/json");
  assert.equal(page.logs.length, 1);
  assert.equal(page.nextBlock, 21);
  assert.equal(paced.requests, 2);
  assert.ok(paced.bytes > 0);
  assert.deepEqual(await paced.header(5), fake.block(5));
});

test("the client retries throttling and server errors with bounds and never retries rejections", async () => {
  const statuses: number[] = [];
  const events: unknown[] = [];
  const fake = new FakeHyperSync({
    height: 100,
    intercept: () => {
      const status = statuses.shift();
      return status === undefined
        ? undefined
        : new Response("", {
            status,
            headers: status === 429 ? { "retry-after": "0.001" } : {},
          });
    },
  });
  const c = client(fake, { onRetry: (e) => events.push(e) });
  statuses.push(429, 503);
  assert.equal(await c.height(), 100);
  assert.deepEqual(
    events.map((e: any) => [e.attempt, e.status, e.reason]),
    [
      [1, 429, "throttled"],
      [2, 503, "server_error"],
    ],
  );
  assert.equal(c.requests, 3);
  statuses.push(429, 429, 429, 429);
  await assert.rejects(c.height(), HyperSyncRateLimitExhausted);
  statuses.push(500, 500, 500, 500);
  await assert.rejects(c.height(), HyperSyncRequestRejected);
  statuses.push(401);
  await assert.rejects(c.height(), HyperSyncUnauthorized);
  statuses.push(413);
  await assert.rejects(
    c.height(),
    (e: HyperSyncRequestRejected) => e.status === 413,
  );
  const before = c.requests;
  statuses.push(413);
  await assert.rejects(c.height());
  assert.equal(c.requests, before + 1);
  const failing = client(
    new FakeHyperSync({
      height: 1,
      intercept: () => {
        throw new TypeError("fetch failed");
      },
    }),
  );
  await assert.rejects(failing.height(), /failed after retries/);
  assert.equal(failing.requests, hypersyncPolicy.maxAttempts);
});

test("the client bounds requests, bytes and rows before any row is inspected", async () => {
  const fake = new FakeHyperSync({
    height: 100,
    logs: [swapLog(10, 0), swapLog(10, 1)],
  });
  const budgeted = client(fake, { maxRequests: 1 });
  await budgeted.height();
  await assert.rejects(budgeted.height(), HyperSyncBudgetExceeded);
  const tiny = client(fake, { maxResponseBytes: 1024 });
  await assert.rejects(
    tiny.query(swapLogQuery({ fromBlock: 0, toBlock: 20 })),
    HyperSyncResponseCapacity,
  );
  const rows = client(fake, { maxRowsPerTable: 1 });
  await assert.rejects(
    rows.query(swapLogQuery({ fromBlock: 0, toBlock: 20 })),
    HyperSyncResponseCapacity,
  );
  const invalid = client(
    new FakeHyperSync({
      height: 1,
      intercept: () => new Response("{not json", { status: 200 }),
    }),
  );
  await assert.rejects(invalid.height(), /invalid JSON/);
  assert.throws(
    () => new HyperSyncClient({ url: "http://example.com/path" }),
    /Invalid HYPERSYNC_URL/,
  );
  assert.throws(
    () => new HyperSyncClient({ token: "short" }),
    /Invalid ENVIO_API_TOKEN/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(client(fake, { signal: aborted.signal }).height());
});

test("page collection consumes whole pages and cuts a batch at a block boundary", async () => {
  const logs = [0, 1, 2, 3, 4, 5, 6].flatMap((b) => [
    swapLog(10 + b, 0),
    swapLog(10 + b, 1),
  ]);
  const fake = new FakeHyperSync({ height: 1000, logs, maxLogsPerPage: 4 });
  const c = client(fake);
  const query = swapLogQuery({ fromBlock: 0, toBlock: 40 });
  const all = await collectLogPages(c, query, {
    maxPages: 8,
    maxLogs: 100,
    maxBytes: 1 << 20,
  });
  assert.equal(all.toBlock, 40);
  assert.equal(all.logs.length, 14);
  assert.deepEqual(
    all.pages.map((p) => [p.fromBlock, p.nextBlock, p.logs]),
    [
      [0, 12, 4],
      [12, 14, 4],
      [14, 16, 4],
      [16, 41, 2],
    ],
  );
  assert.equal(all.transactions.size, 14);
  assert.equal(all.blocks.size, 7);
  const capped = await collectLogPages(c, query, {
    maxPages: 8,
    maxLogs: 6,
    maxBytes: 1 << 20,
  });
  assert.equal(capped.toBlock, 11);
  assert.equal(capped.logs.length, 4);
  const paged = await collectLogPages(c, query, {
    maxPages: 2,
    maxLogs: 100,
    maxBytes: 1 << 20,
  });
  assert.equal(paged.toBlock, 13);
  await assert.rejects(
    collectLogPages(c, query, { maxPages: 8, maxLogs: 3, maxBytes: 1 << 20 }),
    HyperSyncPageCapacity,
  );
  fake.height = 40 + hypersyncPolicy.safeDistance - 1;
  await assert.rejects(
    collectLogPages(c, query, { maxPages: 8, maxLogs: 100, maxBytes: 1 << 20 }),
    /archive height below the confirmed cutoff/,
  );
});
