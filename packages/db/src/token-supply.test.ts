import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, migrate } from "./index";
import {
  saveTokenSupplies,
  tokenSupplyCoverage,
  unreadTokenSupplies,
} from "./token-supply";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated test Postgres instance; DATABASE_URL is never used by these tests",
  );
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("Postgres: supplies page forward over unread pools and never go back to an earlier block", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = "token_supply_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  await db.query(
    "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',100,200,$1)",
    [word(200)],
  );
  await db.query(
    "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v1',100,200,$1,'fixture','{}')",
    [word(200)],
  );
  // Pools 1 to 4; pool 4 is a second pool of token 1.
  for (const [pool, token] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 1],
  ])
    await db.query(
      "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Pool','P',100,$3,$2,1000,'discovery:v1',200)",
      [word(pool), address(token), word(1000 + pool)],
    );
  const refs = (
    await db.query("SELECT pool_ref FROM indexed_pools ORDER BY pool_id")
  ).rows.map((r) => Number(r.pool_ref));

  assert.deepEqual(await tokenSupplyCoverage(db), {
    pools: 4,
    read: 0,
    unread: 4,
    firstBlock: null,
    lastBlock: null,
  });
  const first = await unreadTokenSupplies(db, 0, 2);
  assert.deepEqual(first, [
    { poolRef: refs[0], token: address(1) },
    { poolRef: refs[1], token: address(2) },
  ]);
  assert.equal(await saveTokenSupplies(db, []), 0);
  const max = ((1n << 256n) - 1n).toString();
  assert.equal(
    await saveTokenSupplies(db, [
      {
        token: address(1),
        supplyRaw: "1000000000000000000000000000",
        block: 500,
      },
      { token: address(2), supplyRaw: max, block: 500 },
    ]),
    3,
  );
  // Token 3 is left unread (its reply was not a supply) and paging moves past it.
  assert.deepEqual(await unreadTokenSupplies(db, refs[1], 2), [
    { poolRef: refs[2], token: address(3) },
  ]);
  assert.deepEqual(await unreadTokenSupplies(db, refs[2], 2), []);
  assert.deepEqual(await tokenSupplyCoverage(db), {
    pools: 4,
    read: 3,
    unread: 1,
    firstBlock: 500,
    lastBlock: 500,
  });

  // An older reading is ignored; a newer one replaces the value on every pool.
  assert.equal(
    await saveTokenSupplies(db, [
      { token: address(1), supplyRaw: "1", block: 499 },
    ]),
    0,
  );
  assert.equal(
    await saveTokenSupplies(db, [
      { token: address(1), supplyRaw: "2", block: 501 },
    ]),
    2,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT token_total_supply_raw::text AS supply,token_supply_block::int AS block FROM indexed_pools ORDER BY pool_id",
      )
    ).rows,
    [
      { supply: "2", block: 501 },
      { supply: max, block: 500 },
      { supply: null, block: null },
      { supply: "2", block: 501 },
    ],
  );

  for (const bad of [
    { token: address(1).toUpperCase(), supplyRaw: "1", block: 1 },
    { token: address(1), supplyRaw: "-1", block: 1 },
    { token: address(1), supplyRaw: (1n << 256n).toString(), block: 1 },
    { token: address(1), supplyRaw: "1", block: -1 },
  ])
    await assert.rejects(saveTokenSupplies(db, [bad]), /Invalid token supply/);
  await assert.rejects(unreadTokenSupplies(db, -1, 1), /Invalid token supply/);
  await assert.rejects(unreadTokenSupplies(db, 0, 0), /Invalid token supply/);
});
