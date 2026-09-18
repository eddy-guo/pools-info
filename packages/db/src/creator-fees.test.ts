import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commitBatch,
  commitCandidateBatch,
  createClient,
  ensureDiscovery,
  getStream,
  migrate,
  rewind,
  type Batch,
  type PoolRecord,
} from "./index";
import {
  creatorFeeCoverage,
  retainedLaunchLogs,
  saveCreatorFees,
  unresolvedCreatorFeeBatches,
} from "./creator-fees";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated test Postgres instance; DATABASE_URL is never used by these tests",
  );
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const launch = (n: number, extra: Partial<PoolRecord> = {}): PoolRecord => ({
  id: word(100 + n),
  token: address(n),
  name: `Pool ${n}`,
  symbol: `P${n}`,
  launchBlock: 10 + n,
  launchTx: word(200 + n),
  launchSender: address(90),
  launchedAt: 1000 + n,
  ...extra,
});
const stored = async (db: ReturnType<typeof createClient>) =>
  (
    await db.query(
      "SELECT pool_id,creator_fees FROM indexed_pools ORDER BY pool_id",
    )
  ).rows.map((r) => [r.pool_id, r.creator_fees]);

test("Postgres: migration 021 stores the creator-fee flag an observation carries, keeps null for one that does not, and refuses a contradiction", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = "creator_fees_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  // The column is a nullable boolean with no default: unknown is null, and
  // nothing the migration touches invents a value for an existing row.
  const column = (
    await db.query(
      "SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='indexed_pools' AND column_name='creator_fees'",
      [schema],
    )
  ).rows;
  assert.deepEqual(column, [
    { data_type: "boolean", is_nullable: "YES", column_default: null },
  ]);
  await db.query(
    "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'launches:agg:v1','discovery',0,9,$1)",
    [word(9)],
  );
  await db.query(
    "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'launches:agg:v1',0,9,$1,'fixture','{}')",
    [word(9)],
  );
  await db.query(
    "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Before','B',5,$3,$4,500,'launches:agg:v1',9)",
    [word(100), address(100), word(200), address(90)],
  );
  assert.deepEqual(await stored(db), [[word(100), null]]);

  // The writer: a flag is stored as carried, absent stays null, and a
  // non-boolean is refused before anything is written.
  const discovery = await ensureDiscovery(db, 10);
  const first: Batch = {
    from: 10,
    to: 19,
    hash: word(19),
    evidence: {},
    pools: [
      launch(1, { creatorFees: true }),
      launch(2),
      launch(3, { creatorFees: false }),
      launch(4, { creatorFees: null }),
    ],
  };
  await assert.rejects(
    commitBatch(db, discovery, {
      ...first,
      pools: [launch(5, { creatorFees: "yes" as unknown as boolean })],
    }),
    /Invalid launch creator fee flag/,
  );
  assert.equal(await commitBatch(db, discovery, first), true);
  assert.deepEqual(await stored(db), [
    [word(100), null],
    [word(101), true],
    [word(102), null],
    [word(103), false],
    [word(104), null],
  ]);
  // Replay reproduces the batch, flag included.
  assert.equal(await commitBatch(db, discovery, first), false);

  // A second source observing the same launches: a flag fills a null, a
  // matching flag adds nothing, a contradicting one is an identity conflict
  // (the same launch log cannot come from two strategies), and no flag is
  // never read as false.
  const candidate = (pool: PoolRecord, registry = "registry-v2") =>
    commitCandidateBatch(db, registry, {
      from: pool.launchBlock,
      to: pool.launchBlock + 5,
      hash: word(pool.launchBlock + 5),
      evidence: {},
      pools: [pool],
    });
  await candidate(launch(2, { creatorFees: false }));
  await candidate(launch(1, { creatorFees: true }));
  await candidate(launch(3));
  // The flag is part of what a source's batch hashes: the same source
  // replaying its range with a different flag is a conflicting replay.
  await assert.rejects(
    candidate(launch(3, { creatorFees: true })),
    /Conflicting replay/,
  );
  await assert.rejects(
    candidate(launch(3, { creatorFees: true }), "registry-v3"),
    /Conflicting launch identity/,
  );
  assert.deepEqual(await stored(db), [
    [word(100), null],
    [word(101), true],
    [word(102), false],
    [word(103), false],
    [word(104), null],
  ]);
  // The flag belongs to the launch, not to the source that observed it:
  // removing the source that filled pool 2's flag keeps the flag.
  const source = await getStream(db, "candidate:registry-v2:" + word(102));
  await rewind(db, source, null);
  assert.deepEqual(
    (
      await db.query(
        "SELECT creator_fees FROM indexed_pools WHERE pool_id=$1",
        [word(102)],
      )
    ).rows,
    [{ creator_fees: false }],
  );
  await db.query("DELETE FROM indexer_streams WHERE stream_key=$1", [
    source.key,
  ]);
  assert.deepEqual(
    (
      await db.query(
        "SELECT creator_fees FROM indexed_pools WHERE pool_id=$1",
        [word(102)],
      )
    ).rows,
    [{ creator_fees: false }],
  );

  // The backfill's reads and write over the launch stream's retained logs.
  assert.deepEqual(await creatorFeeCoverage(db), {
    pools: 5,
    known: 3,
    unknown: 2,
    unknownUnpublished: 2,
  });
  await db.query(
    "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind,source_stream,source_batch) VALUES(4663,$1,19,$2,2000,$3,'indexed','discovery:v1',19)",
    [
      word(104),
      word(19),
      {
        schemaVersion: 1,
        chainId: 4663,
        toBlock: 19,
        blockHash: word(19),
        toTimestamp: 2000,
        markets: [{ id: word(104) }],
      },
    ],
  );
  assert.deepEqual(await creatorFeeCoverage(db), {
    pools: 5,
    known: 3,
    unknown: 2,
    unknownUnpublished: 1,
  });
  // Only the launch stream's own batches hold retained logs: pool 104 came
  // through discovery:v1 alone and is never selected.
  assert.deepEqual(await unresolvedCreatorFeeBatches(db, "unpublished"), [
    { batchEnd: 9, pools: 1 },
  ]);
  assert.deepEqual(await unresolvedCreatorFeeBatches(db, "all"), [
    { batchEnd: 9, pools: 1 },
  ]);
  await assert.rejects(retainedLaunchLogs(db, 9), /retains no logs/);
  await assert.rejects(retainedLaunchLogs(db, 8), /not found/);
  const log = {
    address: address(0xabc),
    topic0: word(1),
    topic1: word(100),
    transaction_hash: word(200),
    block_number: 5,
    log_index: 0,
    block_hash: word(5),
  };
  await db.query(
    "UPDATE indexer_batches SET evidence=$1 WHERE stream_key='launches:agg:v1' AND to_block=9",
    [{ logs: [log, { ...log, topic1: word(150), block_number: "6" }] }],
  );
  await assert.rejects(
    retainedLaunchLogs(db, 9),
    /Malformed retained launch log/,
  );
  await db.query(
    "UPDATE indexer_batches SET evidence=$1 WHERE stream_key='launches:agg:v1' AND to_block=9",
    [{ logs: [log] }],
  );
  assert.deepEqual(await retainedLaunchLogs(db, 9), [
    {
      address: address(0xabc),
      topic0: word(1),
      topic1: word(100),
      transactionHash: word(200),
      blockNumber: 5,
    },
  ]);
  // A row is written only onto the pool whose recorded launch it names, and
  // never over a flag already stored.
  assert.equal(await saveCreatorFees(db, []), 0);
  await assert.rejects(
    saveCreatorFees(db, [
      {
        poolId: word(100),
        launchTx: word(200),
        launchBlock: 5,
        creatorFees: null as unknown as boolean,
      },
    ]),
    /Invalid creator fee rows/,
  );
  assert.equal(
    await saveCreatorFees(db, [
      {
        poolId: word(100),
        launchTx: word(201),
        launchBlock: 5,
        creatorFees: true,
      },
      {
        poolId: word(100),
        launchTx: word(200),
        launchBlock: 6,
        creatorFees: true,
      },
      {
        poolId: word(103),
        launchTx: word(203),
        launchBlock: 13,
        creatorFees: true,
      },
      {
        poolId: word(999),
        launchTx: word(200),
        launchBlock: 5,
        creatorFees: true,
      },
    ]),
    0,
  );
  assert.equal(
    await saveCreatorFees(db, [
      {
        poolId: word(100),
        launchTx: word(200),
        launchBlock: 5,
        creatorFees: true,
      },
    ]),
    1,
  );
  assert.deepEqual(await stored(db), [
    [word(100), true],
    [word(101), true],
    [word(102), false],
    [word(103), false],
    [word(104), null],
  ]);
  assert.deepEqual(await unresolvedCreatorFeeBatches(db, "all"), []);
});
