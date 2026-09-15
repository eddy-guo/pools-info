import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  acquireWriter,
  waitForWriter,
  commitBatch,
  commitCandidateBatch,
  candidateStreamKey,
  commitPoolGroup,
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
test("candidate batches create bounded sources atomically without advancing broad discovery", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = "candidate_commit_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const broad = await ensureDiscovery(db, 1000);
  const batch: Batch = {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: { verified: "fixture" },
    pools: [pool],
  };
  const first = await commitCandidateBatch(db, "registry-v1", batch);
  assert.equal(first.changed, true);
  assert.equal(first.stream.start, 10);
  assert.equal(first.stream.cursor, 19);
  assert.deepEqual(await getStream(db, broad.key), broad);
  assert.equal(
    (await commitCandidateBatch(db, "registry-v1", batch)).changed,
    false,
  );
  await commitBatch(db, await getStream(db, "pool:" + pool.id), {
    from: 10,
    to: 19,
    hash: hash(19),
    token,
    evidence: {},
    events: [],
  });
  const history = await getStream(db, "pool:" + pool.id);
  assert.equal(
    (await commitCandidateBatch(db, "registry-v2", batch)).changed,
    true,
  );
  assert.deepEqual(await getStream(db, "pool:" + pool.id), history);
  await assert.rejects(
    commitCandidateBatch(db, "conflict", {
      ...batch,
      pools: [{ ...pool, launchTx: hash(999) }],
    }),
    /Conflicting launch identity/,
  );
  await assert.rejects(
    getStream(db, candidateStreamKey("conflict", pool.id)),
    /Stream not found/,
  );
  for (const invalid of [
    { ...batch, to: 42 },
    { ...batch, pools: [] },
    { ...batch, from: 9 },
  ])
    await assert.rejects(
      commitCandidateBatch(db, "registry-v1", invalid),
      /Invalid candidate batch|differs/,
    );
  await assert.rejects(
    commitCandidateBatch(db, "bad/revision", batch),
    /Invalid candidate identity/,
  );
  await assert.rejects(
    commitCandidateBatch(db, "registry-v1", { ...batch, hash: hash(20) }),
    /Conflicting replay/,
  );
  assert.deepEqual(await getStream(db, "pool:" + pool.id), history);
  const sources = await db.query(
    "SELECT count(*)::int AS n FROM pool_launch_sources",
  );
  assert.equal(sources.rows[0].n, 2);
  await rewind(db, await getStream(db, first.stream.key), null);
  assert.equal(
    (await commitCandidateBatch(db, "registry-v1", batch)).changed,
    true,
  );
  assert.deepEqual(await getStream(db, "pool:" + pool.id), history);
});
test("overlapping launch sources preserve history and reject identity conflicts", async (t) => {
  for (const removeOriginalFirst of [true, false]) {
    await t.test(`rewind original first: ${removeOriginalFirst}`, async (t) => {
      const db = createClient(url);
      await db.connect();
      const schema = "launch_sources_" + randomUUID().replaceAll("-", "");
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET search_path TO "${schema}"`);
      t.after(async () => {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        await db.end();
      });
      // Construct an actual pre-upgrade database, including an indexed launch.
      await db.query(
        "CREATE TABLE pools_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const name of [
        "001_indexer.sql",
        "002_read_indexes.sql",
        "003_analytics.sql",
        "004_recent_activity.sql",
        "005_accounting_rows.sql",
        "006_catalog_search.sql",
      ]) {
        const sql = await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        );
        await db.query(sql);
        await db.query(
          "INSERT INTO pools_schema_migrations(name,checksum) VALUES ($1,$2)",
          [name, createHash("sha256").update(sql).digest("hex")],
        );
      }
      await ensureDiscovery(db, 10);
      await db.query(
        "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES (4663,'discovery:v1',10,19,$1,'legacy','{}')",
        [hash(19)],
      );
      await db.query(
        "INSERT INTO indexed_pools VALUES (4663,$1,$2,$3,$4,10,$5,$2,100,'discovery:v1',19)",
        [pool.id, token, pool.name, pool.symbol, pool.launchTx],
      );
      await db.query(
        "UPDATE indexer_streams SET cursor_block=19,cursor_hash=$1 WHERE stream_key='discovery:v1'",
        [hash(19)],
      );
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block) VALUES (4663,$1,'pool',$2,10)",
        ["pool:" + pool.id, pool.id],
      );
      await migrate(db);
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM pool_launch_sources"))
          .rows[0].n,
        1,
      );
      const key = "pool:" + pool.id;
      await commitBatch(db, await getStream(db, key), {
        from: 10,
        to: 19,
        hash: hash(19),
        evidence: {},
        token,
        events: [
          {
            block: 12,
            timestamp: 120,
            txHash: hash(200),
            blockHash: hash(12),
            logIndex: 0,
            kind: "transfer",
            transactionSender: token,
            payload: { value: "1" },
          },
        ],
      });
      const history = await getStream(db, key);
      await db.query(
        "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind,source_stream,source_batch) VALUES (4663,$1,19,$2,190,$3,'indexed',$4,19)",
        [
          pool.id,
          hash(19),
          JSON.stringify({
            schemaVersion: 1,
            chainId: 4663,
            markets: [{ id: pool.id }],
            toBlock: 19,
            blockHash: hash(19),
            toTimestamp: 190,
          }),
          key,
        ],
      );
      await db.query(
        "INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market) VALUES (4663,$1,1,19,$2,10,100,190,now(),'indexed','{}')",
        [pool.id, hash(19)],
      );
      await db.query(
        "INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags,quantity_raw,cost_wei,invested_wei,proceeds_wei,realized_wei,buys,sells) VALUES (4663,$1,$2,true,'{}',10,100,100,0,0,1,0)",
        [pool.id, token],
      );
      const position = (
        await db.query("SELECT * FROM analytics_accounting_positions")
      ).rows;
      for (const source of ["candidate:test", "conflict:test"])
        await db.query(
          "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block) VALUES (4663,$1,'discovery',10)",
          [source],
        );
      const candidate = await getStream(db, "candidate:test");
      const batch: Batch = {
        from: 10,
        to: 19,
        hash: hash(19),
        evidence: { source: "candidate" },
        pools: [pool],
      };
      assert.equal(await commitBatch(db, candidate, batch), true);
      assert.equal(await commitBatch(db, candidate, batch), false);
      assert.deepEqual(await getStream(db, key), history);
      assert.deepEqual(
        (await db.query("SELECT * FROM analytics_accounting_positions")).rows,
        position,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM pool_launch_sources"))
          .rows[0].n,
        2,
      );
      for (const conflict of [
        { token: "0x" + "2".repeat(40) },
        { launchTx: hash(999) },
        { launchSender: "0x" + "2".repeat(40) },
        { launchedAt: 101 },
        { launchBlock: 11 },
      ]) {
        await assert.rejects(
          commitBatch(db, await getStream(db, "conflict:test"), {
            ...batch,
            pools: [{ ...pool, ...conflict }],
          }),
          /Conflicting launch identity/,
        );
        assert.equal((await getStream(db, "conflict:test")).cursor, null);
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM indexer_batches WHERE stream_key='conflict:test'",
            )
          ).rows[0].n,
          0,
        );
      }
      const order = removeOriginalFirst
        ? ["discovery:v1", "candidate:test"]
        : ["candidate:test", "discovery:v1"];
      await rewind(db, await getStream(db, order[0]), null);
      assert.deepEqual(await getStream(db, key), history);
      assert.deepEqual(
        (await db.query("SELECT * FROM analytics_accounting_positions")).rows,
        position,
      );
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM indexed_events"))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await db.query("SELECT source_stream FROM indexed_pools")).rows[0]
          .source_stream,
        order[1],
      );
      await rewind(db, await getStream(db, order[1]), null);
      await assert.rejects(getStream(db, key), /Stream not found/);
      for (const table of [
        "indexed_pools",
        "indexed_events",
        "pool_launch_sources",
        "analytics_pool_snapshots",
        "analytics_accounting_pools",
        "analytics_accounting_positions",
      ])
        assert.equal(
          (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
          0,
        );
      await commitBatch(db, await getStream(db, "candidate:test"), batch);
      assert.equal((await getStream(db, key)).cursor, null);
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM indexed_pools")).rows[0]
          .n,
        1,
      );
    });
  }
});
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
  assert.deepEqual(
    (
      await db.query("SELECT name FROM pools_schema_migrations ORDER BY name")
    ).rows.map((r) => r.name),
    [
      "001_indexer.sql",
      "002_read_indexes.sql",
      "003_analytics.sql",
      "004_recent_activity.sql",
      "005_accounting_rows.sql",
      "006_catalog_search.sql",
      "007_launch_sources.sql",
    ],
  );
  const readIndexes = await db.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('indexed_events_global_trades','indexed_events_transfer_from','indexed_events_transfer_to','indexer_streams_pool_lookup') ORDER BY indexname",
    [schema],
  );
  assert.equal(readIndexes.rowCount, 4);
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

test("replacement writer waits for old release, acquires only once, and respects timeout and cancellation", async (t) => {
  const old = createClient(url);
  const replacement = createClient(url);
  await old.connect();
  await replacement.connect();
  t.after(async () => {
    await replacement.end();
    await old.end();
  });
  const release = (client: typeof old) =>
    client.query("SELECT pg_advisory_unlock(4663, 19002)");
  await t.test(
    "old deployment releases while its replacement waits",
    async () => {
      assert.equal(await acquireWriter(old), true);
      let acquired = false;
      const waiting = waitForWriter(replacement, {
        timeoutMs: 2000,
        pollMs: 10,
      }).then((result) => {
        acquired = result;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(acquired, false);
      await release(old);
      assert.equal(await waiting, true);
      assert.equal(await acquireWriter(old), false);
      // One unlock must release ownership completely; retrying after acquisition
      // would recursively take the session lock and make this assertion fail.
      await release(replacement);
      assert.equal(await acquireWriter(old), true);
      await release(old);
    },
  );
  await t.test(
    "deadline expiry cannot acquire later when old owner exits",
    async () => {
      assert.equal(await acquireWriter(old), true);
      assert.equal(
        await waitForWriter(replacement, { timeoutMs: 50, pollMs: 10 }),
        false,
      );
      await release(old);
      assert.equal(await acquireWriter(old), true);
      await release(old);
      assert.equal(await waitForWriter(replacement, { timeoutMs: 0 }), false);
      assert.equal(await acquireWriter(old), true);
      await release(old);
    },
  );
  await t.test(
    "cancellation interrupts polling without acquiring the lock",
    async () => {
      assert.equal(await acquireWriter(old), true);
      const controller = new AbortController();
      const waiting = waitForWriter(replacement, {
        signal: controller.signal,
        timeoutMs: 2000,
        pollMs: 1000,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      assert.equal(await waiting, false);
      await release(old);
      assert.equal(
        await waitForWriter(replacement, { signal: controller.signal }),
        false,
      );
      assert.equal(await acquireWriter(old), true);
      await release(old);
    },
  );
  await t.test(
    "cancellation racing a successful acquisition releases that acquisition",
    async () => {
      const controller = new AbortController();
      const original = replacement.query.bind(replacement);
      replacement.query = (async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (
          typeof args[0] === "string" &&
          args[0].includes("pg_try_advisory_lock")
        )
          controller.abort();
        return result;
      }) as typeof replacement.query;
      try {
        assert.equal(
          await waitForWriter(replacement, { signal: controller.signal }),
          false,
        );
        assert.equal(await acquireWriter(old), true);
        await release(old);
      } finally {
        replacement.query = original;
      }
    },
  );
});

test("shared pool commit rolls back the whole group, survives replay and rejects stale members", async (t) => {
  const schema = "group_" + randomUUID().replaceAll("-", "");
  const db = createClient(url);
  await db.connect();
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const secondPool = {
    ...pool,
    id: hash(102),
    token: "0x" + "2".repeat(40),
    launchTx: hash(103),
  };
  await commitBatch(db, await ensureDiscovery(db, 10), {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool, secondPool],
  });
  const entries = await Promise.all(
    [pool, secondPool].map(async (p, i) => ({
      expected: await getStream(db, "pool:" + p.id),
      batch: {
        from: 10,
        to: 19,
        hash: hash(19),
        token: p.token,
        evidence: { marker: p.id },
        events: [
          {
            txHash: hash(501),
            logIndex: i,
            block: 10,
            blockHash: hash(10),
            timestamp: 100,
            transactionSender: token,
            kind: "swap" as const,
            payload: { amount: "123456789012345678901234567890" },
          },
        ],
      },
    })),
  );
  // The earlier stream is written before the later identity fails. Neither its
  // events nor its cursor may leak out of the failed group transaction.
  await assert.rejects(
    commitPoolGroup(db, [
      entries[0],
      {
        ...entries[1],
        batch: { ...entries[1].batch, token },
      },
    ]),
    /Pool token mismatch/,
  );
  for (const e of entries)
    assert.equal((await getStream(db, e.expected.key)).cursor, null);
  assert.equal(
    (await db.query("SELECT count(*) AS n FROM indexed_events")).rows[0].n,
    "0",
  );
  assert.deepEqual(await commitPoolGroup(db, [...entries].reverse()), [
    true,
    true,
  ]);
  const restarted = createClient(url);
  await restarted.connect();
  try {
    await restarted.query(`SET search_path TO "${schema}"`);
    assert.deepEqual(await commitPoolGroup(restarted, entries), [false, false]);
    assert.equal(
      (await restarted.query("SELECT count(*) AS n FROM indexed_events"))
        .rows[0].n,
      "2",
    );
    assert.equal(
      (await restarted.query("SELECT payload FROM indexed_events LIMIT 1"))
        .rows[0].payload.amount,
      entries[0].batch.events[0].payload.amount,
    );
  } finally {
    await restarted.end();
  }
  const next = await Promise.all(
    entries.map(async (e) => ({
      expected: await getStream(db, e.expected.key),
      batch: { ...e.batch, from: 20, to: 29, hash: hash(29), events: [] },
    })),
  );
  await assert.rejects(
    commitPoolGroup(db, [
      next[0],
      {
        ...next[1],
        expected: { ...next[1].expected, cursor: 18 },
      },
    ]),
    /Stale checkpoint/,
  );
  for (const e of entries)
    assert.equal((await getStream(db, e.expected.key)).cursor, 19);
  assert.equal(
    (
      await db.query(
        "SELECT count(*) AS n FROM indexer_batches WHERE to_block=29",
      )
    ).rows[0].n,
    "0",
  );
  await assert.rejects(
    commitPoolGroup(db, [next[0], next[0]]),
    /Invalid pool commit group/,
  );
  await assert.rejects(commitPoolGroup(db, []), /Invalid pool commit group/);
  assert.deepEqual(await commitPoolGroup(db, next), [true, true]);
  await rewind(db, await getStream(db, next[0].expected.key), 19);
  assert.deepEqual(await commitPoolGroup(db, [...next].reverse()), [
    false,
    true,
  ]);
  for (const e of next)
    await rewind(db, await getStream(db, e.expected.key), 19);
  const replacement = next.map((e) => ({
    ...e,
    batch: { ...e.batch, hash: hash(999) },
  }));
  assert.deepEqual(await commitPoolGroup(db, replacement), [true, true]);
  for (const e of entries)
    assert.equal((await getStream(db, e.expected.key)).hash, hash(999));
});
