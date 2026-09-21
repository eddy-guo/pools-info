import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { createClient, migrate } from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createWarmSet } from "./warm-set";
import { parseRequest, RequestError } from "./request";

const dbTest = { skip: !process.env.TEST_DATABASE_URL };
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail("condition did not settle");
}

test(
  "real reader startup, database-wide cancellation backstop and warm recovery",
  dbTest,
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema = `api_test_warm_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await migrate(db);
    const reader = createReader(url, schema, {
      marketSource: "ledger",
      warmup: true,
    });
    const warming = (e: unknown) =>
      e instanceof RequestError && e.reason === "warming";
    t.after(async () => {
      await db.query("ROLLBACK");
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    });
    assert.throws(() => reader.assertReady!(), warming);
    assert.deepEqual(await reader.read(parseRequest("/ready")), {
      ready: true,
    });
    await until(async () => {
      try {
        reader.assertReady!();
        return true;
      } catch {
        return false;
      }
    });
    const generation = reader.assertReady!();
    await db.query("BEGIN");
    await db.query("LOCK TABLE indexed_pools IN ACCESS EXCLUSIVE MODE");
    await assert.rejects(
      reader.read(parseRequest("/v1/pools")),
      (e: unknown) => (e as { code: string }).code === "57014",
    );
    assert.throws(() => reader.assertReady!(), warming);
    const start = performance.now();
    await assert.rejects(reader.read(parseRequest("/v1/creators")), warming);
    assert.ok(
      performance.now() - start < 100,
      "subsequent DB routes refuse without a SQL wait",
    );
    await db.query("ROLLBACK");
    await until(async () => {
      try {
        reader.assertReady!();
        return true;
      } catch {
        return false;
      }
    });
    assert.throws(() => reader.assertReady!(generation), warming);
  },
);

test(
  "cycle abort disconnects a blocked warm query promptly and leaves no warm transaction",
  dbTest,
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema = `api_test_cancel_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await migrate(db);
    const controller = new AbortController();
    t.after(async () => {
      controller.abort();
      await db.query("ROLLBACK");
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    });
    await db.query("BEGIN");
    await db.query("LOCK TABLE indexed_pools IN ACCESS EXCLUSIVE MODE");
    const observer = new pg.Client({ connectionString: url });
    await observer.connect();
    t.after(() => observer.end());
    const run = createWarmSet(
      url,
      "ledger",
      schema,
    )({ signal: controller.signal, identity: () => {}, slow: () => {} });
    // Capture rejection immediately so cancellation cannot become unhandled.
    const rejected = assert.rejects(run);
    let pid = 0;
    await until(async () => {
      const rows = await observer.query(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON a.pid=l.pid
      WHERE a.application_name='pools-reader-warmup' AND NOT l.granted AND l.relation=$1::regclass`,
        [`${schema}.indexed_pools`],
      );
      pid = rows.rows[0]?.pid ?? 0;
      return pid > 0;
    });
    const start = performance.now();
    controller.abort();
    await rejected;
    assert.ok(
      performance.now() - start < 1000,
      "indexing does not wait for the ten-second warm statement budget",
    );
    await until(
      async () =>
        (
          await observer.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
            pid,
          ])
        ).rowCount === 0,
    );
  },
);
