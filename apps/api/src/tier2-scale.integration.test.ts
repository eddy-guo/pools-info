import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { createReader, readData } from "./reader";
import { parseRequest } from "./request";

test(
  "tier2 complete ranking stays bounded over 115k swaps and 52k registry pools",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_tier2_scale_" + randomBytes(8).toString("hex"),
      db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      const dir = new URL("../../../packages/db/migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await db.query(await readFile(new URL(name, dir), "utf8"));
      const hash = "0x" + "2".repeat(64);
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',100,200,$1)",
        [hash],
      );
      await db.query(
        "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v1',100,200,$1,'fixture','{}')",
        [hash],
      );
      await db.query(`INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
   SELECT 4663,'0x'||lpad(to_hex(i),64,'0'),'0x'||lpad(to_hex(i),40,'0'),'Scale','S',100,'0x'||lpad(to_hex(i+1000000),64,'0'),'0x'||lpad(to_hex(i),40,'0'),1000,'discovery:v1',200 FROM generate_series(1,52000) i`);
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'discovery',100,200,$1,600000),(4663,'swaps',100,200,$1,600000)",
        [hash],
      );
      for (const stream of ["discovery", "swaps"])
        await db.query(
          "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,$1,100,200,$2,600000,'fixture','{}')",
          [stream, hash],
        );
      await db.query(`INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
   SELECT 4663,200,'0x'||lpad(to_hex((i/10)%285+1),64,'0'),'0x'||lpad(to_hex((i/10)%285+1),40,'0'),
    '0x'||lpad(to_hex(i+2000000),64,'0'),i,101+i%10,'0x'||lpad(to_hex(101+i%10),64,'0'),1001+i%10,
    '0x'||lpad(to_hex(100000+i/10),40,'0'),CASE WHEN i=0 THEN '-000900719925474099300001' WHEN i%2=0 THEN '-900719925474099300001' ELSE '900719925474099300003' END,
    CASE WHEN i%2=0 THEN '1' ELSE '-1' END,CASE WHEN i%2=0 THEN '900719925474099300001' ELSE '900719925474099300003' END,'1',CASE WHEN i%2=0 THEN 'buy' ELSE 'sell' END
    FROM generate_series(0,114999) i`);
      await db.query("ANALYZE indexed_pools");
      await db.query("ANALYZE recent_swaps");
      const timings = new Map<
        string,
        { milliseconds: number; rows: number; calls: number }
      >();
      let cursorSql = "";
      const measuredRead = async (request: ReturnType<typeof parseRequest>) => {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          return await readData(async (sql, values) => {
            const phase = sql.startsWith("FETCH")
              ? "fetch"
              : sql.startsWith("DECLARE")
                ? "declare"
                : sql.includes("AS metadata FROM books")
                  ? "metadata"
                  : "other";
            if (phase === "declare")
              cursorSql = sql.replace(
                /^DECLARE tier2_ledger NO SCROLL CURSOR FOR /,
                "",
              );
            const start = performance.now();
            const result = await db.query(sql, values);
            const timing = timings.get(phase) ?? {
              milliseconds: 0,
              rows: 0,
              calls: 0,
            };
            timing.milliseconds += performance.now() - start;
            timing.rows += result.rows.length;
            timing.calls++;
            timings.set(phase, timing);
            return result;
          }, request);
        } finally {
          await db.query("ROLLBACK");
        }
      };
      // Both windows include the full fixture. Three complete requests expose
      // first-read and warm behavior without hiding monetary work in a cache.
      for (const [index, url] of [
        "/v1/leaderboard?limit=25",
        "/v1/leaderboard?limit=25",
        "/v1/leaderboard?window=All&limit=25",
      ].entries()) {
        timings.clear();
        const request = parseRequest(url);
        const start = performance.now();
        const board = (await (process.env.TIER2_PROFILE ||
        process.env.TIER2_EXPLAIN
          ? measuredRead(request)
          : reader.read(request))) as any;
        const elapsed = performance.now() - start;
        assert.equal(board.total, 11500);
        assert.equal(board.items.length, 25);
        for (const wallet of board.items) {
          assert.equal(wallet.realizedWei, "10");
          assert.equal(wallet.rankingTradeCount, 10);
          assert.equal(wallet.accountingTier, "tier2");
        }
        assert.equal(board.coverage.catalogPools, 52000);
        assert.equal(board.coverage.tier2Pools, 285);
        if (process.env.TIER2_PROFILE || process.env.TIER2_EXPLAIN) {
          assert.equal(timings.get("fetch")?.rows, 115000);
          console.log("tier2 phases", Object.fromEntries(timings));
          console.log(
            "tier2 fold/composition milliseconds",
            elapsed -
              [...timings.values()].reduce((sum, t) => sum + t.milliseconds, 0),
          );
        }
        // Keep 800ms headroom below the unchanged runtime accounting budget.
        assert.ok(
          elapsed < 2000,
          `Complete 115k accounting request ${index + 1} took ${Math.round(elapsed)}ms`,
        );
        console.log(
          `tier2 115k/52k complete read ${index + 1} (${request.leaderboard?.window}): ${Math.round(elapsed)}ms`,
        );
      }
      if (process.env.TIER2_EXPLAIN && cursorSql) {
        const plan = await db.query(
          "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + cursorSql,
        );
        await writeFile(
          process.env.TIER2_EXPLAIN,
          JSON.stringify(plan.rows[0]["QUERY PLAN"]),
        );
      }
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
