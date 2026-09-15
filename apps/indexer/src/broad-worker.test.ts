import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import {
  Rpc,
  RpcRateLimitExhausted,
  contracts,
  swapEvent,
  type RawLog,
} from "@pools/chain";
import {
  commitBatch,
  createClient,
  discoveryV2Identity,
  ensureDiscovery,
  ensureDiscoveryV2,
  getStream,
  migrate,
  rewind,
  broadStreamIdentity,
  broadRangeCheckpoint,
  resolveBroadPools,
  type Client,
} from "@pools/db";
import { BroadScheduler, broadV1Enabled, runBroadBatch } from "./broad-worker";
import {
  BroadBatchBudget,
  BroadSingleBlockOverflow,
  broadBatchBlocks,
  BROAD_RPC_TIMEOUT_MS,
  BROAD_RPC_MAX_REQUESTS,
} from "./broad-budget";
import { trackRpcMethods } from "./rpc-telemetry";
import { reconcileStream } from "./checkpoints";
import {
  rpcRateLimitObserver,
  throwIfBroadCapacityOverflow,
  throwIfRateLimitExhausted,
  workerFailureExitCode,
} from "./rpc-operations";

const first = discoveryV2Identity.start;
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: number): Hex => `0x${n.toString(16)}`;
const token: Hex = "0x1111111111111111111111111111111111111111";
const sender: Hex = "0x2222222222222222222222222222222222222222";
const pools = [word(3), word(5)].map((id, i) => ({
  id,
  token,
  name: `Pool ${i}`,
  symbol: `P${i}`,
  launchBlock: first + i,
  launchTx: word(100 + i),
  launchSender: sender,
  launchedAt: (first + i) * 2,
}));
const dbTest = { skip: !process.env.TEST_DATABASE_URL };
async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `broad_worker_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const v1 = await ensureDiscovery(db, first);
  await commitBatch(db, v1, {
    from: first,
    to: first + 2,
    hash: word(first + 2),
    evidence: {},
    pools,
  });
  await ensureDiscoveryV2(db);
  for (const [from, to] of [
    [first, first + 2],
    [first + 3, first + 9],
    [first + 10, first + 19],
  ])
    await commitBatch(db, await getStream(db, "discovery:v2"), {
      from,
      to,
      hash: word(to),
      evidence: {
        registryRevision: discoveryV2Identity.registryRevision,
        registrySourceRevision: discoveryV2Identity.registrySourceRevision,
      },
      pools: from === first ? pools : [],
    });
  for (const p of pools)
    await commitBatch(db, await getStream(db, `pool:${p.id}`), {
      from: p.launchBlock,
      to: first + 2,
      hash: word(first + 2),
      token,
      evidence: { deep: "retained" },
      events: [],
    });
  return db;
}
type Request = { id: number; method: string; params: unknown[] };
function provider(t: TestContext) {
  let reorgFrom: number | null = null;
  let capacityAbove = Infinity;
  let failReceipt = false;
  let beforeReceipt: (() => Promise<void>) | undefined;
  const ranges: number[][] = [];
  const methodCalls: Request[] = [];
  const blockHash = (n: number) =>
    word(n + (reorgFrom !== null && n >= reorgFrom ? 10000000 : 0));
  const header = (n: number) => ({
    number: hex(n),
    hash: blockHash(n),
    parentHash: blockHash(n - 1),
    timestamp: hex(n * 2),
  });
  const log = (pool: Hex, index: number, block: number): RawLog => ({
    address: contracts.manager,
    topics: [toEventSelector(swapEvent), pool, word(4)],
    data: encodeAbiParameters(
      [
        { type: "int128" },
        { type: "int128" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
        { type: "uint24" },
      ],
      [-10n, 200000000000000000001n, (1n << 96n) + 123n, 100n, -2, 2500],
    ),
    blockNumber: hex(block),
    blockHash: blockHash(block),
    transactionHash: word(block + 100),
    logIndex: hex(index),
    removed: false,
  });
  const logs = () => [
    log(pools[0].id, 0, first + 1),
    log(pools[1].id, 1, first + 1),
    log(word(7), 2, first + 1),
    log(pools[0].id, 0, first + 4),
  ];
  const response = async (row: Request) => {
    methodCalls.push(row);
    if (row.method === "eth_chainId") return hex(4663);
    if (row.method === "eth_blockNumber") return hex(first + 19 + 128);
    if (row.method === "eth_getBlockByNumber")
      return header(Number(row.params[0]));
    if (row.method === "eth_getLogs") {
      const filter = row.params[0] as {
        address: string;
        fromBlock: string;
        toBlock: string;
      };
      assert.equal(filter.address, contracts.manager);
      const from = Number(filter.fromBlock),
        to = Number(filter.toBlock);
      ranges.push([from, to]);
      if (to - from + 1 > capacityAbove)
        return Array.from({ length: 10001 }, (_, i) =>
          log(pools[0].id, i, from),
        );
      return logs().filter(
        (l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to,
      );
    }
    if (row.method === "eth_getTransactionReceipt") {
      if (beforeReceipt) {
        const hook = beforeReceipt;
        beforeReceipt = undefined;
        await hook();
      }
      const own = logs().filter((l) => l.transactionHash === row.params[0]);
      return {
        transactionHash: row.params[0],
        blockHash: own[0].blockHash,
        status: "0x1",
        from: sender,
        to: contracts.router,
        logs: failReceipt ? own.filter((l) => Number(l.logIndex) !== 1) : own,
      };
    }
    assert.fail(`Unexpected method ${row.method}`);
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Request | Request[];
      const reply = async (row: Request) => ({
        jsonrpc: "2.0",
        id: row.id,
        result: await response(row),
      });
      return Response.json(
        Array.isArray(body)
          ? await Promise.all(body.map(reply))
          : await reply(body),
      );
    },
  );
  const createRpc = () =>
    trackRpcMethods(
      new Rpc("http://127.0.0.1:1/mock-only", {
        logRangeBlocks: 1000,
        maxBatchSize: 10,
        minIntervalMs: 0,
        maxRequests: BROAD_RPC_MAX_REQUESTS,
        timeoutMs: BROAD_RPC_TIMEOUT_MS,
      }),
    );
  return {
    createRpc,
    ranges,
    methodCalls,
    header,
    reorg: (from: number) => {
      reorgFrom = from;
    },
    capacity: (above: number) => {
      capacityAbove = above;
    },
    badReceipt: (bad: boolean) => {
      failReceipt = bad;
    },
    beforeReceipt: (hook: () => Promise<void>) => {
      beforeReceipt = hook;
    },
  };
}
async function independent(db: Client) {
  return (
    await db.query(
      "SELECT * FROM indexer_streams WHERE kind<>'broad' ORDER BY stream_key",
    )
  ).rows;
}
async function counts(db: Client) {
  return (
    await db.query(
      "SELECT (SELECT count(*)::int FROM broad_batches) AS batches,(SELECT count(*)::int FROM broad_swaps) AS swaps,(SELECT count(*)::int FROM indexer_batches WHERE stream_key='swaps:broad:v1') AS manifests",
    )
  ).rows[0];
}

test("broad defaults off and validates explicit activation/range limits", async (t) => {
  const previous = process.env.INDEXER_BROAD_V1_ENABLED;
  delete process.env.INDEXER_BROAD_V1_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.INDEXER_BROAD_V1_ENABLED;
    else process.env.INDEXER_BROAD_V1_ENABLED = previous;
  });
  assert.equal(broadV1Enabled(undefined), false);
  assert.equal(broadV1Enabled("0"), false);
  assert.equal(broadV1Enabled("1"), true);
  for (const value of ["", "true", "2", " 1 "])
    assert.throws(() => broadV1Enabled(value), /Invalid/);
  assert.equal(broadBatchBlocks(undefined), 1000);
  assert.equal(broadBatchBlocks("1"), 1);
  for (const value of ["", "0", "1001", "1.5", "NaN"])
    assert.throws(() => broadBatchBlocks(value), /Invalid/);
  const disabled = new BroadScheduler("0", "invalid");
  const db = {
    query: () => assert.fail("disabled database access"),
  } as unknown as Client;
  assert.equal(
    await disabled.run(db, () => assert.fail("disabled RPC construction")),
    null,
  );
});

test(
  "default-off worker leaves real Postgres without broad state",
  dbTest,
  async (t) => {
    const db = await database(t);
    const saved = await independent(db);
    const previous = process.env.INDEXER_BROAD_V1_ENABLED;
    delete process.env.INDEXER_BROAD_V1_ENABLED;
    t.after(() => {
      if (previous === undefined) delete process.env.INDEXER_BROAD_V1_ENABLED;
      else process.env.INDEXER_BROAD_V1_ENABLED = previous;
    });
    assert.equal(
      await new BroadScheduler().run(db, () =>
        assert.fail("disabled RPC construction"),
      ),
      null,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM indexer_streams WHERE kind='broad'",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await counts(db), { batches: 0, swaps: 0, manifests: 0 });
    assert.deepEqual(await independent(db), saved);
  },
);

test(
  "worker persists the complete range, selects nearest checkpoint, resumes and commits empty ranges",
  dbTest,
  async (t) => {
    const db = await database(t),
      p = provider(t),
      saved = await independent(db);
    const scheduler = new BroadScheduler("1", "3");
    const initial = await scheduler.run(db, p.createRpc);
    assert.ok(initial);
    assert.equal(initial.advanced, 3);
    assert.equal(initial.discoveryThroughBlock, first + 2);
    assert.equal(initial.observedSwaps, 3);
    assert.equal(initial.registeredSwaps, 2);
    assert.equal(initial.unsupportedSwaps, 0);
    assert.equal(initial.lagBlocks, 17);
    assert.equal(initial.capacitySplits, 0);
    assert.equal(initial.methodCountsBeforeRetries!.eth_getLogs, 1);
    assert.equal(
      initial.methodCountsBeforeRetries!.eth_getTransactionReceipt,
      1,
    );
    assert.equal(
      initial.rpcCalls,
      Object.values(initial.methodCountsBeforeRetries!).reduce(
        (a, b) => a + b,
        0,
      ),
    );
    const resumed = await new BroadScheduler("1", "3").run(db, p.createRpc);
    assert.equal(resumed!.from, first + 3);
    assert.equal(resumed!.to, first + 5);
    assert.equal(resumed!.discoveryThroughBlock, first + 9);
    const empty = await scheduler.run(db, p.createRpc);
    assert.equal(empty!.from, first + 6);
    assert.equal(empty!.to, first + 8);
    assert.equal(empty!.registeredSwaps, 0);
    assert.equal(empty!.advanced, 3);
    assert.deepEqual(await counts(db), { batches: 3, swaps: 3, manifests: 3 });
    assert.deepEqual(p.ranges, [
      [first, first + 2],
      [first + 3, first + 5],
      [first + 6, first + 8],
    ]);
    assert.deepEqual(await independent(db), saved);
  },
);

test(
  "broad reconciles its canonical prefix and resumes only after discovery's orphaned checkpoint is replaced",
  dbTest,
  async (t) => {
    const db = await database(t),
      p = provider(t);
    const scheduler = new BroadScheduler("1", "3");
    await scheduler.run(db, p.createRpc);
    await scheduler.run(db, p.createRpc);
    const saved = (await independent(db)).filter(
      (s) => s.stream_key !== "discovery:v2",
    );
    p.reorg(first + 3);
    await assert.rejects(
      scheduler.run(db, p.createRpc),
      /registry boundary changed/,
    );
    assert.equal(
      (await getStream(db, broadStreamIdentity.key)).cursor,
      first + 2,
    );
    assert.deepEqual(await counts(db), { batches: 1, swaps: 2, manifests: 1 });
    assert.equal((await getStream(db, "discovery:v2")).cursor, first + 19);
    await reconcileStream(
      db,
      await getStream(db, "discovery:v2"),
      p.createRpc(),
    );
    for (const [from, to] of [
      [first + 3, first + 9],
      [first + 10, first + 19],
    ])
      await commitBatch(db, await getStream(db, "discovery:v2"), {
        from,
        to,
        hash: p.header(to).hash,
        evidence: {
          registryRevision: discoveryV2Identity.registryRevision,
          registrySourceRevision: discoveryV2Identity.registrySourceRevision,
        },
        pools: [],
      });
    const resumed = await scheduler.run(db, p.createRpc);
    assert.equal(resumed!.from, first + 3);
    assert.equal(resumed!.advanced, 3);
    assert.equal(
      (await getStream(db, broadStreamIdentity.key)).hash,
      p.header(first + 5).hash,
    );
    assert.deepEqual(
      (await independent(db)).filter((s) => s.stream_key !== "discovery:v2"),
      saved,
    );
  },
);

test(
  "discovery checkpoint removal during receipt fetch rejects the in-flight group without replacing source evidence",
  dbTest,
  async (t) => {
    const db = await database(t),
      p = provider(t);
    const saved = (await independent(db)).filter(
      (s) => s.stream_key !== "discovery:v2",
    );
    p.beforeReceipt(async () => {
      await rewind(db, await getStream(db, "discovery:v2"), null);
    });
    await assert.rejects(
      new BroadScheduler("1", "3").run(db, p.createRpc),
      /coverage or identity changed/,
    );
    assert.deepEqual(await counts(db), { batches: 0, swaps: 0, manifests: 0 });
    assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
    assert.equal((await getStream(db, "discovery:v2")).cursor, null);
    assert.deepEqual(
      (await independent(db)).filter((s) => s.stream_key !== "discovery:v2"),
      saved,
    );
    const waiting = await new BroadScheduler("1", "3").run(db, p.createRpc);
    assert.equal(waiting!.waitingForDiscovery, true);
    assert.equal(waiting!.advanced, 0);
  },
);

test(
  "worker evidence rejection and second-pool SQL failure remain atomic without capacity retries",
  dbTest,
  async (t) => {
    const db = await database(t),
      p = provider(t),
      saved = await independent(db);
    const scheduler = new BroadScheduler("1", "3");
    p.badReceipt(true);
    await assert.rejects(scheduler.run(db, p.createRpc), /receipt evidence/);
    assert.equal(p.ranges.length, 1);
    assert.deepEqual(await counts(db), { batches: 0, swaps: 0, manifests: 0 });
    p.badReceipt(false);
    await db.query(
      `CREATE FUNCTION fail_second_broad() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pool_id='${pools[1].id}' THEN RAISE EXCEPTION 'second broad member failed'; END IF; RETURN NEW; END; $$`,
    );
    await db.query(
      "CREATE TRIGGER fail_second_broad BEFORE INSERT ON broad_swaps FOR EACH ROW EXECUTE FUNCTION fail_second_broad()",
    );
    await assert.rejects(
      scheduler.run(db, p.createRpc),
      /second broad member failed/,
    );
    assert.equal(p.ranges.length, 2);
    assert.deepEqual(await counts(db), { batches: 0, swaps: 0, manifests: 0 });
    assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
    assert.deepEqual(await independent(db), saved);
  },
);

test(
  "whole-range capacity splitting yields before retrying saved start and reports each attempt's method counts",
  dbTest,
  async (t) => {
    const db = await database(t),
      p = provider(t);
    p.capacity(2);
    const reductions: number[][] = [];
    const scheduler = new BroadScheduler("1", "4");
    const deferred = await scheduler.run(db, p.createRpc, {
      onReduce: (a, b) => reductions.push([a, b]),
    });
    assert.equal(deferred!.deferred, true);
    assert.equal(deferred!.advanced, 0);
    assert.equal(deferred!.from, null);
    assert.equal(deferred!.to, null);
    assert.equal(deferred!.capacitySplits, 1);
    assert.equal(deferred!.methodCountsBeforeRetries!.eth_getLogs, 1);
    assert.deepEqual(await counts(db), { batches: 0, swaps: 0, manifests: 0 });
    const result = await scheduler.run(db, p.createRpc);
    assert.deepEqual(p.ranges, [
      [first, first + 3],
      [first, first + 1],
    ]);
    assert.deepEqual(reductions, [[4, 2]]);
    assert.equal(result!.advanced, 2);
    assert.equal(result!.capacitySplits, 0);
    assert.equal(result!.methodCountsBeforeRetries!.eth_getLogs, 1);
    assert.equal(
      result!.rpcCalls,
      Object.values(result!.methodCountsBeforeRetries!).reduce(
        (a, b) => a + b,
        0,
      ),
    );
    assert.deepEqual(await counts(db), { batches: 1, swaps: 2, manifests: 1 });
    assert.equal(
      (await getStream(db, broadStreamIdentity.key)).cursor,
      first + 1,
    );
  },
);

test(
  "single-block overflow stops once with typed capacity pause and preserves all cursors",
  dbTest,
  async (t) => {
    const db = await database(t),
      p = provider(t),
      saved = await independent(db);
    p.capacity(0);
    let failure: unknown;
    await assert.rejects(
      new BroadScheduler("1", "1").run(db, p.createRpc),
      (e: unknown) => {
        failure = e;
        return e instanceof BroadSingleBlockOverflow && e.block === first;
      },
    );
    assert.equal(p.ranges.length, 1);
    assert.equal(workerFailureExitCode(failure), 76);
    assert.throws(
      () => throwIfBroadCapacityOverflow(failure),
      (e) => e === failure,
    );
    assert.equal(workerFailureExitCode(Error("cleanup failure")), 76);
    assert.deepEqual(await counts(db), { batches: 0, swaps: 0, manifests: 0 });
    assert.deepEqual(await independent(db), saved);
  },
);

test(
  "nearest checkpoint helper clips missing coverage and resolves only v2 sources available by the pin",
  dbTest,
  async (t) => {
    const db = await database(t);
    assert.equal(
      (await broadRangeCheckpoint(db, first, first + 1))!.registry.throughBlock,
      first + 2,
    );
    assert.equal(
      (await broadRangeCheckpoint(db, first + 3, first + 4))!.registry
        .throughBlock,
      first + 9,
    );
    assert.equal(
      (await broadRangeCheckpoint(db, first + 18, first + 25))!.toBlock,
      first + 19,
    );
    assert.equal(await broadRangeCheckpoint(db, first + 20, first + 25), null);
    const pin = (await broadRangeCheckpoint(db, first, first + 1))!.registry;
    assert.deepEqual(
      (
        await resolveBroadPools(db, [pools[0].id, pools[1].id, word(7)], pin)
      ).map((p) => p.poolId),
      pools.map((p) => p.id),
    );
    await rewind(db, await getStream(db, "discovery:v2"), null);
    assert.deepEqual(await resolveBroadPools(db, [pools[0].id], pin), []);
    assert.equal(await broadRangeCheckpoint(db, first, first + 1), null);
  },
);

test("budget recovers sparse capacity and never splits typed throttle or stale checkpoint failures", async () => {
  const budget = new BroadBatchBudget(4);
  const sizes: number[] = [];
  let firstAttempt = true;
  for (let i = 0; i < 7; i++)
    await budget.run(async (size) => {
      sizes.push(size);
      if (firstAttempt) {
        firstAttempt = false;
        throw Error("Broad event group exceeds capacity; split the range");
      }
      return { advanced: size, rpcCalls: 10 };
    });
  assert.deepEqual(sizes, [4, 2, 2, 2, 2, 2, 4]);
  for (const error of [
    new RpcRateLimitExhausted(),
    Error("Broad discovery checkpoint changed"),
  ]) {
    let attempts = 0;
    await assert.rejects(
      budget.run(async () => {
        attempts++;
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(attempts, 1);
  }
});

test(
  "real transport sustained throttling propagates the original type, exits75 and never retries a fresh client",
  dbTest,
  async (t) => {
    const db = await database(t);
    let requests = 0,
      clients = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return Response.json(
        { error: { code: 429, message: "private provider text" } },
        { status: 429 },
      );
    });
    const failure = new BroadScheduler("1", "3").run(db, () => {
      clients++;
      return trackRpcMethods(
        new Rpc("http://127.0.0.1:1/mock-only", {
          minIntervalMs: 0,
          onRateLimit: rpcRateLimitObserver("main"),
        }),
      );
    });
    let terminal: unknown;
    await assert.rejects(failure, (e: unknown) => {
      terminal = e;
      return e instanceof RpcRateLimitExhausted;
    });
    assert.equal(requests, 4);
    assert.equal(clients, 1);
    assert.throws(
      () => throwIfRateLimitExhausted(terminal),
      (e) => e === terminal,
    );
    assert.equal(workerFailureExitCode(terminal), 75);
    assert.equal(workerFailureExitCode(Error("database close failed")), 75);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM indexer_streams WHERE kind='broad'",
        )
      ).rows[0].n,
      0,
    );
  },
);
