import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Hex,
} from "viem";
import {
  Rpc,
  instantDeployments,
  launchEvent,
  tokenMetadataFactory,
  tokenMetadataEvent,
  tokenMetadataTopic,
  type RawLog,
} from "@pools/chain";
import {
  createClient,
  migrate,
  ensureDiscovery,
  ensureDiscoveryV2,
  discoveryV2Identity,
  getStream,
  commitBatch,
  rewind,
} from "@pools/db";
import {
  discoveryBatchBlocks,
  discoveryV2Enabled,
  DiscoveryBatchBudget,
  DiscoveryScheduler,
  runDiscoveryBatch,
} from "./discovery-worker";

const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: number): Hex => `0x${n.toString(16)}`;
const address = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const start = discoveryV2Identity.start;
const launchBlock = start + 5;
const token = address(10);
const creator = address(11);
const imageUrl = "https://example.com/token.png";
const description = "An early verified launch";
const externalUrl = "https://example.com/token";
const deployment = instantDeployments[0];
const zero = address(0);
const data = encodeAbiParameters(
  [
    { type: "address" },
    { type: "address" },
    { type: "uint24" },
    { type: "int24" },
    { type: "address" },
  ],
  [zero, token, deployment.fee, deployment.tickSpacing, zero],
);
const pool = {
  id: keccak256(data),
  token,
  name: "Early pool",
  symbol: "EARLY",
  launchBlock,
  launchTx: word(70),
  launchSender: creator,
  launchedAt: launchBlock * 10,
};

function fixture(
  options: {
    reorgFrom?: number;
    wrongChain?: boolean;
    missingReceipt?: boolean;
    capacityAbove?: number;
    changedFirst?: boolean;
  } = {},
) {
  const rpc = new Rpc();
  const ranges: number[][] = [];
  const calls = new Map<number, number>();
  const header = (n: number) => ({
    number: hex(n),
    hash: word(n + (n >= (options.reorgFrom ?? Infinity) ? 100000000 : 0)),
    parentHash: word(
      n - 1 + (n - 1 >= (options.reorgFrom ?? Infinity) ? 100000000 : 0),
    ),
    timestamp: hex(n * 10),
  });
  const log: RawLog = {
    address: deployment.strategy,
    topics: [
      toEventSelector(launchEvent),
      pool.id,
      word(10),
      `0x${deployment.feeSplitter.slice(2).padStart(64, "0")}`,
    ],
    data,
    blockNumber: hex(launchBlock),
    blockHash: header(launchBlock).hash,
    transactionHash: pool.launchTx,
    logIndex: hex(1),
    removed: false,
  };
  const metadata: RawLog = {
    ...log,
    address: tokenMetadataFactory,
    topics: [tokenMetadataTopic],
    logIndex: hex(2),
    data: encodeAbiParameters(tokenMetadataEvent.inputs, [
      token,
      {
        description,
        website: externalUrl,
        image: imageUrl,
        extraData: "0x",
      },
    ]),
  };
  rpc.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId")
      return hex(options.wrongChain ? 1 : 4663) as T;
    if (method === "eth_blockNumber") return hex(start + 100128) as T;
    assert.equal(method, "eth_getBlockByNumber");
    const n = Number(params[0]);
    calls.set(n, (calls.get(n) ?? 0) + 1);
    return (
      options.changedFirst && n === start && calls.get(n)! > 1
        ? { ...header(n), hash: word(999) }
        : header(n)
    ) as T;
  };
  rpc.logs = async (_a, _topics, from, to) => {
    ranges.push([from, to]);
    if (to - from + 1 > (options.capacityAbove ?? Infinity))
      throw Error(
        "Catalog batch exceeds 250 launches; split the scan before publishing",
      );
    return from <= launchBlock && to >= launchBlock ? [log, metadata] : [];
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method === "eth_getBlockByNumber")
      return params.map((p) => header(Number(p[0]))) as T[];
    if (method === "eth_getTransactionReceipt")
      return (
        options.missingReceipt
          ? []
          : params.map((p) => ({
              transactionHash: p[0],
              blockHash: log.blockHash,
              status: "0x1",
              from: creator,
              logs: [
                log,
                metadata,
                { ...log, address: deployment.launcher, logIndex: hex(0) },
              ],
            }))
      ) as T[];
    assert.equal(method, "eth_call");
    return params.map((_, i) =>
      encodeAbiParameters(
        [{ type: "string" }],
        [i % 2 === 0 ? pool.name : pool.symbol],
      ),
    ) as T[];
  };
  return { rpc, ranges, header };
}

async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `discovery_worker_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  return db;
}

test("discovery range config defaults to 10000 and rejects invalid bounds", () => {
  assert.equal(discoveryBatchBlocks(undefined), 10000);
  assert.equal(discoveryBatchBlocks("1"), 1);
  for (const value of ["", "0", "10001", "1.5", "NaN", " "])
    assert.throws(
      () => discoveryBatchBlocks(value),
      /Invalid INDEXER_DISCOVERY_BATCH_BLOCKS/,
    );
});

test("discovery activation accepts only explicit 0 or 1 and defaults off", () => {
  const previous = process.env.INDEXER_DISCOVERY_V2_ENABLED;
  try {
    delete process.env.INDEXER_DISCOVERY_V2_ENABLED;
    assert.equal(discoveryV2Enabled(), false);
    assert.equal(discoveryV2Enabled(undefined), false);
    process.env.INDEXER_DISCOVERY_V2_ENABLED = "1";
    assert.equal(discoveryV2Enabled(), true);
    assert.equal(discoveryV2Enabled(undefined), true);
    assert.equal(discoveryV2Enabled("0"), false);
    process.env.INDEXER_DISCOVERY_V2_ENABLED = "0";
    assert.equal(discoveryV2Enabled(), false);
    assert.equal(discoveryV2Enabled("1"), true);
    for (const value of ["", "true", "false", "01", " 1", "1 ", "2", " "])
      assert.throws(() => discoveryV2Enabled(value), /expected 0 or 1/);
  } finally {
    if (previous === undefined) delete process.env.INDEXER_DISCOVERY_V2_ENABLED;
    else process.env.INDEXER_DISCOVERY_V2_ENABLED = previous;
  }
});

test("discovery budget shrinks proven capacity failures, recovers and preserves unrelated failures", async () => {
  const budget = new DiscoveryBatchBudget(10000);
  const sizes: number[] = [];
  let dense = true;
  const attempt = async (blocks: number) => {
    sizes.push(blocks);
    if (dense && blocks > 2500)
      throw Error(
        "Collection budget exceeded after 100 HTTP requests and 299 RPC calls",
      );
    return { advanced: blocks, rpcCalls: 20 };
  };
  await budget.run(attempt);
  assert.deepEqual(sizes, [10000, 5000, 2500]);
  dense = false;
  for (let i = 0; i < 5; i++) await budget.run(attempt);
  assert.equal(sizes.at(-1), 5000);
  for (const message of [
    "HTTP 429",
    "Unverified catalog launch",
    "Cutoff changed during collection",
  ])
    await assert.rejects(
      budget.run(async () => {
        throw Error(message);
      }),
      new RegExp(message),
    );
  let attempts = 0;
  await assert.rejects(
    new DiscoveryBatchBudget(1).run(async () => {
      attempts++;
      throw Error(
        "Catalog batch exceeds 250 launches; split the scan before publishing",
      );
    }),
    /250 launches/,
  );
  assert.equal(attempts, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    budget.run(attempt, { signal: controller.signal }),
    /abort/i,
  );
});

test(
  "v2 persists full-history cursor and registry separately from the original v1",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = await database(t);
    const v1 = await ensureDiscovery(db, 62625935);
    await commitBatch(db, v1, {
      from: v1.start,
      to: v1.start + 99,
      hash: word(v1.start + 99),
      evidence: {},
      pools: [],
    });
    const v1Before = await db.query(
      "SELECT * FROM indexer_streams WHERE stream_key='discovery:v1'",
    );
    const disabled = new DiscoveryScheduler("0");
    const noRpc = () => {
      throw Error("Disabled discovery must not construct an RPC client");
    };
    assert.equal(await disabled.run(db, noRpc), null);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM indexer_streams WHERE stream_key='discovery:v2'",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT * FROM indexer_streams WHERE stream_key='discovery:v1'",
        )
      ).rows,
      v1Before.rows,
    );
    const initial = await ensureDiscoveryV2(db);
    assert.equal(initial.start, 22754669);
    assert.equal(initial.cursor, null);
    assert.deepEqual(
      (
        await db.query(
          "SELECT registry_revision,registry_source_revision FROM indexer_streams WHERE stream_key='discovery:v2'",
        )
      ).rows,
      [
        {
          registry_revision: discoveryV2Identity.registryRevision,
          registry_source_revision: discoveryV2Identity.registrySourceRevision,
        },
      ],
    );
    const f = fixture();
    const firstBatch = await new DiscoveryScheduler("1", "10000").run(
      db,
      () => f.rpc,
    );
    assert.ok(firstBatch);
    assert.equal(firstBatch.advanced, 10000);
    assert.equal(firstBatch.poolsWithImages, 1);
    assert.deepEqual(
      (
        await db.query(
          "SELECT image_url,description,external_url FROM indexed_pools",
        )
      ).rows,
      [{ image_url: imageUrl, description, external_url: externalUrl }],
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT image_url,description,external_url FROM pool_launch_sources",
        )
      ).rows,
      [{ image_url: imageUrl, description, external_url: externalUrl }],
    );
    assert.deepEqual(f.ranges, [[start, start + 9999]]);
    assert.equal((await getStream(db, initial.key)).cursor, start + 9999);
    const v2BeforeDisabled = (
      await db.query(
        "SELECT * FROM indexer_streams WHERE stream_key='discovery:v2'",
      )
    ).rows;
    assert.equal(await disabled.run(db, noRpc), null);
    assert.deepEqual(
      (
        await db.query(
          "SELECT * FROM indexer_streams WHERE stream_key='discovery:v2'",
        )
      ).rows,
      v2BeforeDisabled,
    );
    assert.equal((await ensureDiscoveryV2(db)).cursor, start + 9999);
    const resumed = fixture();
    assert.equal(
      (await runDiscoveryBatch(db, resumed.rpc, 10000)).advanced,
      10000,
    );
    assert.deepEqual(resumed.ranges, [[start + 10000, start + 19999]]);
    assert.deepEqual(
      (
        await db.query(
          "SELECT * FROM indexer_streams WHERE stream_key='discovery:v1'",
        )
      ).rows,
      v1Before.rows,
    );
    const saved = await getStream(db, initial.key);
    for (const [column, changed, original] of [
      [
        "registry_source_revision",
        "changed",
        discoveryV2Identity.registrySourceRevision,
      ],
      ["registry_revision", "changed", discoveryV2Identity.registryRevision],
      ["start_block", start + 1, start],
    ] as const) {
      await db.query(
        `UPDATE indexer_streams SET ${column}=$1 WHERE stream_key='discovery:v2'`,
        [changed],
      );
      await assert.rejects(ensureDiscoveryV2(db), /identity differs/);
      assert.equal((await getStream(db, initial.key)).cursor, saved.cursor);
      await db.query(
        `UPDATE indexer_streams SET ${column}=$1 WHERE stream_key='discovery:v2'`,
        [original],
      );
    }
    assert.deepEqual(await getStream(db, initial.key), saved);
  },
);

test(
  "v2 overlap and canonical rewind preserve independently sourced pool history and positions",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = await database(t);
    // A deliberately early v1 fixture exercises overlapping stream ownership.
    const v1 = await ensureDiscovery(db, start);
    await commitBatch(db, v1, {
      from: start,
      to: start + 9,
      hash: word(start + 9),
      evidence: {},
      pools: [pool],
    });
    const key = `pool:${pool.id}`;
    await commitBatch(db, await getStream(db, key), {
      from: launchBlock,
      to: start + 19,
      hash: word(start + 19),
      token,
      evidence: {},
      events: [
        {
          block: launchBlock,
          blockHash: word(launchBlock),
          timestamp: launchBlock * 10,
          txHash: word(90),
          logIndex: 0,
          transactionSender: creator,
          kind: "transfer",
          payload: { value: "1" },
        },
      ],
    });
    await db.query(
      "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind,source_stream,source_batch) VALUES (4663,$1,$2,$3,$4,$5,'indexed',$6,$2)",
      [
        pool.id,
        start + 19,
        word(start + 19),
        (start + 19) * 10,
        JSON.stringify({
          schemaVersion: 1,
          chainId: 4663,
          markets: [{ id: pool.id }],
          toBlock: start + 19,
          blockHash: word(start + 19),
          toTimestamp: (start + 19) * 10,
        }),
        key,
      ],
    );
    await db.query(
      "INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market) VALUES (4663,$1,1,$2,$3,$4,$5,$6,now(),'indexed','{}')",
      [
        pool.id,
        start + 19,
        word(start + 19),
        launchBlock,
        launchBlock * 10,
        (start + 19) * 10,
      ],
    );
    await db.query(
      "INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags,quantity_raw,cost_wei,invested_wei,proceeds_wei,realized_wei,buys,sells) VALUES (4663,$1,$2,true,'{}',10,100,100,0,0,1,0)",
      [pool.id, creator],
    );
    const history = await getStream(db, key);
    const events = (await db.query("SELECT * FROM indexed_events")).rows;
    const positions = (
      await db.query("SELECT * FROM analytics_accounting_positions")
    ).rows;
    await runDiscoveryBatch(db, fixture().rpc, 10);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM pool_launch_sources"))
        .rows[0].n,
      2,
    );
    await runDiscoveryBatch(db, fixture().rpc, 10);
    // Reorg only the second batch: walk back to the first canonical checkpoint.
    const replaced = fixture({ reorgFrom: start + 10 });
    await runDiscoveryBatch(db, replaced.rpc, 10);
    assert.deepEqual(replaced.ranges, [[start + 10, start + 19]]);
    assert.equal(
      (await getStream(db, discoveryV2Identity.key)).hash,
      replaced.header(start + 19).hash,
    );
    // Losing the v2 observation is not grounds to delete v1-backed accounting.
    await rewind(db, await getStream(db, discoveryV2Identity.key), null);
    assert.deepEqual(await getStream(db, key), history);
    assert.equal(
      (
        await db.query("SELECT image_url FROM indexed_pools WHERE pool_id=$1", [
          pool.id,
        ])
      ).rows[0].image_url,
      null,
    );
    assert.deepEqual(
      (await db.query("SELECT * FROM indexed_events")).rows,
      events,
    );
    assert.deepEqual(
      (await db.query("SELECT * FROM analytics_accounting_positions")).rows,
      positions,
    );
    await runDiscoveryBatch(db, fixture().rpc, 10);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM pool_launch_sources"))
        .rows[0].n,
      2,
    );
    assert.deepEqual(await getStream(db, key), history);
    // Final-source cleanup is still effective after both streams rewind.
    await rewind(db, await getStream(db, discoveryV2Identity.key), null);
    await rewind(db, await getStream(db, v1.key), null);
    await assert.rejects(getStream(db, key), /Stream not found/);
  },
);

test(
  "v2 budget retries from the saved start and rejects bad chain evidence without advancing",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = await database(t);
    await ensureDiscoveryV2(db);
    const budget = new DiscoveryBatchBudget(20);
    const attempts: number[][] = [];
    await budget.run(async (size) => {
      const f = fixture({ capacityAbove: 10 });
      try {
        return await runDiscoveryBatch(db, f.rpc, size);
      } finally {
        attempts.push(...f.ranges);
      }
    });
    assert.deepEqual(attempts, [
      [start, start + 19],
      [start, start + 9],
    ]);
    assert.equal(
      (await getStream(db, discoveryV2Identity.key)).cursor,
      start + 9,
    );
    await rewind(db, await getStream(db, discoveryV2Identity.key), null);
    for (const options of [
      { missingReceipt: true },
      { changedFirst: true },
      { wrongChain: true },
    ]) {
      await assert.rejects(
        runDiscoveryBatch(db, fixture(options).rpc, 10),
        /receipt|boundary changed|Wrong chain/i,
      );
      assert.equal((await getStream(db, discoveryV2Identity.key)).cursor, null);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM indexer_batches WHERE stream_key='discovery:v2'",
          )
        ).rows[0].n,
        0,
      );
    }
  },
);
