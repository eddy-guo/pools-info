import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, migrate } from "./index";
import {
  loadSenderCode,
  saveSenderCode,
  senderCodeReusable,
  type SenderCodeObservation,
} from "./sender-code";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated test Postgres instance; DATABASE_URL is never used by these tests",
  );
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
test("a saved code observation answers only the blocks it can vouch for", () => {
  const empty: SenderCodeObservation = {
    address: addr(1),
    codeHash: null,
    observedBlock: 1000,
  };
  const coded: SenderCodeObservation = { ...empty, codeHash: hash(7) };
  const horizon = 500;
  // No code at 1000: every earlier block, and later ones until the recheck.
  for (const block of [0, 999, 1000, 1500]) {
    assert.equal(senderCodeReusable(empty, block, horizon), true, `${block}`);
  }
  assert.equal(senderCodeReusable(empty, 1501, horizon), false);
  // Code at 1000: only from that block until the recheck, never earlier.
  assert.equal(senderCodeReusable(coded, 999, horizon), false);
  assert.equal(senderCodeReusable(coded, 1000, horizon), true);
  assert.equal(senderCodeReusable(coded, 1500, horizon), true);
  assert.equal(senderCodeReusable(coded, 1501, horizon), false);
  // A zero horizon records but never reuses; invalid queries are rejected.
  assert.equal(senderCodeReusable(empty, 1000, 0), false);
  assert.throws(() => senderCodeReusable(empty, -1, horizon), /query/);
  assert.throws(() => senderCodeReusable(empty, 1, 1.5), /query/);
});
test("Postgres: observations persist per address and only newer heights replace them", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = "sender_code_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  assert.deepEqual(await loadSenderCode(db, []), new Map());
  await saveSenderCode(db, []);
  await saveSenderCode(db, [
    { address: addr(1), codeHash: null, observedBlock: 100 },
    { address: addr(2), codeHash: hash(2), observedBlock: 100 },
  ]);
  const first = await loadSenderCode(db, [addr(1), addr(2), addr(3)]);
  assert.deepEqual(
    [...first.values()],
    [
      { address: addr(1), codeHash: null, observedBlock: 100 },
      { address: addr(2), codeHash: hash(2), observedBlock: 100 },
    ],
  );
  // Older or equal heights keep the stored row; a newer height replaces it,
  // including an EOA that later delegated code.
  await saveSenderCode(db, [
    { address: addr(1), codeHash: hash(9), observedBlock: 90 },
    { address: addr(2), codeHash: null, observedBlock: 100 },
  ]);
  assert.deepEqual(await loadSenderCode(db, [addr(1), addr(2)]), first);
  await saveSenderCode(db, [
    { address: addr(1), codeHash: hash(9), observedBlock: 101 },
  ]);
  assert.deepEqual(
    (await loadSenderCode(db, [addr(1).toUpperCase().replace("0X", "0x")])).get(
      addr(1),
    ),
    { address: addr(1), codeHash: hash(9), observedBlock: 101 },
  );
  for (const invalid of [
    { address: "0x12", codeHash: null, observedBlock: 1 },
    { address: addr(1), codeHash: "0x12", observedBlock: 1 },
    { address: addr(1), codeHash: null, observedBlock: -1 },
  ])
    await assert.rejects(saveSenderCode(db, [invalid]), /observation/);
  await assert.rejects(loadSenderCode(db, ["0x12"]), /selection/);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM sender_code_observations WHERE chain_id=4663",
      )
    ).rows[0].n,
    2,
  );
});
