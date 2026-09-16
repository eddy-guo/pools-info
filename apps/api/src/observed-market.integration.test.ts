import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { applyTestMigrations } from "./test-migrations";
import pg from "pg";
import { createReader } from "./reader";
import { createApi } from "./server";
import { readObservedMarket } from "./observed-market-read";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const first = 22754669;
test(
  "Postgres HTTP: broad market coverage, canonical overlaps/conflicts, boundaries, unsupported signs and rewind",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_market_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    const api = createApi(reader);
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as { port: number }).port;
    const get = async (window = "24h") => {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/pools/${word(1)}?window=${window}`,
      );
      return { status: response.status, data: (await response.json()) as any };
    };
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      await applyTestMigrations(db);
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v2','discovery',$1,$2,$3)`,
        [first, first + 29999, word(first + 29999)],
      );
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v2',$1,$2,$3,$4,'{}')`,
        [first, first + 29999, word(first + 29999), "a".repeat(64)],
      );
      await db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Broad token','BT',$3,$4,$5,100000,'discovery:v2',$6)`,
        [word(1), address(1), first, word(99), address(99), first + 29999],
      );
      let page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.trades, null);
      assert.equal(page.data.market.volumeWei, null);
      assert.equal(page.data.market.coverage.cutoff, null);
      assert.equal(page.data.analytics, null);
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,registry_revision,registry_source_revision) VALUES(4663,'swaps:broad:v1','broad',$1,'robinhood-instant-v2','2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f')`,
        [first],
      );
      const batch = async (
        from: number,
        end: number,
        time: number,
        count: number,
      ) => {
        await db.query(
          `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,'{}')`,
          [from, end, word(end), "b".repeat(64)],
        );
        await db.query(
          `INSERT INTO broad_batches(chain_id,stream_key,batch_end,from_block,parent_hash,timestamp,discovery_stream,discovery_batch,discovery_hash,discovery_content_hash,serializer_version,serialized_group,observed_swaps,unregistered_swaps,unsupported_swaps) VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,'discovery:v2',$5,$6,$7,1,'{}',$8,0,0)`,
          [
            end,
            from,
            word(from - 1),
            time,
            first + 29999,
            word(first + 29999),
            "a".repeat(64),
            count,
          ],
        );
        await db.query(
          `INSERT INTO broad_registry_members VALUES(4663,'swaps:broad:v1',$1,$2,'{}')`,
          [end, word(1)],
        );
        await db.query(
          `UPDATE indexer_streams SET cursor_block=$1,cursor_hash=$2 WHERE stream_key='swaps:broad:v1'`,
          [end, word(end)],
        );
      };
      await batch(first, first, 113599, 1);
      await batch(first + 1, first + 1, 113600, 1);
      await batch(first + 2, first + 9, 200000, 1);
      const insert = async (
        tx: number,
        block: number,
        time: number,
        eth: string,
      ) =>
        db.query(
          `INSERT INTO broad_swaps VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,0,$5,$6,$7,$8,$8,$9,10,79228162514264337593543950336,100,0,2500,'buy',$10,10,false,ARRAY['missing_transfer_history'])`,
          [
            first + 9,
            word(1),
            address(1),
            word(tx),
            block,
            word(block),
            time,
            address(99),
            "-" + eth,
            eth,
          ],
        );
      await insert(10, first, 113599, "900719925474099300001");
      await insert(11, first + 1, 113600, "900719925474099300003");
      await insert(12, first + 9, 200000, "7");
      await readObservedMarket(
        (sql, values) => db.query(sql, values),
        (await db.query("SELECT * FROM indexed_pools")).rows[0],
        "24h",
        null,
      );
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.trades, 2);
      assert.equal(page.data.market.volumeWei, "900719925474099300010");
      assert.equal(page.data.market.priceWei, null);
      assert.equal(page.data.market.coverage.windowStart, 113600);
      assert.equal(page.data.market.coverage.completeWindow, false);
      assert.equal(page.data.market.coverage.cutoff.hash, word(first + 9));
      const pool = (await db.query("SELECT * FROM indexed_pools")).rows[0];
      const units = async () =>
        db.query(
          `INSERT INTO broad_token_units SELECT bb.chain_id,bb.stream_key,bb.batch_end,$1,bb.batch_end,ib.block_hash,bb.timestamp,18,0,$2,$3 FROM broad_batches bb JOIN indexer_batches ib ON ib.chain_id=bb.chain_id AND ib.stream_key=bb.stream_key AND ib.to_block=bb.batch_end ON CONFLICT DO NOTHING`,
          [address(1), word(18), word(0)],
        );
      await units();
      let priced = await readObservedMarket(
        (sql, values) => db.query(sql, values),
        pool,
        "24h",
        null,
      );
      assert.equal(priced.priceWei, "1000000000000000000");
      assert.equal(priced.coverage.priceBaseline?.asOf, 113599);
      assert.equal(priced.coverage.completeWindow, true);
      assert.equal(priced.history.candles.length, 2);
      await batch(first + 10, first + 10, 200100, 0);
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.priceWei, "1000000000000000000");
      assert.equal(page.data.market.coverage.cutoff.block, first + 10);
      assert.equal(page.data.market.coverage.unitBasis.block, first + 9);
      assert.equal(page.data.market.history.candles.length, 2);
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='swaps:broad:v1' AND to_block=$1",
        [first + 10],
      );
      await db.query("DELETE FROM broad_token_units WHERE batch_end=$1", [
        first + 9,
      ]);
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.priceWei, "1000000000000000000");
      assert.equal(page.data.market.coverage.unitBasis.block, first + 1);
      assert.equal(page.data.market.history.candles.length, 2);
      assert.equal(page.data.market.trades, 2);
      await db.query("DELETE FROM broad_token_units");
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.priceWei, null);
      assert.equal(page.data.market.coverage.unitBasis, null);
      assert.equal(page.data.market.history.candles.length, 0);
      await units();
      await db.query(
        "UPDATE broad_token_units SET decimals=6,decimals_result=$1 WHERE batch_end=$2",
        [word(6), first],
      );
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.priceWei, null);
      assert.equal(page.data.market.coverage.unitsConflict, true);
      assert.equal(page.data.market.volumeWei, "900719925474099300010");
      await db.query(
        "UPDATE broad_token_units SET decimals=0,decimals_result=$1",
        [word(0)],
      );
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.decimals, 0);
      assert.equal(page.data.market.priceWei, "1");
      await db.query(
        "UPDATE broad_token_units SET decimals=18,decimals_result=$1",
        [word(18)],
      );
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'pool',$2,$3,$4,$5)`,
        ["pool:" + word(1), word(1), first, first + 9, word(first + 9)],
      );
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,$1,$2,$3,$4,'deep',$5)`,
        [
          "pool:" + word(1),
          first,
          first + 9,
          word(first + 9),
          JSON.stringify({
            headers: [
              { number: first + 9, hash: word(first + 9), timestamp: 200000 },
            ],
          }),
        ],
      );
      await db.query(
        `INSERT INTO indexed_events(chain_id,stream_key,batch_end,tx_hash,log_index,block_number,block_hash,timestamp,kind,pool_id,token,transaction_sender,payload) SELECT chain_id,$1,$2,tx_hash,log_index,block_number,block_hash,timestamp,'swap',pool_id,token,transaction_sender,jsonb_build_object('decoded',jsonb_build_object('amount0',amount0::text,'amount1',amount1::text,'side',side,'ethWei',eth_wei::text,'sqrtPriceX96',sqrt_price_x96::text)) FROM broad_swaps`,
        ["pool:" + word(1), first + 9],
      );
      await db.query(
        `INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'swaps',$1,$2,$3,200000)`,
        [first, first + 9, word(first + 9)],
      );
      await db.query(
        `INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'swaps',$1,$2,$3,200000,'recent','{}')`,
        [first, first + 9, word(first + 9)],
      );
      await db.query(
        `INSERT INTO recent_swaps SELECT chain_id,'swaps',22754678,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0::text,amount1::text,eth_wei::text,token_raw::text,side FROM broad_swaps`,
      );
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.trades, 2);
      assert.equal(page.data.market.observations.length, 3);
      await db.query(
        `UPDATE indexed_events SET payload=jsonb_set(payload,'{decoded,sqrtPriceX96}','"2"') WHERE tx_hash=$1`,
        [word(12)],
      );
      page = await get();
      assert.equal(page.status, 503);
      assert.equal(page.data.error, "market_identity_conflict");
      await db.query(
        `UPDATE indexed_events SET payload=jsonb_set(payload,'{decoded,sqrtPriceX96}','"79228162514264337593543950336"') WHERE tx_hash=$1`,
        [word(12)],
      );
      for (const assignment of [
        `pool_id='${word(2)}'`,
        `token='${address(2)}'`,
        `block_hash='${word(2)}'`,
        `amount0='-8',eth_wei='8'`,
      ]) {
        await db.query(
          `UPDATE recent_swaps SET ${assignment} WHERE tx_hash=$1`,
          [word(12)],
        );
        page = await get();
        assert.equal(page.status, 503);
        assert.equal(page.data.error, "market_identity_conflict");
        await db.query(
          "UPDATE recent_swaps e SET pool_id=b.pool_id,token=b.token,block_hash=b.block_hash,amount0=b.amount0::text,eth_wei=b.eth_wei::text FROM broad_swaps b WHERE e.tx_hash=b.tx_hash AND e.log_index=b.log_index",
        );
      }
      await db.query("DELETE FROM indexed_events");
      await db.query("DELETE FROM recent_swaps");
      await db.query(
        `UPDATE broad_swaps SET amount0=0,amount1=0,side=NULL,eth_wei=NULL,token_raw=NULL,flags=ARRAY['missing_transfer_history','unsupported_swap_signs'] WHERE tx_hash=$1`,
        [word(12)],
      );
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.trades, 2);
      assert.equal(page.data.market.volumeWei, null);
      assert.equal(page.data.market.priceWei, null);
      priced = await readObservedMarket(
        (sql, values) => db.query(sql, values),
        pool,
        "24h",
        null,
      );
      assert.equal(priced.priceWei, null);
      assert.equal(priced.coverage.completeWindow, false);
      await db.query("DELETE FROM indexed_events");
      await db.query("DELETE FROM indexer_streams WHERE kind='pool'");
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='swaps:broad:v1'",
      );
      await batch(first, first + 9999, 100000 + 9999 * 60, 10000);
      await batch(first + 10000, first + 19999, 100000 + 19999 * 60, 10000);
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
        SELECT 4663,'swaps:broad:v1',$1+n,$1+n,'0x'||lpad(to_hex($1+n),64,'0'),repeat('b',64),'{}' FROM generate_series(20000,21000) n`,
        [first],
      );
      await db.query(
        `INSERT INTO broad_batches(chain_id,stream_key,batch_end,from_block,parent_hash,timestamp,discovery_stream,discovery_batch,discovery_hash,discovery_content_hash,serializer_version,serialized_group,observed_swaps,unregistered_swaps,unsupported_swaps)
        SELECT 4663,'swaps:broad:v1',$1+n,$1+n,'0x'||lpad(to_hex($1+n-1),64,'0'),100000+n*60,'discovery:v2',$1+29999,$2,repeat('a',64),1,'{}',1,0,0 FROM generate_series(20000,21000) n`,
        [first, word(first + 29999)],
      );
      await db.query(
        `INSERT INTO broad_registry_members SELECT 4663,'swaps:broad:v1',$1+n,$2,'{}' FROM generate_series(20000,21000) n`,
        [first, word(1)],
      );
      await db.query(
        `UPDATE indexer_streams SET cursor_block=$1,cursor_hash=$2 WHERE stream_key='swaps:broad:v1'`,
        [first + 21000, word(first + 21000)],
      );
      await db.query(
        `INSERT INTO broad_swaps SELECT 4663,'swaps:broad:v1',$1+CASE WHEN n<10000 THEN 9999 WHEN n<20000 THEN 19999 ELSE n END,$2,$3,'0x'||lpad(to_hex(n+1000),64,'0'),0,$1+n,'0x'||lpad(to_hex($1+n),64,'0'),100000+n*60,$4,$4,-900719925474099300001,10,79228162514264337593543950336,100,0,2500,'buy',900719925474099300001,10,false,ARRAY['missing_transfer_history'] FROM generate_series(0,21000) n`,
        [first, word(1), address(1), address(99)],
      );
      await units();
      page = await get("All");
      assert.equal(page.status, 200);
      assert.equal(page.data.market.observations.length, 50);
      assert.equal(page.data.market.trades, 21001);
      assert.equal(
        page.data.market.volumeWei,
        (21001n * 900719925474099300001n).toString(),
      );
      assert.equal(page.data.market.history.candles.length, 1000);
      page = await get();
      const expectedWindow = Math.floor(
        (100000 + 21000 * 60 - 86400 - 100000) / 60,
      );
      assert.equal(
        page.data.market.trades,
        Math.max(0, 21001 - expectedWindow),
      );
      priced = await readObservedMarket(
        (sql, values) => db.query(sql, values),
        pool,
        "All",
        null,
      );
      assert.equal(priced.trades, 21001);
      assert.equal(
        priced.volumeWei,
        (21001n * 900719925474099300001n).toString(),
      );
      assert.equal(priced.history.candles.length, 1000);
      assert.equal(priced.history.truncated, true);
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',$1,$2,$3)`,
        [first, first + 29999, word(first + 29999)],
      );
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v1',$1,$2,$3,'v1','{}')`,
        [first, first + 29999, word(first + 29999)],
      );
      await db.query(
        `INSERT INTO pool_launch_sources(chain_id,pool_id,stream_key,batch_end) VALUES(4663,$1,'discovery:v1',$2)`,
        [word(1), first + 29999],
      );
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='discovery:v2'",
      );
      page = await get();
      assert.equal(page.status, 200);
      assert.equal(page.data.market.trades, null);
      assert.equal(page.data.market.volumeWei, null);
      assert.equal(page.data.market.coverage.completeWindow, false);
      assert.equal(
        (await db.query("SELECT count(*) AS n FROM broad_token_units")).rows[0]
          .n,
        "0",
      );
      assert.equal(
        (await db.query("SELECT count(*) AS n FROM broad_swaps")).rows[0].n,
        "0",
      );
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='discovery:v1'",
      );
      page = await get();
      assert.equal(page.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
