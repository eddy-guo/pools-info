import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import {
  Rpc,
  contracts,
  swapEvent,
  transferEvent,
  type RawLog,
} from "@pools/chain";
import {
  createClient,
  migrate,
  ensureDiscovery,
  commitBatch,
  nextPoolGroup,
  markAttempt,
  getStream,
} from "@pools/db";
import { alignedPoolEnd, runPoolGroup } from "./pool-group-worker";
import { PoolBatchBudget } from "./pool-budget";

test("alignment shortens only the current batch, preserving every unprocessed block", () => {
  assert.equal(alignedPoolEnd(12, 10, 100), 19);
  assert.equal(alignedPoolEnd(20, 10, 100), 29);
  assert.equal(alignedPoolEnd(20, 10, 25), 25);
  assert.equal(alignedPoolEnd(26, 10, 25), 25);
  assert.equal(alignedPoolEnd(0, 10, 100), 9);
  for (const n of [0, -1, 1.5, 2001])
    assert.throws(() => alignedPoolEnd(10, n, 100));
});

test(
  "worker aligns distinct launches, collects shared events, restarts and replaces reorged groups",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = `group_worker_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    t.after(async () => {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    await migrate(db);
    const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
    const hex = (n: number): Hex => `0x${n.toString(16)}`;
    const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
    const pools = [10, 12].map((launchBlock, i) => ({
      id: word(100 + i),
      token: address(100 + i),
      name: `Pool${i}`,
      symbol: `P${i}`,
      launchBlock,
      launchTx: word(200 + i),
      launchSender: address(9),
      launchedAt: launchBlock * 10,
    }));
    await commitBatch(db, await ensureDiscovery(db, 10), {
      from: 10,
      to: 19,
      hash: word(19),
      evidence: {},
      pools,
    });
    let reorg = false,
      badReceipt = false;
    const header = (n: number) => ({
      number: hex(n),
      hash: word(n + (reorg && n >= 20 ? 10000 : 0)),
      parentHash: word(n - 1 + (reorg && n > 20 ? 10000 : 0)),
      timestamp: hex(n * 10),
    });
    function provider() {
      const rpc = new Rpc();
      const logQueries: unknown[] = [];
      let receiptsFetched = 0;
      const logs: RawLog[] = pools.map((p, i) => ({
        address: contracts.manager,
        topics: [toEventSelector(swapEvent), p.id, word(9)],
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
        blockHash: header(25).hash,
        transactionHash: word(reorg ? 501 : 500),
        logIndex: hex(i),
        removed: false,
      }));
      const transfers: RawLog[] = pools.map((p, i) => ({
        ...logs[i],
        address: p.token,
        topics: [toEventSelector(transferEvent), word(9), word(10)],
        data: encodeAbiParameters([{ type: "uint256" }], [200n]),
        logIndex: hex(i + 2),
      }));
      const allLogs = [...logs, ...transfers];
      rpc.call = async <T>(method: string, params: unknown[]) =>
        (method === "eth_chainId"
          ? hex(4663)
          : method === "eth_blockNumber"
            ? hex(2000)
            : header(Number(params[0]))) as T;
      rpc.logs = async (a, topics, from, to) => {
        logQueries.push({ a, topics, from, to });
        return from <= 25 && to >= 25
          ? a === contracts.manager
            ? logs
            : transfers
          : [];
      };
      rpc.batch = async <T>(method: string, params: unknown[][]) => {
        if (method === "eth_getTransactionReceipt")
          receiptsFetched += params.length;
        return params.map((p) =>
          method === "eth_getBlockByNumber"
            ? header(Number(p[0]))
            : {
                transactionHash: p[0],
                blockHash: header(25).hash,
                status: "0x1",
                from: address(9),
                to: contracts.router,
                logs: badReceipt
                  ? allLogs.filter((l) => l.logIndex !== hex(1))
                  : allLogs,
              },
        ) as T[];
      };
      return { rpc, logQueries, receiptCount: () => receiptsFetched };
    }
    assert.deepEqual(
      await nextPoolGroup(db, 2).then((g) => g.map((p) => p.start)),
      [10],
    );
    for (const start of [10, 12]) {
      const group = await nextPoolGroup(db, 2);
      assert.equal(group.length, 1);
      assert.equal(group[0].start, start);
      await markAttempt(db, group[0].key);
      assert.equal(
        (await runPoolGroup(db, group, provider().rpc, 10)).advanced,
        20 - start,
      );
    }
    let group = await nextPoolGroup(db, 2);
    assert.equal(group.length, 2);
    badReceipt = true;
    await assert.rejects(
      runPoolGroup(db, group, provider().rpc, 10),
      /receipt or canonical/,
    );
    for (const p of group)
      assert.equal((await getStream(db, p.key)).cursor, 19);
    assert.equal(
      (await db.query("SELECT count(*) AS n FROM indexed_events")).rows[0].n,
      "0",
    );
    badReceipt = false;
    const shared = provider();
    const result = await runPoolGroup(db, group, shared.rpc, 10);
    assert.equal(result.advanced, 10);
    assert.equal(shared.logQueries.length, 2);
    assert.equal(shared.receiptCount(), 1);
    assert.deepEqual(
      (
        await db.query(
          "SELECT payload->'decoded'->>'amount1' AS amount FROM indexed_events WHERE kind='swap'",
        )
      ).rows.map((r) => r.amount),
      ["200", "200"],
    );
    group = await nextPoolGroup(db, 2);
    assert.equal(
      (await runPoolGroup(db, group, provider().rpc, 10)).advanced,
      10,
    );
    assert.equal(
      (await db.query("SELECT count(*) AS n FROM indexed_events")).rows[0].n,
      "4",
    );
    reorg = true;
    group = await nextPoolGroup(db, 2);
    const replaced = await runPoolGroup(db, group, provider().rpc, 10);
    assert.equal(replaced.advanced, 10);
    assert.deepEqual(
      (await db.query("SELECT DISTINCT tx_hash FROM indexed_events")).rows,
      [{ tx_hash: word(501) }],
    );
    for (const p of group)
      assert.equal((await getStream(db, p.key)).cursor, 29);
    // A deterministic collection budget must leave both saved cursors intact,
    // then retry the same start with a smaller, fully validated range.
    const budget = new PoolBatchBudget(10);
    const sizes: number[] = [];
    const run = () =>
      budget.run(
        group.map((p) => p.key),
        async (size) => {
          sizes.push(size);
          const current = await nextPoolGroup(db, 2);
          const limited = provider().rpc;
          if (size > 5) {
            limited.logs = async () => {
              throw Error(
                "Collection budget exceeded after 122 HTTP requests and 291 RPC calls",
              );
            };
            try {
              return await runPoolGroup(db, current, limited, size);
            } finally {
              for (const p of current)
                assert.equal((await getStream(db, p.key)).cursor, 29);
            }
          }
          return runPoolGroup(db, current, limited, size);
        },
      );
    assert.equal((await run()).advanced, 5);
    for (const p of group)
      assert.equal((await getStream(db, p.key)).cursor, 34);
    assert.equal((await run()).advanced, 5);
    for (const p of group)
      assert.equal((await getStream(db, p.key)).cursor, 39);
    assert.deepEqual(sizes, [10, 5, 5]);
    assert.equal(
      (await db.query("SELECT count(*) AS n FROM indexed_events")).rows[0].n,
      "4",
    );
  },
);
