import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createClient,
  getStream,
  markAttempt,
  migrate,
  nextPoolGroup,
  rewind,
} from "./index";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "TEST_DATABASE_URL is required; production DATABASE_URL is never used",
  );

test("deep scheduler starts with the busiest stored canonical pool rather than key order", async (t) => {
  const db = createClient(url);
  await db.connect();
  const schema = "scheduler_" + randomUUID().replaceAll("-", "");
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
  for (let i = 1; i <= 4; i++) {
    await db.query(
      "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Pool','P',100,$3,$2,1000,'discovery:v1',200)",
      [word(i), address(i), word(1000 + i)],
    );
    await db.query(
      "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block) VALUES(4663,$1,'pool',$2,100)",
      ["pool:" + word(i), word(i)],
    );
  }
  await db.query(
    "INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'swaps',100,200,$1,2000)",
    [word(200)],
  );
  await db.query(
    "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'swaps',100,200,$1,2000,'fixture','{}')",
    [word(200)],
  );
  const volume = "900719925474099300001";
  await db.query(
    "INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side) VALUES(4663,200,$1,$2,$3,0,101,$4,1001,$2,$5,'100',$6,'100','buy')",
    [word(4), address(4), word(4000), word(101), "-" + volume, volume],
  );
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(4));
  // Adjacent values above 2^53 must not collapse to a floating point tie.
  await db.query(
    "INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side) VALUES(4663,200,$1,$2,$3,0,102,$4,1002,$2,$5,'100',$6,'100','buy')",
    [
      word(3),
      address(3),
      word(3000),
      word(102),
      "-" + (BigInt(volume) - 1n),
      "" + (BigInt(volume) - 1n),
    ],
  );
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(4));
  await markAttempt(db, "pool:" + word(4));
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(3));
  // Losing the owned recent range removes its priority, even with a stale tip.
  await db.query("DELETE FROM recent_batches WHERE stream_key='swaps'");
  await db.query(
    "UPDATE indexer_streams SET attempted_at='epoch' WHERE kind='pool'",
  );
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(1));
  const publication = async (i: number, liquidity: string | null) => {
    const key = "pool:" + word(i),
      generated = "2026-09-15T00:00:00Z";
    await db.query(
      "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,$1,100,199,$2,'fixture','{}')",
      [key, word(199)],
    );
    await db.query(
      "UPDATE indexer_streams SET cursor_block=199,cursor_hash=$2 WHERE stream_key=$1",
      [key, word(199)],
    );
    const snapshot = {
      schemaVersion: 1,
      chainId: 4663,
      toBlock: 199,
      blockHash: word(199),
      toTimestamp: 2000,
      markets: [{ id: word(i) }],
    };
    await db.query(
      "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,liquidity_wei,source_kind,source_stream,source_batch) VALUES(4663,$1,199,$2,2000,$3,$4,$5,'indexed',$6,199)",
      [word(i), word(199), generated, snapshot, liquidity, key],
    );
    await db.query(
      "INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market,liquidity_wei) VALUES(4663,$1,1,199,$2,100,1000,2000,$3,'indexed',$4,$5)",
      [
        word(i),
        word(199),
        generated,
        { id: word(i), volumeWei: "0" },
        liquidity,
      ],
    );
  };
  await publication(1, "0");
  await publication(2, volume);
  await publication(3, null);
  // Observed zero beats missing volume; known zero liquidity beats missing.
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(2));
  await rewind(db, await getStream(db, "pool:" + word(2)), null);
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(1));
  await rewind(db, await getStream(db, "pool:" + word(1)), null);
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(3));
  await db.query(
    "INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,execution_supported) VALUES(4663,$1,$2,0,150,1500,'buy',10,1,false)",
    [word(3), word(777)],
  );
  await db.query(
    "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'swaps',100,200,$1,2000,'fixture','{}')",
    [word(200)],
  );
  for (const [i, tx, eth] of [
    [3, 777, 10],
    [4, 888, 15],
  ])
    await db.query(
      "INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side) VALUES(4663,200,$1,$2,$3,0,150,$4,1500,$2,$5,'1',$6,'1','buy')",
      [word(i), address(i), word(tx), word(150), "-" + eth, "" + eth],
    );
  // A deep/recent duplicate counts once: 15 outranks 10, never doubled to 20.
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(4));
  await db.query(
    "UPDATE recent_swaps SET eth_wei='11',amount0='-11' WHERE tx_hash=$1",
    [word(777)],
  );
  await assert.rejects(
    nextPoolGroup(db, 1),
    /Conflicting canonical scheduler activity/,
  );
  await db.query("DELETE FROM recent_batches WHERE stream_key='swaps'");
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, word(3));
  // A 52k-pool registry remains SQL-ranked and bounded to the requested group.
  await db.query(`INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
    SELECT 4663,'0x'||lpad(to_hex(i),64,'0'),'0x'||lpad(to_hex(i),40,'0'),'Scale','S',100,'0x'||lpad(to_hex(i+100000),64,'0'),'0x'||lpad(to_hex(i),40,'0'),1000,'discovery:v1',200 FROM generate_series(5,52004) i`);
  await db.query(
    "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block) SELECT chain_id,'pool:'||pool_id,'pool',pool_id,100 FROM indexed_pools WHERE pool_id>$1",
    [word(4)],
  );
  await db.query(
    "UPDATE indexer_streams SET attempted_at=statement_timestamp() WHERE kind='pool'",
  );
  const started = performance.now(),
    group = await nextPoolGroup(db, 200);
  assert.equal(group[0].poolId, word(3));
  assert.ok(group.length <= 200);
  assert.ok(
    performance.now() - started < 3000,
    "52k selection must complete within the existing API-sized budget",
  );
  // All overdue bands use global age before rank. Repeated top-band demand
  // cannot displace this finite queue of low-ranked streams.
  for (let i = 52000; i <= 52004; i++)
    await db.query(
      "UPDATE indexer_streams SET attempted_at=statement_timestamp()-interval '31 minutes'+$2::integer*interval '1 second' WHERE stream_key=$1",
      ["pool:" + word(i), i - 52000],
    );
  for (let i = 52000; i <= 52004; i++) {
    const selected = (await nextPoolGroup(db, 1))[0];
    assert.equal(selected.poolId, word(i));
    await markAttempt(db, selected.key);
  }
  await db.query(
    "UPDATE indexer_streams SET attempted_at=statement_timestamp() WHERE kind='pool'",
  );
  // Within-band rotation serves a lower ranked peer after the prior attempt.
  const first = (await nextPoolGroup(db, 1))[0];
  await markAttempt(db, first.key);
  const peer = (await nextPoolGroup(db, 1))[0];
  assert.notEqual(peer.key, first.key);
  assert.notEqual((await nextPoolGroup(db, 1))[0].poolId, word(52004));
  // Scheduling reads do not change coverage or the writer-lock implementation.
  assert.equal((await getStream(db, "pool:" + word(3))).cursor, 199);
  await assert.rejects(nextPoolGroup(db, 201), /Invalid pool selection limit/);
});
