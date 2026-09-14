import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  acquireWriter,
  commitBatch,
  createClient,
  ensureDiscovery,
  getStream,
  migrate,
  nextPool,
  rewind,
  status,
  type Batch,
} from "./index";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated test Postgres instance; DATABASE_URL is never used by these tests",
  );
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const token = "0x" + "1".repeat(40);
const pool = {
  id: hash(100),
  token,
  name: "Pool",
  symbol: "P",
  launchBlock: 10,
  launchTx: hash(101),
  launchSender: token,
  launchedAt: 100,
};
test("Postgres migrations, checkpoint atomicity, restart and canonical rewind", async (t) => {
  const schema = "test_" + randomUUID().replaceAll("-", "");
  const db = createClient(url);
  await db.connect();
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  await migrate(db);
  assert.equal(
    (await db.query("SELECT count(*) FROM pools_schema_migrations")).rows[0]
      .count,
    "1",
  );
  const s = await ensureDiscovery(db, 10);
  await assert.rejects(ensureDiscovery(db, 11), /differs/);
  const first: Batch = {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: { logs: [] },
    pools: [pool],
  };
  await t.test(
    "replay is idempotent; conflicting replay and gaps fail",
    async () => {
      assert.equal(await commitBatch(db, s, first), true);
      assert.equal(await commitBatch(db, s, first), false);
      await assert.rejects(
        commitBatch(db, s, { ...first, hash: hash(20) }),
        /Conflicting replay/,
      );
      const current = await getStream(db, s.key);
      await assert.rejects(
        commitBatch(db, current, {
          from: 21,
          to: 29,
          hash: hash(29),
          evidence: {},
        }),
        /noncontiguous/,
      );
      assert.equal((await status(db)).counts.pools, "1");
    },
  );
  await t.test("wrong-token pool batches cannot enter the ledger", async () => {
    const p = await nextPool(db);
    assert.ok(p);
    await assert.rejects(
      commitBatch(db, p, {
        from: 10,
        to: 19,
        hash: hash(19),
        token: "0x" + "2".repeat(40),
        evidence: {},
        events: [],
      }),
      /Pool token mismatch/,
    );
    assert.equal((await getStream(db, p.key)).cursor, null);
  });
  await t.test(
    "a write failure rolls back events and checkpoint together",
    async () => {
      const p = await nextPool(db);
      assert.ok(p);
      const e = {
        txHash: hash(501),
        logIndex: 1,
        block: 10,
        blockHash: hash(10),
        timestamp: 100,
        transactionSender: token,
        kind: "swap" as const,
        payload: { amount0: "-123456789012345678901234567890" },
      };
      const invalid: Batch = {
        from: 10,
        to: 19,
        hash: hash(19),
        token,
        evidence: {},
        events: [e, e],
      };
      await assert.rejects(commitBatch(db, p, invalid));
      assert.equal((await getStream(db, p.key)).cursor, null);
      assert.equal((await status(db)).counts.swaps, "0");
      await commitBatch(db, p, { ...invalid, events: [e] });
      const saved = await db.query("SELECT payload FROM indexed_events");
      assert.equal(saved.rows[0].payload.amount0, e.payload.amount0);
    },
  );
  await t.test(
    "restart reads committed progress and competing worker is excluded",
    async () => {
      assert.equal(await acquireWriter(db), true);
      const second = createClient(url);
      await second.connect();
      try {
        await second.query(`SET search_path TO "${schema}"`);
        assert.equal(await acquireWriter(second), false);
        assert.equal((await getStream(second, s.key)).cursor, 19);
        const p = await nextPool(second);
        assert.equal(p?.cursor, 19);
      } finally {
        await second.end();
      }
    },
  );
  await t.test(
    "pool rewind removes orphaned events and permits canonical replacement",
    async () => {
      const p = await nextPool(db);
      assert.ok(p);
      await rewind(db, p, null);
      assert.equal((await status(db)).counts.swaps, "0");
      const reset = await getStream(db, p.key);
      assert.equal(reset.cursor, null);
      await commitBatch(db, reset, {
        from: 10,
        to: 19,
        hash: hash(219),
        token,
        evidence: {},
        events: [],
      });
      assert.equal((await getStream(db, p.key)).hash, hash(219));
    },
  );
  await t.test(
    "discovery rewind cascades only orphaned pools and their streams",
    async () => {
      const current = await getStream(db, s.key);
      const later = {
        ...pool,
        id: hash(200),
        launchBlock: 25,
        launchTx: hash(201),
      };
      await commitBatch(db, current, {
        from: 20,
        to: 29,
        hash: hash(29),
        evidence: {},
        pools: [later],
      });
      assert.equal((await status(db)).counts.pools, "2");
      await rewind(db, await getStream(db, s.key), 19);
      assert.equal((await status(db)).counts.pools, "1");
      await assert.rejects(getStream(db, "pool:" + later.id), /not found/);
      assert.equal((await getStream(db, "pool:" + pool.id)).cursor, 19);
      await assert.rejects(rewind(db, current, 999), /Unknown ancestor/);
      await rewind(db, await getStream(db, s.key), null);
      assert.equal((await status(db)).counts.pools, "0");
      assert.equal((await status(db)).streams.length, 1);
    },
  );
});
