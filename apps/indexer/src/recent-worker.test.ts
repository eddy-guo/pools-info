import test from "node:test";
import assert from "node:assert/strict";
import { toEventSelector } from "viem";
import {
  Rpc,
  contracts,
  launchEvent,
  swapEvent,
  tokenMetadataFactory,
  tokenMetadataTopic,
  type RawLog,
} from "@pools/chain";
import { prepareRecentCycleRpc, recentCycleRpc } from "./recent-worker";
test("one chain view per cycle: chain id, head and each canonical header reach the provider once; the combined log query serves both collectors exactly", async () => {
  const rpc = new Rpc();
  const provider: string[] = [];
  const header = (n: number) => ({
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, "0")}`,
  });
  rpc.call = async <T>(m: string, p: unknown[]) => {
    provider.push(p.length ? `${m}:${p[0]}` : m);
    if (m === "eth_chainId") return "0x1237" as T;
    if (m === "eth_blockNumber") return "0x3e8" as T;
    return header(Number(p[0])) as T;
  };
  rpc.batch = async <T>(m: string, ps: unknown[][]) => {
    provider.push(`${m}x${ps.map((p) => p[0]).join(",")}`);
    return ps.map((p) =>
      m === "eth_getBlockByNumber"
        ? header(Number(p[0]))
        : { transactionHash: p[0] },
    ) as T[];
  };
  recentCycleRpc(rpc);
  for (let i = 0; i < 2; i++) {
    assert.equal(await rpc.call("eth_chainId", []), "0x1237");
    assert.equal(await rpc.call("eth_blockNumber", []), "0x3e8");
    assert.deepEqual(
      await rpc.call("eth_getBlockByNumber", ["0x12b", false]),
      header(299),
    );
  }
  assert.deepEqual(
    await rpc.batch("eth_getBlockByNumber", [
      ["0x12b", false],
      ["0x12c", false],
      ["0x12b", false],
    ]),
    [header(299), header(300), header(299)],
  );
  assert.deepEqual(
    await rpc.batch("eth_getBlockByNumber", [["0x12c", false]]),
    [header(300)],
  );
  // Full-transaction blocks, receipts and code are not canonical header reads.
  await rpc.batch("eth_getBlockByNumber", [["0x12c", true]]);
  await rpc.batch("eth_getTransactionReceipt", [["0xabc"]]);
  await rpc.call("eth_getCode", ["0xabc", "0x12c"]);
  assert.deepEqual(provider, [
    "eth_chainId",
    "eth_blockNumber",
    "eth_getBlockByNumber:0x12b",
    "eth_getBlockByNumberx0x12c",
    "eth_getBlockByNumberx0x12c",
    "eth_getTransactionReceiptx0xabc",
    "eth_getCode:0xabc",
  ]);
  const swapTopic = toEventSelector(swapEvent),
    launchTopic = toEventSelector(launchEvent);
  const swap = {
    address: contracts.manager,
    topics: [swapTopic],
  } as unknown as RawLog;
  const launch = {
    address: contracts.strategies[0],
    topics: [launchTopic],
  } as unknown as RawLog;
  const metadata = {
    address: tokenMetadataFactory,
    topics: [tokenMetadataTopic],
  } as unknown as RawLog;
  const queries: unknown[] = [];
  rpc.logs = async (...args) => {
    queries.push(args);
    return [swap, metadata, launch];
  };
  await prepareRecentCycleRpc(rpc, 100, 299);
  assert.deepEqual(queries, [
    [
      [contracts.manager, ...contracts.strategies, tokenMetadataFactory],
      [[swapTopic, launchTopic, tokenMetadataTopic]],
      100,
      299,
    ],
  ]);
  assert.deepEqual(await rpc.logs(contracts.manager, [swapTopic], 100, 299), [
    swap,
  ]);
  assert.deepEqual(
    await rpc.logs(
      [...contracts.strategies, tokenMetadataFactory],
      [[launchTopic, tokenMetadataTopic]],
      100,
      299,
    ),
    [metadata, launch],
  );
  assert.equal(queries.length, 1);
  await rpc.logs(contracts.manager, [swapTopic], 101, 299);
  await rpc.logs(contracts.strategies, [launchTopic], 100, 299);
  assert.equal(queries.length, 3);
});
test("combined query rejects inconsistent address and event identity", async () => {
  const rpc = new Rpc();
  rpc.logs = async () =>
    [
      { address: contracts.manager, topics: [toEventSelector(launchEvent)] },
    ] as unknown as RawLog[];
  await assert.rejects(prepareRecentCycleRpc(rpc, 100, 299), /combined source/);
});

import { randomUUID } from "node:crypto";
import { encodeAbiParameters, type Hex } from "viem";
import {
  createClient,
  migrate,
  ensureRecentStreams,
  recentStream,
  commitRecentBatch,
} from "@pools/db";
import { runRecentCycle } from "./recent-worker";
type Counts = Record<string, number>;
test(
  "recent worker handles a catalog above 10000 pools, commits canonical swaps, restarts and rewinds both cursors, reading each canonical header once per cycle",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = `worker_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    t.after(async () => {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    await migrate(db);
    await ensureRecentStreams(db, 10);
    const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`,
      hex = (n: number): Hex => `0x${n.toString(16)}`;
    const token = `0x${"1".repeat(40)}`;
    const p = {
      id: word(99),
      token,
      name: "T",
      symbol: "T",
      launchBlock: 10,
      launchTx: word(100),
      launchSender: token,
      launchedAt: 100,
    };
    const b = {
      from: 10,
      to: 19,
      hash: word(19),
      parentHash: word(9),
      timestamp: 190,
      evidence: {},
    };
    await commitRecentBatch(db, await recentStream(db, "discovery"), {
      ...b,
      pools: [p],
    });
    await commitRecentBatch(db, await recentStream(db, "swaps"), b);
    // Reproduce a real growing-catalog failure through the worker and database,
    // even though this block range only trades one of the registered markets.
    await db.query(`INSERT INTO recent_pools
      (chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch)
      SELECT 4663,'0x'||lpad(to_hex(n),64,'0'),'0x'||repeat('ab',20),
        'Other '||n,'OTHER',10,'0x'||lpad(to_hex(n),64,'0'),
        '0x'||repeat('ab',20),100,19 FROM generate_series(1000,11000) n`);
    let changed = false;
    let wrongChain = false;
    let head = 2000;
    const h = (n: number) => ({
      number: hex(n),
      hash: word(
        n + (wrongChain ? 999999 : changed && n >= 20 ? 10000 : 0),
      ),
      parentHash: word(
        n - 1 + (wrongChain ? 999999 : changed && n > 20 ? 10000 : 0),
      ),
      timestamp: hex(n * 10),
    });
    /** Provider calls by method, counting every member of a batch. */
    function rpc(counts: Counts) {
      const r = new Rpc();
      let logs: RawLog[] = [];
      const count = (m: string, n = 1) => {
        if (n) counts[m] = (counts[m] ?? 0) + n;
      };
      r.call = async <T>(m: string, ps: unknown[]) => {
        count(m);
        return m === "eth_chainId"
          ? (hex(4663) as T)
          : m === "eth_blockNumber"
            ? (hex(head) as T)
            : (h(Number(ps[0])) as T);
      };
      r.logs = async (_a, _t, from, to) => {
        count("eth_getLogs");
        logs =
          from <= 25 && to >= 25
            ? [
                {
                  address: contracts.manager,
                  topics: [toEventSelector(swapEvent), p.id, word(4)],
                  data: encodeAbiParameters(
                    [
                      { type: "int128" },
                      { type: "int128" },
                      { type: "uint160" },
                      { type: "uint128" },
                      { type: "int24" },
                      { type: "uint24" },
                    ],
                    [-10n, 200n, 1n << 96n, 1n, 0, 2500],
                  ),
                  blockNumber: hex(25),
                  blockHash: h(25).hash,
                  transactionHash: word(changed ? 501 : 500),
                  logIndex: "0x0",
                  removed: false,
                },
              ]
            : [];
        return logs;
      };
      r.batch = async <T>(m: string, ps: unknown[][]) => {
        count(m, ps.length);
        return ps.map((v) =>
          m === "eth_getBlockByNumber"
            ? h(Number(v[0]))
            : {
                transactionHash: v[0],
                blockHash: h(25).hash,
                status: "0x1",
                from: token,
                to: contracts.router,
                logs,
              },
        ) as T[];
      };
      return r;
    }
    const options = { bootstrapBlocks: 100, batchBlocks: 10 };
    // Before the per-cycle chain view this cycle read 14 canonical headers and
    // ran 2 log queries: head, both cursors, from three times, to twice, the
    // catalog's cutoff twice, the event batch and its cutoff recheck.
    const first: Counts = {};
    const r1 = await runRecentCycle(db, rpc(first), options);
    assert.equal(r1.swaps, 1);
    assert.equal(r1.through, 29);
    assert.deepEqual(first, {
      eth_chainId: 1,
      eth_blockNumber: 1,
      eth_getBlockByNumber: 5, // head, the shared cursor, from, to, the swap block
      eth_getLogs: 1,
      eth_getTransactionReceipt: 1,
    });
    const second: Counts = {};
    const next = await runRecentCycle(db, rpc(second), options);
    assert.equal(next.through, 39);
    assert.deepEqual(second, {
      eth_chainId: 1,
      eth_blockNumber: 1,
      eth_getBlockByNumber: 4, // previously 13 with 2 log queries
      eth_getLogs: 1,
    });
    assert.equal(
      Number(
        (await db.query("SELECT count(*) FROM recent_swaps")).rows[0].count,
      ),
      1,
    );
    // A reorg below both cursors: the reconcile walks the saved checkpoints
    // back to the matching ancestor (19), rewinds both lanes and re-collects.
    changed = true;
    const rewound: Counts = {};
    const replaced = await runRecentCycle(db, rpc(rewound), options);
    assert.equal(replaced.through, 29);
    assert.deepEqual(rewound, {
      eth_chainId: 1,
      eth_blockNumber: 1,
      eth_getBlockByNumber: 6, // head, cursor 39, checkpoints 29 and 19, from, the swap block
      eth_getLogs: 1,
      eth_getTransactionReceipt: 1,
    });
    const rows = (await db.query("SELECT tx_hash FROM recent_swaps")).rows;
    assert.deepEqual(rows, [{ tx_hash: word(501) }]);
    assert.equal((await recentStream(db, "discovery")).cursor, 29);
    assert.equal((await recentStream(db, "swaps")).cursor, 29);
    // Caught up at the confirmed tip: only the head and the shared cursor.
    head = 29 + 128;
    const idle: Counts = {};
    const caughtUp = await runRecentCycle(db, rpc(idle), options);
    assert.equal(caughtUp.advanced, 0);
    assert.equal(caughtUp.through, 29);
    assert.deepEqual(idle, {
      eth_chainId: 1,
      eth_blockNumber: 1,
      eth_getBlockByNumber: 2, // previously 3
    });
    // A source that answers for another chain matches none of the saved
    // checkpoints; reconcile must refuse the rewind rather than delete every
    // checkpoint and null both cursors.
    wrongChain = true;
    await assert.rejects(
      runRecentCycle(db, rpc({}), options),
      /No matching recent checkpoint/,
    );
    assert.equal((await recentStream(db, "discovery")).cursor, 29);
    assert.equal((await recentStream(db, "swaps")).cursor, 29);
  },
);

import { smallerRecentBatch } from "./recent-budget";
test("recent work splits only bounded size failures without skipping or retrying corrupt evidence", () => {
  assert.equal(
    smallerRecentBatch(Error("Recent batch exceeds 10000 logs"), 1000),
    500,
  );
  assert.equal(
    smallerRecentBatch(
      Error(
        "Collection budget exceeded after 120 HTTP requests and 240 RPC calls",
      ),
      200,
    ),
    100,
  );
  assert.equal(
    smallerRecentBatch(Error("Recent evidence exceeds budget"), 10),
    10,
  );
  for (const error of [
    "RPC HTTP 429",
    "fetch failed",
    "Inconsistent recent receipt or canonical block",
  ])
    assert.equal(smallerRecentBatch(Error(error), 1000), 1000);
});

import {
  HyperSyncClient,
  HyperSyncPacer,
  decodeAggregateRequest,
  encodeAggregateReply,
  instantDeployments,
} from "@pools/chain";
import { FakeHyperSync, fakeLaunch, fakeSwap } from "@pools/chain/testing";
import { runRecentHyperSyncCycle } from "./recent-worker";
test(
  "HyperSync source: a 10,000-block gap fills in paced 2,000-block batches, the tip pays no receipt, header or log call to JSON-RPC, launches register before their swaps, and a reorg inside the saved window rewinds both lanes and replays",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = `worker_hs_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    t.after(async () => {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    await migrate(db);
    const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
    const base = instantDeployments[0].deployedAtBlock + 1000;
    const initiator = `0x${"2".repeat(40)}`,
      creator = `0x${"3".repeat(40)}`;
    const first = fakeLaunch({
      block: base + 5,
      token: `0x${"1".repeat(40)}`,
      sender: creator,
      transactionHash: word(9001),
    });
    const swap = (block: number, logIndex: number, poolId: string) =>
      fakeSwap({ block, logIndex, poolId, from: initiator });
    // The confirmed tip starts 10,000 blocks after the stream's start.
    const fake = new FakeHyperSync({
      height: base + 9999 + 128,
      logs: [
        ...first.logs,
        swap(base + 6, 0, first.poolId),
        swap(base + 6, 1, word(7)), // not a Pools market
        swap(base + 4100, 0, first.poolId),
        swap(base + 9999, 0, first.poolId),
      ],
    });
    // Each request's scheduled start (the shared pacer has already moved one
    // interval past it when the request leaves) and its actual send time,
    // across every cycle, to prove the spacing spans cycles.
    const minIntervalMs = 20;
    const pacer = new HyperSyncPacer();
    const sent: { scheduled: number; at: number }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      sent.push({
        scheduled: pacer.nextRequestAt - minIntervalMs,
        at: Date.now(),
      });
      return fake.fetch(input, init);
    };
    /** JSON-RPC calls by method; only a launch's name and symbol are served. */
    function rpc(counts: Counts) {
      const r = new Rpc();
      const count = (m: string, n = 1) => (counts[m] = (counts[m] ?? 0) + n);
      r.call = async <T>(m: string) => {
        count(m);
        if (m === "eth_chainId") return hex(4663) as T;
        throw Error(`Unexpected JSON-RPC ${m}`);
      };
      r.logs = async () => {
        count("eth_getLogs");
        throw Error("Unexpected JSON-RPC eth_getLogs");
      };
      r.batch = async <T>(m: string, ps: unknown[][]) => {
        count(m, ps.length);
        if (m !== "eth_call") throw Error(`Unexpected JSON-RPC ${m}`);
        return ps.map((p) =>
          encodeAggregateReply(
            decodeAggregateRequest((p[0] as { data: Hex }).data).map(
              (member, i) => ({
                success: true,
                returnData: encodeAbiParameters(
                  [{ type: "string" }],
                  [i % 2 ? "SYM" : "Name"],
                ),
              }),
            ),
          ),
        ) as T[];
      };
      return r;
    }
    const hex = (n: number): Hex => `0x${n.toString(16)}`;
    async function cycle() {
      const counts: Counts = {};
      const client = new HyperSyncClient({
        token: "x".repeat(16),
        fetch,
        pacer,
        minIntervalMs,
        maxRequests: 300,
      });
      const result = await runRecentHyperSyncCycle(db, client, rpc(counts), {
        bootstrapBlocks: 10000,
        batchBlocks: 2000,
        maxPages: 4,
      });
      return { result, counts, requests: client.requests };
    }
    const receiptOrHeader = (counts: Counts) =>
      (counts.eth_getTransactionReceipt ?? 0) +
      (counts.eth_getBlockReceipts ?? 0) +
      (counts.eth_getBlockByNumber ?? 0) +
      (counts.eth_getLogs ?? 0) +
      (counts.eth_blockNumber ?? 0);

    // Gap fill: five full batches, one page each, back to back.
    const fill = [];
    do fill.push(await cycle());
    while (fill.at(-1)!.result.through !== base + 9999);
    assert.deepEqual(
      fill.map((c) => [c.result.through, c.result.advanced, c.result.pages]),
      [
        [base + 1999, 2000, 1],
        [base + 3999, 2000, 1],
        [base + 5999, 2000, 1],
        [base + 7999, 2000, 1],
        [base + 9999, 2000, 1],
      ],
    );
    // Height, head header, one page; then also the shared cursor's header.
    assert.deepEqual(
      fill.map((c) => c.requests),
      [3, 4, 4, 4, 4],
    );
    for (const c of fill) assert.equal(receiptOrHeader(c.counts), 0);
    // The launch batch reads name and symbol in one aggregate; no other cycle
    // reaches the JSON-RPC provider at all.
    assert.deepEqual(fill[0].counts, { eth_chainId: 1, eth_call: 1 });
    for (const c of fill.slice(1)) assert.deepEqual(c.counts, {});
    for (const [i, request] of sent.entries()) {
      assert.ok(request.at >= request.scheduled - 1, `request ${i} left early`);
      if (i)
        assert.ok(
          request.scheduled - sent[i - 1].scheduled >= minIntervalMs,
          `request ${i} was scheduled too soon after the previous one`,
        );
    }
    assert.equal(fill[0].result.pools, 1);
    assert.deepEqual(
      (
        await db.query(
          "SELECT stream_key,count(*)::int AS batches,min(source) AS source,max(source) AS last FROM recent_batches GROUP BY stream_key ORDER BY stream_key",
        )
      ).rows,
      [
        {
          stream_key: "discovery",
          batches: 5,
          source: "recent:hypersync:v1",
          last: "recent:hypersync:v1",
        },
        {
          stream_key: "swaps",
          batches: 5,
          source: "recent:hypersync:v1",
          last: "recent:hypersync:v1",
        },
      ],
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT block_number::int AS block,transaction_sender,side,eth_wei FROM recent_swaps ORDER BY block_number",
        )
      ).rows,
      [base + 6, base + 4100, base + 9999].map((block) => ({
        block,
        transaction_sender: initiator,
        side: "buy",
        eth_wei: "10",
      })),
    );
    const firstSwaps = (
      await db.query(
        "SELECT observed_swaps,unregistered_swaps FROM recent_batches WHERE stream_key='swaps' ORDER BY to_block LIMIT 1",
      )
    ).rows[0];
    assert.deepEqual(firstSwaps, { observed_swaps: 2, unregistered_swaps: 1 });

    // At the confirmed tip: height, head header and the cursor, nothing else.
    const idle = await cycle();
    assert.equal(idle.result.advanced, 0);
    assert.equal(idle.requests, 3);
    assert.deepEqual(idle.counts, {});

    // The tip moves 300 blocks with a new launch and a swap in its pool in the
    // same range: the launch commits first, so the swap is registered.
    const second = fakeLaunch({
      block: base + 10100,
      token: `0x${"4".repeat(40)}`,
      sender: creator,
      transactionHash: word(9002),
    });
    fake.logs.push(
      ...second.logs,
      swap(base + 10150, 0, second.poolId),
      swap(base + 10200, 0, first.poolId),
    );
    fake.height += 300;
    const tip = await cycle();
    assert.equal(tip.result.through, base + 10299);
    assert.equal(tip.result.swaps, 2);
    assert.equal(tip.result.pools, 1);
    assert.deepEqual(tip.counts, { eth_chainId: 1, eth_call: 1 });
    assert.equal(tip.requests, 4);
    const quiet = await (async () => {
      fake.height += 300;
      return cycle();
    })();
    assert.equal(quiet.result.through, base + 10599);
    assert.deepEqual(quiet.counts, {});

    // History ahead of the fork: a swap at base + 10700 commits normally.
    const old = fake.logs.push(swap(base + 10700, 0, second.poolId)) - 1;
    fake.height += 300;
    await cycle();
    assert.equal((await recentStream(db, "swaps")).cursor, base + 10899);
    // A reorg from base + 10650 replaces that transaction. The saved cursor
    // (base + 10899) no longer matches, the newest matching checkpoint is
    // base + 10599, both lanes rewind to it and the same cycle recollects.
    fake.reorgFrom = base + 10650;
    fake.logs[old] = { ...fake.logs[old], transactionHash: word(424242) };
    const rewound = await cycle();
    assert.equal(rewound.result.through, base + 10899);
    assert.equal((await recentStream(db, "discovery")).cursor, base + 10899);
    // Height, head, the cursor (also the newest checkpoint), checkpoint
    // base + 10599, then one page.
    assert.equal(rewound.requests, 5);
    assert.deepEqual(rewound.counts, {});
    const rows = (
      await db.query(
        "SELECT block_number::int AS block,tx_hash,block_hash FROM recent_swaps WHERE block_number>=$1 ORDER BY block_number",
        [base + 10600],
      )
    ).rows;
    assert.deepEqual(rows, [
      {
        block: base + 10700,
        tx_hash: word(424242),
        block_hash: fake.hashOf(base + 10700),
      },
    ]);
    assert.notEqual(fake.hashOf(base + 10700), word(base + 10700));
    assert.equal(
      (await recentStream(db, "swaps")).hash,
      fake.hashOf(base + 10899),
    );
  },
);
