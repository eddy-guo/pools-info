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
    let head = 2000;
    const h = (n: number) => ({
      number: hex(n),
      hash: word(n + (changed && n >= 20 ? 10000 : 0)),
      parentHash: word(n - 1 + (changed && n > 20 ? 10000 : 0)),
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
