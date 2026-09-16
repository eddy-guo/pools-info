import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodeAbiParameters, toEventSelector } from "viem";
import { HyperSyncRequestRejected, contracts, swapEvent } from "@pools/chain";
import { FakeHyperSync, word } from "@pools/chain/testing";
import {
  broadStreamIdentity,
  commitBatch,
  createClient,
  discoveryV2Identity,
  ensureDiscovery,
  ensureDiscoveryV2,
  getStream,
  migrate,
  rewind,
  type Client,
} from "@pools/db";
import {
  assertHyperSyncBackfillAllowed,
  createHyperSyncClient,
  hypersyncBackfillConfig,
  hypersyncSafeError,
  planHyperSyncBackfill,
  runHyperSyncBackfill,
  type HyperSyncBackfillConfig,
} from "./hypersync-backfill";

const first = discoveryV2Identity.start;
const token = "0x1111111111111111111111111111111111111111";
const initiator = "0x2222222222222222222222222222222222222222";
const dbTest = { skip: !process.env.TEST_DATABASE_URL };
const pools = [word(3), word(5)].map((id, i) => ({
  id,
  token,
  name: `Pool ${i}`,
  symbol: `P${i}`,
  launchBlock: first + i,
  launchTx: word(100 + i),
  launchSender: initiator,
  launchedAt: (first + i) * 2,
}));
const env = (extra: Record<string, string> = {}) => ({
  HYPERSYNC_BACKFILL_ENABLED: "1",
  ENVIO_API_TOKEN: "x".repeat(16),
  HYPERSYNC_MIN_INTERVAL_MS: "0",
  ...extra,
});
const swapData = encodeAbiParameters(
  [
    { type: "int128" },
    { type: "int128" },
    { type: "uint160" },
    { type: "uint128" },
    { type: "int24" },
    { type: "uint24" },
  ],
  [-10n, 200000000000000000001n, (1n << 96n) + 123n, 100n, -2, 2500],
);
const log = (block: number, index: number, pool = pools[0].id) => ({
  block,
  logIndex: index,
  transactionHash: word(block * 100 + index),
  address: contracts.manager,
  topics: [toEventSelector(swapEvent), pool, word(4)],
  data: swapData,
  from: initiator,
});
async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `hypersync_backfill_${randomUUID().replaceAll("-", "")}`;
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
  return db;
}
function fakeChain(height = first + 19 + 128) {
  return new FakeHyperSync({
    height,
    logs: [
      log(first + 1, 0),
      log(first + 1, 1, pools[1].id),
      log(first + 1, 2, word(7)),
      log(first + 4, 0),
      // Two legs of one transaction.
      { ...log(first + 8, 0), transactionHash: word(88) },
      { ...log(first + 8, 1, pools[1].id), transactionHash: word(88) },
      log(first + 12, 0),
      log(first + 19, 0, pools[1].id),
    ],
  });
}
function setup(fake: FakeHyperSync, extra: Record<string, string> = {}) {
  const config = hypersyncBackfillConfig(env(extra));
  const events: Record<string, unknown>[] = [];
  const client = createHyperSyncClient(config, { fetch: fake.fetch });
  return {
    config,
    client,
    events,
    log: (e: Record<string, unknown>) => events.push(e),
  };
}
async function state(db: Client) {
  const stream = await getStream(db, broadStreamIdentity.key);
  const rows = (
    await db.query(
      "SELECT block_number::int AS block, log_index, pool_id, block_hash FROM broad_swaps ORDER BY block_number, log_index",
    )
  ).rows;
  const batches = (
    await db.query(
      "SELECT from_block::int AS f, to_block::int AS t FROM indexer_batches WHERE stream_key=$1 ORDER BY to_block",
      [broadStreamIdentity.key],
    )
  ).rows.map((r) => [r.f - first, r.t - first]);
  return { cursor: stream.cursor, hash: stream.hash, rows, batches };
}

test("the backfill is off by default and refuses without both the enable flag and the token", () => {
  assert.equal(hypersyncBackfillConfig({}).enabled, false);
  assert.equal(
    hypersyncBackfillConfig({ HYPERSYNC_BACKFILL_ENABLED: "0" }).enabled,
    false,
  );
  assert.throws(
    () => hypersyncBackfillConfig({ HYPERSYNC_BACKFILL_ENABLED: "yes" }),
    /Invalid HYPERSYNC_BACKFILL_ENABLED/,
  );
  assert.throws(
    () => hypersyncBackfillConfig({ HYPERSYNC_BATCH_BLOCKS: "10000" }),
    /Invalid HYPERSYNC_BATCH_BLOCKS/,
  );
  assert.throws(
    () => hypersyncBackfillConfig({ HYPERSYNC_MAX_PAGES: "0" }),
    /Invalid HYPERSYNC_MAX_PAGES/,
  );
  const disabled = hypersyncBackfillConfig({ ENVIO_API_TOKEN: "x".repeat(16) });
  assert.throws(
    () => assertHyperSyncBackfillAllowed(disabled),
    /HyperSync backfill disabled/,
  );
  assert.throws(
    () => createHyperSyncClient(disabled),
    /HyperSync backfill disabled/,
  );
  const missing = hypersyncBackfillConfig({
    HYPERSYNC_BACKFILL_ENABLED: "1",
    ENVIO_API_TOKEN: "  ",
  });
  assert.equal(missing.token, null);
  assert.throws(
    () => assertHyperSyncBackfillAllowed(missing),
    /ENVIO_API_TOKEN is required/,
  );
  const config = hypersyncBackfillConfig(env());
  assert.deepEqual(
    { ...config, token: config.token === "x".repeat(16) },
    {
      enabled: true,
      url: "https://4663.hypersync.xyz",
      token: true,
      batchBlocks: 9999,
      maxBatches: 50,
      maxBlocks: 500000,
      maxPages: 4,
      maxRequests: 2000,
      minIntervalMs: 0,
    },
  );
  assert.equal(
    hypersyncSafeError(
      Error("HyperSync backfill disabled; set HYPERSYNC_BACKFILL_ENABLED=1"),
    ),
    "hypersync_disabled: HyperSync backfill disabled; set HYPERSYNC_BACKFILL_ENABLED=1",
  );
  assert.equal(
    hypersyncSafeError(new HyperSyncRequestRejected(413)),
    "hypersync_request_rejected: HTTP 413",
  );
  assert.equal(
    hypersyncSafeError(Error("HyperSync returned an invalid log row")),
    "hypersync_response_rejected: the provider answer failed validation",
  );
  assert.doesNotMatch(
    hypersyncSafeError(Error(`token ${"x".repeat(16)}`)),
    /x{16}/,
  );
});

test(
  "the backfill commits bounded batches, resumes from its cursor, and stops at the archive and discovery caps",
  dbTest,
  async (t) => {
    const db = await database(t);
    const fake = fakeChain();
    const {
      config,
      client,
      events,
      log: logEvent,
    } = setup(fake, { HYPERSYNC_BATCH_BLOCKS: "5" });
    const options = {
      batchBlocks: config.batchBlocks,
      maxPages: config.maxPages,
      maxBatches: 1,
      maxBlocks: 100,
      log: logEvent,
    };
    const one = await runHyperSyncBackfill(db, client, options);
    assert.equal(one.stopped, "caps");
    assert.equal(one.batches, 1);
    assert.equal(one.blocks, 5);
    assert.equal(one.registeredSwaps, 3);
    assert.equal(one.observedSwaps, 4);
    assert.deepEqual(await state(db), {
      cursor: first + 4,
      hash: word(first + 4),
      rows: [
        {
          block: first + 1,
          log_index: 0,
          pool_id: pools[0].id,
          block_hash: word(first + 1),
        },
        {
          block: first + 1,
          log_index: 1,
          pool_id: pools[1].id,
          block_hash: word(first + 1),
        },
        {
          block: first + 4,
          log_index: 0,
          pool_id: pools[0].id,
          block_hash: word(first + 4),
        },
      ],
      batches: [[0, 4]],
    });
    assert.equal(events.filter((e) => e.event === "hypersync_batch").length, 1);
    // The next run continues from the saved cursor and runs into the archive cap.
    const rest = await runHyperSyncBackfill(db, client, {
      ...options,
      maxBatches: 10,
    });
    assert.equal(rest.stopped, "head");
    assert.equal(rest.batches, 3);
    assert.equal(rest.from, first + 5);
    assert.equal(rest.through, first + 19);
    assert.equal(rest.registeredSwaps, 4);
    const after = await state(db);
    assert.deepEqual(after.batches, [
      [0, 4],
      [5, 9],
      [10, 14],
      [15, 19],
    ]);
    assert.equal(after.rows.length, 7);
    assert.deepEqual(
      after.rows.filter((r) => r.block === first + 8).map((r) => r.log_index),
      [0, 1],
    );
    // Beyond discovery coverage the backfill waits rather than pinning a newer tip.
    fake.height = first + 1000;
    const waiting = await runHyperSyncBackfill(db, client, {
      ...options,
      maxBatches: 10,
    });
    assert.equal(waiting.stopped, "discovery");
    assert.equal(waiting.batches, 0);
    assert.equal((await state(db)).cursor, first + 19);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
      (
        await runHyperSyncBackfill(db, client, {
          ...options,
          signal: aborted.signal,
        })
      ).stopped,
      "aborted",
    );
  },
);

test(
  "a failed batch leaves the cursor untouched and the next run resumes without a gap or a duplicate",
  dbTest,
  async (t) => {
    const db = await database(t);
    let failing = 0;
    const fake = new FakeHyperSync({
      height: first + 19 + 128,
      logs: fakeChain().logs,
      intercept: (r) =>
        r.body && !r.body.include_all_blocks && failing-- > 0
          ? new Response("", { status: 500 })
          : undefined,
    });
    const {
      config,
      client,
      log: logEvent,
    } = setup(fake, { HYPERSYNC_BATCH_BLOCKS: "5" });
    const options = {
      batchBlocks: config.batchBlocks,
      maxPages: config.maxPages,
      maxBatches: 10,
      maxBlocks: 100,
      log: logEvent,
    };
    await runHyperSyncBackfill(db, client, { ...options, maxBatches: 1 });
    failing = 4;
    await assert.rejects(
      runHyperSyncBackfill(db, client, options),
      HyperSyncRequestRejected,
    );
    assert.deepEqual((await state(db)).batches, [[0, 4]]);
    const resumed = await runHyperSyncBackfill(db, client, options);
    assert.equal(resumed.from, first + 5);
    assert.deepEqual((await state(db)).batches, [
      [0, 4],
      [5, 9],
      [10, 14],
      [15, 19],
    ]);
    assert.equal((await state(db)).rows.length, 7);
  },
);

test(
  "a canonical change below the pinned registry rewinds, waits for discovery, then re-collects with the new pin",
  dbTest,
  async (t) => {
    const db = await database(t);
    const fake = fakeChain();
    const {
      config,
      client,
      events,
      log: logEvent,
    } = setup(fake, { HYPERSYNC_BATCH_BLOCKS: "5" });
    const options = {
      batchBlocks: config.batchBlocks,
      maxPages: config.maxPages,
      maxBatches: 10,
      maxBlocks: 100,
      log: logEvent,
    };
    await runHyperSyncBackfill(db, client, options);
    assert.equal((await state(db)).cursor, first + 19);
    // Blocks from first+17 onward are replaced. The saved cursor is no longer
    // canonical, so the stream rewinds to its newest surviving checkpoint; the
    // pinned discovery checkpoint at first+19 changed too, so collection waits.
    fake.reorgFrom = first + 17;
    await assert.rejects(
      runHyperSyncBackfill(db, client, options),
      /Broad registry boundary changed/,
    );
    assert.deepEqual(
      events.filter((e) => e.event === "hypersync_rewind"),
      [
        {
          event: "hypersync_rewind",
          stream: broadStreamIdentity.key,
          from: first + 19,
          to: first + 14,
        },
      ],
    );
    assert.deepEqual((await state(db)).batches, [
      [0, 4],
      [5, 9],
      [10, 14],
    ]);
    // The discovery worker reconciles its own stream; losing the pinned
    // checkpoint cascades every broad batch that depended on it.
    await rewind(db, await getStream(db, "discovery:v2"), first + 9);
    assert.deepEqual((await state(db)).batches, [
      [0, 4],
      [5, 9],
    ]);
    await commitBatch(db, await getStream(db, "discovery:v2"), {
      from: first + 10,
      to: first + 19,
      hash: fake.hashOf(first + 19),
      evidence: {
        registryRevision: discoveryV2Identity.registryRevision,
        registrySourceRevision: discoveryV2Identity.registrySourceRevision,
      },
      pools: [],
    });
    const again = await runHyperSyncBackfill(db, client, options);
    assert.equal(again.from, first + 10);
    assert.equal(again.through, first + 19);
    assert.equal(again.batches, 2);
    const after = await state(db);
    assert.equal(after.hash, fake.hashOf(first + 19));
    assert.notEqual(after.hash, word(first + 19));
    assert.deepEqual(after.batches, [
      [0, 4],
      [5, 9],
      [10, 14],
      [15, 19],
    ]);
    assert.equal(after.rows.length, 7);
    assert.equal(
      after.rows.find((r) => r.block === first + 19)?.block_hash,
      fake.hashOf(first + 19),
    );
    assert.equal(
      after.rows.find((r) => r.block === first + 12)?.block_hash,
      word(first + 12),
    );
  },
);

test(
  "the dry run reads state and one page, reports the shape and writes nothing",
  dbTest,
  async (t) => {
    const db = await database(t);
    const fake = fakeChain();
    const { config, client } = setup(fake, { HYPERSYNC_BATCH_BLOCKS: "5" });
    const plan = await planHyperSyncBackfill(db, client, config);
    assert.deepEqual(plan.stream, {
      key: broadStreamIdentity.key,
      exists: false,
      start: first,
      cursor: null,
      hash: null,
    });
    assert.deepEqual(plan.discovery, {
      key: "discovery:v2",
      cursor: first + 19,
    });
    assert.equal(plan.archiveHeight, first + 19 + 128);
    assert.equal(plan.from, first);
    assert.equal(plan.cap, first + 19);
    assert.equal(plan.remainingBlocks, 20);
    assert.deepEqual(plan.firstPage?.query, {
      from_block: first,
      to_block: first + 5,
    });
    assert.equal(plan.firstPage?.logs, 4);
    assert.equal(plan.firstPage?.blocksCovered, 5);
    assert.deepEqual(plan.firstPage?.logFields, [
      "log_index",
      "transaction_index",
      "transaction_hash",
      "block_hash",
      "block_number",
      "address",
      "data",
      "topic0",
      "topic1",
      "topic2",
      "removed",
    ]);
    assert.equal(plan.estimate?.managerSwaps, 16);
    assert.equal(plan.estimate?.batches, 4);
    assert.equal(client.requests, 2);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM indexer_streams WHERE stream_key=$1",
          [broadStreamIdentity.key],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM broad_batches")).rows[0]
        .n,
      0,
    );
    const config2: HyperSyncBackfillConfig = { ...config, batchBlocks: 9999 };
    const wide = await planHyperSyncBackfill(db, client, config2);
    assert.deepEqual(wide.firstPage?.query, {
      from_block: first,
      to_block: first + 20,
    });
    assert.equal(wide.estimate?.batches, 1);
  },
);
