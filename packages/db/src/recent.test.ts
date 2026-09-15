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
