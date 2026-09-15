import test from "node:test";
import assert from "node:assert/strict";
import { toEventSelector } from "viem";
import {
  Rpc,
  contracts,
  launchEvent,
  swapEvent,
  type RawLog,
} from "@pools/chain";
import { prepareRecentCycleRpc } from "./recent-worker";
test("combined recent query is reused only for exact source/topic/range; canonical headers stay live", async () => {
  const rpc = new Rpc();
  const queries: unknown[] = [];
  let headerCalls = 0;
  const swap = {
    address: contracts.manager,
    topics: [toEventSelector(swapEvent)],
  } as unknown as RawLog;
  const launch = {
    address: contracts.strategies[0],
    topics: [toEventSelector(launchEvent)],
  } as unknown as RawLog;
  rpc.logs = async (...args) => {
    queries.push(args);
    return [swap, launch];
  };
  rpc.call = async <T>() => {
    headerCalls++;
    return `call${headerCalls}` as T;
  };
  await prepareRecentCycleRpc(rpc, 1000, 100, 299);
  assert.equal(queries.length, 1);
  assert.deepEqual(
    await rpc.logs(contracts.manager, [toEventSelector(swapEvent)], 100, 299),
    [swap],
  );
  assert.deepEqual(
    await rpc.logs(
      contracts.strategies,
      [toEventSelector(launchEvent)],
      100,
      299,
    ),
    [launch],
  );
  assert.equal(queries.length, 1);
  assert.equal(await rpc.call("eth_blockNumber", []), "0x3e8");
  assert.equal(await rpc.call("eth_chainId", []), "0x1237");
  await rpc.call("eth_getBlockByNumber", ["0x12b", false]);
  await rpc.call("eth_getBlockByNumber", ["0x12b", false]);
  assert.equal(headerCalls, 2);
  await rpc.logs(contracts.manager, [toEventSelector(swapEvent)], 101, 299);
  assert.equal(queries.length, 2);
});
test("combined query rejects inconsistent address and event identity", async () => {
  const rpc = new Rpc();
  rpc.logs = async () =>
    [
      { address: contracts.manager, topics: [toEventSelector(launchEvent)] },
    ] as unknown as RawLog[];
  await assert.rejects(
    prepareRecentCycleRpc(rpc, 1000, 100, 299),
    /combined source/,
  );
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
test(
  "recent worker commits canonical swaps in actual PostgreSQL, restarts and rewinds both cursors",
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
    let changed = false;
    const h = (n: number) => ({
      number: hex(n),
      hash: word(n + (changed && n >= 20 ? 10000 : 0)),
      parentHash: word(n - 1 + (changed && n > 20 ? 10000 : 0)),
      timestamp: hex(n * 10),
    });
    function rpc() {
      const r = new Rpc();
      let logs: RawLog[] = [];
      r.call = async <T>(m: string, ps: unknown[]) =>
        m === "eth_chainId"
          ? (hex(4663) as T)
          : m === "eth_blockNumber"
            ? (hex(2000) as T)
            : (h(Number(ps[0])) as T);
      r.logs = async (_a, _t, from, to) => {
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
      r.batch = async <T>(m: string, ps: unknown[][]) =>
        ps.map((v) =>
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
      return r;
    }
    const first = await runRecentCycle(db, rpc(), {
      bootstrapBlocks: 100,
      batchBlocks: 10,
    });
    assert.equal(first.swaps, 1);
    assert.equal(first.through, 29);
    const next = await runRecentCycle(db, rpc(), {
      bootstrapBlocks: 100,
      batchBlocks: 10,
    });
    assert.equal(next.through, 39);
    assert.equal(
      Number(
        (await db.query("SELECT count(*) FROM recent_swaps")).rows[0].count,
      ),
      1,
    );
    changed = true;
    const replaced = await runRecentCycle(db, rpc(), {
      bootstrapBlocks: 100,
      batchBlocks: 10,
    });
    assert.equal(replaced.through, 29);
    const rows = (await db.query("SELECT tx_hash FROM recent_swaps")).rows;
    assert.deepEqual(rows, [{ tx_hash: word(501) }]);
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
