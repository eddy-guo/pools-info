import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createReader } from "./reader";
import { parseRequest } from "./request";
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");

test(
  "recent birth-contiguous initiator ledger widens ranking and agrees with profiles",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    const read = (path: string) =>
      reader.read(parseRequest(path)) as Promise<any>;
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      const directory = new URL(
        "../../../packages/db/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await db.query(await readFile(new URL(name, directory), "utf8"));
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'discovery',100,200,$1,700000),(4663,'swaps',100,200,$1,700000)",
        [word(200)],
      );
      for (const stream of ["discovery", "swaps"])
        await db.query(
          "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,$1,100,200,$2,700000,'test','{}')",
          [stream, word(200)],
        );
      await db.query(
        "INSERT INTO recent_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch) VALUES(4663,$1,$2,'Young','Y',100,$3,$4,1000,200)",
        [word(1), address(1), word(99), address(99)],
      );
      const cost = 900719925474099300001n;
      for (let w = 1; w <= 16; w++)
        for (let t = 0; t < 10; t++) {
          const buy = t % 2 === 0,
            eth = buy ? cost : cost + BigInt(w);
          await db.query(
            `INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
        VALUES(4663,200,$1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,'100',$11)`,
            [
              word(1),
              address(1),
              word(w * 100 + t),
              101 + t,
              word(101 + t),
              buy ? 1000 + t : 699990 + t,
              address(w),
              buy ? "-" + eth : "" + eth,
              buy ? "100" : "-100",
              "" + eth,
              buy ? "buy" : "sell",
            ],
          );
        }
      let board = await read("/v1/leaderboard?window=All&limit=5");
      assert.equal(board.total, 16);
      assert.equal(board.items[0].address, address(16));
      assert.equal(board.items[0].realizedWei, "80");
      assert.equal(board.items[0].accountingTier, "tier2");
      assert.equal(board.items[0].supportedPositionCount, 0);
      const profile = await read(`/v1/wallets/${address(16)}?window=All`);
      assert.deepEqual(profile.wallet, board.items[0]);
      assert.equal(profile.curve.at(-1).wei, "80");
      assert.equal(profile.positions[0].supported, false);
      assert.equal(profile.positions[0].realizedWei, "80");
      board = await read("/v1/leaderboard?window=All&limit=5&offset=5");
      assert.equal(board.items[0].rank, 6);
      const trailing = await read(`/v1/wallets/${address(16)}?window=7d`);
      assert.equal(trailing.window, "7d");
      assert.equal(trailing.wallet.realizedWei, "80");
      assert.equal(profile.wallet.excludedPositionCount, 0);
      assert.ok(
        profile.curve.every(
          (point: any, i: number) =>
            !i || point.time >= profile.curve[i - 1].time,
        ),
      );
      // An oversell after earlier valid sales nulls this whole basis book.
      await db.query(
        "UPDATE recent_swaps SET token_raw='101',amount1='-101' WHERE tx_hash=$1",
        [word(109)],
      );
      const oversell = await read(`/v1/wallets/${address(1)}?window=All`);
      assert.equal(oversell.wallet.realizedWei, null);
      assert.equal(oversell.wallet.rank, null);
      assert.equal(oversell.positions[0].modeledPosition, null);
      assert.ok(oversell.wallet.flags.includes("unknown_basis"));
      assert.deepEqual(oversell.curve, []);
      await db.query(
        "UPDATE recent_swaps SET token_raw='100',amount1='-100' WHERE tx_hash=$1",
        [word(109)],
      );
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',99,99,$1)",
        [word(99)],
      );
      await db.query(
        "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v1',99,99,$1,'fixture','{}')",
        [word(99)],
      );
      await db.query(
        "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Old','O',99,$3,$2,1000,'discovery:v1',99)",
        [word(2), address(2), word(222)],
      );
      await db.query(
        `INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
        SELECT 4663,200,$1,$2,'0x'||lpad(to_hex(2000+i),64,'0'),i,101+i,'0x'||lpad(to_hex(101+i),64,'0'),1001+i,$3,
          CASE WHEN i%2=0 THEN '-10' ELSE '20' END,CASE WHEN i%2=0 THEN '1' ELSE '-1' END,CASE WHEN i%2=0 THEN '10' ELSE '20' END,'1',CASE WHEN i%2=0 THEN 'buy' ELSE 'sell' END FROM generate_series(0,9) i`,
        [word(2), address(2), address(17)],
      );
      const late = await read(`/v1/wallets/${address(17)}?window=All`);
      assert.equal(late.wallet.realizedWei, null);
      assert.equal(late.wallet.netWei, "50");
      assert.equal(late.wallet.rank, null);
      assert.ok(late.wallet.flags.includes("late_history_start"));
      assert.equal(late.positions[0].modeledPosition, null);
      assert.equal((await read("/v1/leaderboard?window=All")).total, 16);
      // Retained unsupported logs can hide an acquisition; missing signs never
      // create a free-cost modeled lot or a realized leaderboard row.
      await db.query(
        "UPDATE recent_batches SET unsupported_swaps=1,evidence=$1 WHERE stream_key='swaps'",
        [
          {
            logs: Array.from({ length: 161 }, () => ({
              topics: [word(0), word(1)],
            })),
          },
        ],
      );
      assert.equal(
        (await read(`/v1/wallets/${address(16)}?window=All`)).wallet
          .realizedWei,
        null,
      );
      await db.query(
        "UPDATE recent_batches SET unsupported_swaps=0,evidence='{}' WHERE stream_key='swaps'",
      );
      await db.query(
        `INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
        SELECT 4663,200,$1,$2,'0x'||lpad(to_hex(10000+i),64,'0'),10000+i,120+i%2,'0x'||lpad(to_hex(120+i%2),64,'0'),CASE WHEN i%2=0 THEN 1100 ELSE 699900 END,$3,
          CASE WHEN i%2=0 THEN '-3' ELSE '5' END,CASE WHEN i%2=0 THEN '1' ELSE '-1' END,CASE WHEN i%2=0 THEN '3' ELSE '5' END,'1',CASE WHEN i%2=0 THEN 'buy' ELSE 'sell' END FROM generate_series(0,1999) i`,
        [word(1), address(1), address(18)],
      );
      const sampled = await read(`/v1/wallets/${address(18)}?window=All`);
      assert.equal(sampled.wallet.realizedWei, "2000");
      assert.equal(sampled.curve.at(-1).wei, "2000");
      assert.ok(sampled.curve.length <= 500);
      assert.equal(sampled.curveSampled, true);
      assert.equal(sampled.tradesTruncated, true);
      assert.equal(sampled.trades.length, 500);
      await db.query("DELETE FROM recent_batches WHERE stream_key='swaps'");
      assert.equal((await read("/v1/leaderboard?window=All")).total, 0);
      assert.equal(
        (await read(`/v1/wallets/${address(16)}?window=All`)).wallet
          .realizedWei,
        null,
      );
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
