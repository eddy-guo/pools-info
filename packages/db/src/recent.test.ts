import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createClient,
  migrate,
  ensureRecentStreams,
  recentStream,
  recentResumeBatchBlocks,
  commitRecentBatch,
  rewindRecent,
  knownRecentPools,
  type RecentBatch,
} from "./index";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "TEST_DATABASE_URL required; production DATABASE_URL is never used",
  );
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`,
  token = `0x${"a1".repeat(20)}`;
const pool = {
  id: hash(100),
  token,
  name: "Test",
  symbol: "T",
  launchBlock: 10,
  launchTx: hash(101),
  launchSender: token,
  launchedAt: 100,
};
const batch = (from = 10, to = 19): RecentBatch => ({
  from,
  to,
  hash: hash(to),
  parentHash: hash(from - 1),
  timestamp: to * 10,
  evidence: { headers: [] },
});
test("recent restart sizing uses only the matching saved swap checkpoint", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = `recent_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  assert.equal(await recentResumeBatchBlocks(db, 1000), 1000);
  await ensureRecentStreams(db, 10);
  await commitRecentBatch(
    db,
    await recentStream(db, "discovery"),
    batch(10, 259),
  );
  assert.equal(await recentResumeBatchBlocks(db, 1000), 1000);
  await commitRecentBatch(db, await recentStream(db, "swaps"), batch(10, 259));
  assert.equal(await recentResumeBatchBlocks(db, 1000), 250);
  assert.equal(await recentResumeBatchBlocks(db, 100), 100);
  assert.equal(await recentResumeBatchBlocks(db, 5), 5);
  await db.query(
    "UPDATE recent_streams SET cursor_hash=$1 WHERE stream_key='swaps'",
    [hash(999)],
  );
  assert.equal(await recentResumeBatchBlocks(db, 1000), 1000);
  await db.query(
    "UPDATE recent_streams SET cursor_hash=$1 WHERE stream_key='swaps'",
    [hash(259)],
  );
  await rewindRecent(db, await recentStream(db, "swaps"), null);
  assert.equal(await recentResumeBatchBlocks(db, 1000), 1000);
  await commitRecentBatch(db, await recentStream(db, "swaps"), batch(10, 10));
  assert.equal(await recentResumeBatchBlocks(db, 1000), 10);
});
test("recent streams preserve restart start, contiguous discovery bounds, exact replay and atomic reorg cascades", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = `recent_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  await ensureRecentStreams(db, 10);
  await ensureRecentStreams(db, 999);
  assert.equal((await recentStream(db, "discovery")).start, 10);
  const discovery = await recentStream(db, "discovery"),
    swaps = await recentStream(db, "swaps");
  await assert.rejects(
    commitRecentBatch(db, swaps, batch()),
    /discovery coverage/,
  );
  const first = {
    ...batch(),
    pools: [
      {
        ...pool,
        imageUrl: "https://example.com/token.png",
        description: "Verified recent metadata",
        externalUrl: "https://example.com/token",
        token: pool.token.toUpperCase().replace("0X", "0x"),
        launchSender: pool.launchSender.toUpperCase().replace("0X", "0x"),
      },
    ],
  };
  assert.equal(await commitRecentBatch(db, discovery, first), true);
  assert.equal(await commitRecentBatch(db, discovery, first), false);
  const savedMetadata = {
    image_url: first.pools[0].imageUrl,
    description: first.pools[0].description,
    external_url: first.pools[0].externalUrl,
    source_batch: "19",
  };
  assert.deepEqual(
    (
      await db.query(
        "SELECT image_url,description,external_url,source_batch FROM recent_pools",
      )
    ).rows,
    [savedMetadata],
  );
  await ensureRecentStreams(db, 999);
  assert.equal(
    (await knownRecentPools(db))[0].imageUrl,
    first.pools[0].imageUrl,
  );
  await assert.rejects(
    commitRecentBatch(db, discovery, {
      ...first,
      pools: [
        { ...first.pools[0], imageUrl: "https://example.com/changed.png" },
      ],
    }),
    /Conflicting recent replay/,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT image_url,description,external_url,source_batch FROM recent_pools",
      )
    ).rows,
    [savedMetadata],
  );
  await assert.rejects(
    commitRecentBatch(db, discovery, { ...first, timestamp: 191 }),
    /Conflicting recent replay/,
  );
  const event = {
    poolId: pool.id,
    token,
    txHash: hash(102),
    logIndex: 0,
    block: 15,
    blockHash: hash(15),
    timestamp: 150,
    transactionSender: token,
    amount0: "-10",
    amount1: "200",
    ethWei: "10",
    tokenRaw: "200",
    side: "buy" as const,
  };
  await assert.rejects(
    commitRecentBatch(db, swaps, {
      ...batch(),
      events: [{ ...event, poolId: hash(900) }],
    }),
    /Unregistered/,
  );
  await commitRecentBatch(db, swaps, { ...batch(), events: [event] });
  await assert.rejects(
    commitRecentBatch(db, await recentStream(db, "swaps"), batch(21, 29)),
    /Noncontiguous/,
  );
  const nextPool = {
    ...pool,
    id: hash(200),
    launchBlock: 25,
    launchTx: hash(201),
    launchedAt: 250,
  };
  await commitRecentBatch(db, await recentStream(db, "discovery"), {
    ...batch(20, 29),
    pools: [nextPool],
  });
  await commitRecentBatch(db, await recentStream(db, "swaps"), {
    ...batch(20, 29),
    events: [
      {
        ...event,
        poolId: nextPool.id,
        block: 26,
        blockHash: hash(26),
        timestamp: 260,
        txHash: hash(202),
      },
    ],
  });
  assert.equal((await knownRecentPools(db)).length, 2);
  await rewindRecent(db, await recentStream(db, "discovery"), 19);
  assert.equal((await recentStream(db, "swaps")).cursor, 19);
  assert.equal((await knownRecentPools(db)).length, 1);
  assert.equal(
    Number((await db.query("SELECT count(*) FROM recent_swaps")).rows[0].count),
    1,
  );
  await rewindRecent(db, await recentStream(db, "discovery"), null);
  assert.equal((await recentStream(db, "swaps")).cursor, null);
  assert.equal((await knownRecentPools(db)).length, 0);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM recent_pools WHERE image_url IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    Number((await db.query("SELECT count(*) FROM recent_swaps")).rows[0].count),
    0,
  );
  const conflict = { ...pool, launchSender: `0x${"2".repeat(40)}` };
  await assert.rejects(
    commitRecentBatch(db, await recentStream(db, "discovery"), {
      ...first,
      pools: [pool, conflict],
    }),
    /Conflicting recent pool identity/,
  );
  assert.equal((await recentStream(db, "discovery")).cursor, null);
  const replacement = {
    ...first,
    hash: hash(919),
    pools: [{ ...first.pools[0], imageUrl: "https://example.com/reorg.png" }],
  };
  await commitRecentBatch(db, await recentStream(db, "discovery"), replacement);
  assert.equal(
    (await knownRecentPools(db))[0].imageUrl,
    replacement.pools[0].imageUrl,
  );
  assert.equal((await recentStream(db, "discovery")).hash, hash(919));
});

import {
  HyperSyncClient,
  Rpc,
  collectRecentPages,
  decodeAggregateRequest,
  encodeAggregateReply,
  instantDeployments,
  observedRecentPoolIds,
  recentLaunchesFromPages,
  recentSwapsFromPages,
} from "@pools/chain";
import {
  FakeHyperSync,
  fakeLaunch,
  fakeSwap,
  word,
} from "@pools/chain/testing";
type Hex = `0x${string}`;
/** A short ABI-encoded string reply, as name() and symbol() return. */
const abiString = (v: string): Hex =>
  `0x${"20".padStart(64, "0")}${v.length.toString(16).padStart(64, "0")}${Buffer.from(v).toString("hex").padEnd(64, "0")}`;
import { recentBatchSources } from "./index";
test("the writer replays HyperSync evidence inside the commit, refuses a forged row, count, label or unregistered claim, and records the source", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = `recent_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const base = instantDeployments[0].deployedAtBlock + 1000;
  const initiator = `0x${"2".repeat(40)}`;
  const launch = fakeLaunch({
    block: base + 2,
    token: `0x${"1".repeat(40)}`,
    sender: `0x${"3".repeat(40)}`,
    transactionHash: word(9001),
  });
  const fake = new FakeHyperSync({
    height: base + 9 + 128,
    logs: [
      ...launch.logs,
      fakeSwap({
        block: base + 4,
        logIndex: 0,
        poolId: launch.poolId,
        from: initiator,
      }),
      fakeSwap({
        block: base + 4,
        logIndex: 1,
        poolId: word(7),
        from: initiator,
      }),
    ],
  });
  const pages = await collectRecentPages(
    new HyperSyncClient({
      token: "x".repeat(16),
      minIntervalMs: 0,
      fetch: fake.fetch,
    }),
    { fromBlock: base, toBlock: base + 9, height: base + 9 + 128 },
  );
  const rpc = new Rpc();
  rpc.call = async <T>() => "0x1237" as T;
  rpc.batch = async <T>(_m: string, ps: unknown[][]) =>
    ps.map((p) =>
      encodeAggregateReply(
        decodeAggregateRequest((p[0] as { data: Hex }).data).map((_, i) => ({
          success: true,
          returnData: abiString(i % 2 ? "S" : "N"),
        })),
      ),
    ) as T[];
  const launches = await recentLaunchesFromPages(pages, rpc);
  const discoveryBatch = (): RecentBatch => ({
    from: base,
    to: base + 9,
    hash: launches.blockHash,
    parentHash: launches.fromBlockParentHash,
    timestamp: launches.toTimestamp,
    pools: structuredClone(launches.pools),
    evidence: structuredClone(launches.evidence),
    source: recentBatchSources.hypersync,
  });
  await ensureRecentStreams(db, base);
  const discovery = await recentStream(db, "discovery");
  for (const [name, forge, error] of [
    [
      "an unlabelled HyperSync batch",
      (b: RecentBatch) => delete b.source,
      /Invalid recent batch/,
    ],
    [
      "a launch sender",
      (b: RecentBatch) => (b.pools![0].launchSender = initiator),
      /disagree/,
    ],
    ["a dropped launch", (b: RecentBatch) => (b.pools = []), /disagree/],
    ["a cutoff time", (b: RecentBatch) => (b.timestamp += 1), /disagree/],
  ] as const) {
    const b = discoveryBatch();
    forge(b);
    await assert.rejects(commitRecentBatch(db, discovery, b), error, name);
  }
  // Receipt-shaped evidence cannot carry the HyperSync label.
  await assert.rejects(
    commitRecentBatch(db, discovery, {
      ...batch(base, base + 9),
      source: recentBatchSources.hypersync,
    }),
    /Invalid recent batch/,
  );
  assert.equal((await recentStream(db, "discovery")).cursor, null);
  assert.equal(await commitRecentBatch(db, discovery, discoveryBatch()), true);
  // An identical replay is a no-op under the same content hash.
  assert.equal(await commitRecentBatch(db, discovery, discoveryBatch()), false);

  // The launch is registered now. A swap batch built as if it were not claims
  // the registered pool as unregistered; the writer resolves it and refuses.
  const forged = recentSwapsFromPages(pages, []);
  assert.ok(forged.evidence.unregistered.poolIds.includes(launch.poolId));
  const swapBatch = (s: typeof forged): RecentBatch => ({
    from: base,
    to: base + 9,
    hash: s.blockHash,
    parentHash: s.fromBlockParentHash,
    timestamp: s.toTimestamp,
    events: structuredClone(s.events),
    evidence: structuredClone(s.evidence),
    observedSwaps: s.observedSwaps,
    unregisteredSwaps: s.unregisteredSwaps,
    unsupportedSwaps: s.unsupportedSwaps,
    source: recentBatchSources.hypersync,
  });
  const swaps = await recentStream(db, "swaps");
  await assert.rejects(
    commitRecentBatch(db, swaps, swapBatch(forged)),
    /Invalid HyperSync unregistered pool ids/,
  );
  const honest = recentSwapsFromPages(
    pages,
    await knownRecentPools(db, observedRecentPoolIds(pages)),
  );
  for (const [name, forge, error] of [
    [
      "a sender",
      (b: RecentBatch) =>
        (b.events![0].transactionSender = `0x${"9".repeat(40)}`),
      /disagree/,
    ],
    [
      "an observed count",
      (b: RecentBatch) => (b.observedSwaps = 1),
      /disagree/,
    ],
    ["a dropped row", (b: RecentBatch) => (b.events = []), /disagree/],
  ] as const) {
    const b = swapBatch(honest);
    forge(b);
    await assert.rejects(commitRecentBatch(db, swaps, b), error, name);
  }
  assert.equal((await recentStream(db, "swaps")).cursor, null);
  assert.equal(await commitRecentBatch(db, swaps, swapBatch(honest)), true);
  assert.deepEqual(
    (
      await db.query(
        "SELECT stream_key,source FROM recent_batches ORDER BY stream_key",
      )
    ).rows,
    [
      { stream_key: "discovery", source: "recent:hypersync:v1" },
      { stream_key: "swaps", source: "recent:hypersync:v1" },
    ],
  );
  assert.deepEqual(
    (await db.query("SELECT transaction_sender FROM recent_swaps")).rows,
    [{ transaction_sender: initiator }],
  );
});
