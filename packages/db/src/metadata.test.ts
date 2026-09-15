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
} from "./index";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error("Set TEST_DATABASE_URL to a dedicated test Postgres instance");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const token = "0x" + "1".repeat(40);

test("factory metadata follows surviving launch evidence across overlap and reorg", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = `metadata_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
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
  const batch: Batch = {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool],
  };
  const original = await ensureDiscovery(db, 10);
  await commitBatch(db, original, batch);
  const history = await getStream(db, "pool:" + pool.id);
  const tuple = {
    imageUrl: "ipfs://bafyfixture/token.png",
    description: "Original creator description",
    externalUrl: "https://example.com/token",
  };
  const observed: Batch = { ...batch, pools: [{ ...pool, ...tuple }] };
  const source = await commitCandidateBatch(db, "metadata-fixture", observed);
  const values = async () =>
    (
      await db.query(
        "SELECT image_url,description,external_url FROM indexed_pools WHERE pool_id=$1",
        [pool.id],
      )
    ).rows[0];
  assert.deepEqual(await values(), {
    image_url: tuple.imageUrl,
    description: tuple.description,
    external_url: tuple.externalUrl,
  });
  assert.deepEqual(await getStream(db, history.key), history);
  assert.equal(
    (await commitCandidateBatch(db, "metadata-fixture", observed)).changed,
    false,
  );
  await assert.rejects(
    commitCandidateBatch(db, "metadata-conflict", {
      ...observed,
      pools: [
        { ...pool, ...tuple, imageUrl: "https://example.com/changed.png" },
      ],
    }),
    /Conflicting launch metadata/,
  );
  await assert.rejects(
    getStream(db, `candidate:metadata-conflict:${pool.id}`),
    /Stream not found/,
  );

  await rewind(db, source.stream, null);
  assert.deepEqual(await values(), {
    image_url: null,
    description: null,
    external_url: null,
  });
  assert.deepEqual(await getStream(db, history.key), history);
  await commitCandidateBatch(db, "metadata-fixture", observed);
  await rewind(db, await getStream(db, original.key), null);
  assert.equal((await values()).image_url, tuple.imageUrl);
  await rewind(db, await getStream(db, source.stream.key), null);
  assert.equal(await values(), undefined);
  await assert.rejects(getStream(db, history.key), /Stream not found/);
});
