import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { beginRead, readData } from "./reader";
import { parseRequest } from "./request";

// Tier-2 read cost depends on the server as much as the data: Debian postgres
// images compile large plans with LLVM while Homebrew builds cannot, which hid
// the 2026-09-15 CI statement timeout from every local run. Each log therefore
// states the server facts, plan costs and per-phase timings as single lines.
// Opt-in switches: TIER2_JIT=on,off first runs every listed mode with the
// statement timeout lifted and only reports it; TIER2_EXPLAIN=1 prints one
// EXPLAIN ANALYZE summary per statement and mode, and any other value is a
// path prefix that also receives the JSON plans.

const facts = (fields: Record<string, unknown>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
const ms = (n: number) => `${Math.round(n)}ms`;
const serverFacts = `SELECT current_setting('server_version') AS server_version,current_setting('jit') AS jit,pg_jit_available() AS jit_available,
  current_setting('jit_above_cost') AS jit_above_cost,current_setting('jit_inline_above_cost') AS jit_inline_above_cost,
  current_setting('jit_optimize_above_cost') AS jit_optimize_above_cost,current_setting('shared_buffers') AS shared_buffers,
  current_setting('work_mem') AS work_mem,current_setting('max_parallel_workers_per_gather') AS parallel_workers`;

function planSummary(plan: any) {
  const root = Array.isArray(plan) ? plan[0] : plan;
  let tempBlocks = 0;
  const walk = (node: any) => {
    tempBlocks +=
      (node["Temp Read Blocks"] ?? 0) + (node["Temp Written Blocks"] ?? 0);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root.Plan);
  // PostgreSQL 17 nests generation timing as {Deform, Total}.
  const timing = (value: any) =>
    ms(typeof value === "number" ? value : (value?.Total ?? 0));
  const jit = root.JIT;
  return facts({
    cost: root.Plan["Total Cost"],
    planning: ms(root["Planning Time"] ?? 0),
    execution: ms(root["Execution Time"] ?? 0),
    temp_blocks: tempBlocks,
    jit_functions: jit?.Functions ?? 0,
    ...(jit
      ? {
          jit_generation: timing(jit.Timing.Generation),
          jit_inlining: timing(jit.Timing.Inlining),
          jit_optimization: timing(jit.Timing.Optimization),
          jit_emission: timing(jit.Timing.Emission),
          jit_total: timing(jit.Timing.Total),
        }
      : {}),
  });
}

test(
  "tier2 complete ranking stays bounded over 115k swaps and 52k registry pools",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_tier2_scale_" + randomBytes(8).toString("hex"),
      db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    const modes = (process.env.TIER2_JIT?.split(",") ?? []).map((mode) => {
      if (mode !== "on" && mode !== "off")
        throw Error(`TIER2_JIT accepts on and off, not ${mode}`);
      return mode;
    });
    const explain = process.env.TIER2_EXPLAIN;
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
      console.log("tier2 server", facts((await db.query(serverFacts)).rows[0]));
      const statements = new Map<string, string>();
      // Both windows include the full fixture. Three complete requests expose
      // first-read and warm behavior without hiding monetary work in a cache.
      // Every read runs through the production transaction preamble.
      const urls = [
        "/v1/leaderboard?limit=25",
        "/v1/leaderboard?limit=25",
        "/v1/leaderboard?window=All&limit=25",
      ];
      for (const mode of [...modes, null])
        for (const [index, url] of urls.entries()) {
          const request = parseRequest(url);
          const timings = new Map<
            string,
            { milliseconds: number; rows: number; calls: number }
          >();
          const phaseOf = (sql: string) =>
            sql.startsWith("FETCH")
              ? "fetch"
              : sql.startsWith("DECLARE")
                ? "declare"
                : sql.includes("AS metadata FROM books")
                  ? "metadata"
                  : "other";
          const query = async (sql: string, values?: unknown[]) => {
            const phase = phaseOf(sql);
            if (phase === "metadata" || phase === "declare")
              statements.set(phase, sql);
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
          };
          const phase = (name: string) =>
            timings.get(name) ?? { milliseconds: 0, rows: 0, calls: 0 };
          let board: any = null,
            failure: string | null = null;
          const started = performance.now();
          try {
            await beginRead((sql) => db.query(sql));
            if (mode) {
              await db.query(`SET LOCAL jit = ${mode}`);
              await db.query("SET LOCAL statement_timeout = 0");
            }
            board = await readData(query, request);
          } catch (error: any) {
            failure = error.code ?? error.message;
          } finally {
            await db.query("ROLLBACK");
          }
          const elapsed = performance.now() - started;
          const measured = [...timings.values()].reduce(
            (sum, t) => sum + t.milliseconds,
            0,
          );
          console.log(
            `tier2 read ${index + 1}`,
            facts({
              window: request.leaderboard?.window,
              jit: mode ?? "default",
              total: ms(elapsed),
              other: ms(phase("other").milliseconds),
              metadata: ms(phase("metadata").milliseconds),
              declare: ms(phase("declare").milliseconds),
              fetch: ms(phase("fetch").milliseconds),
              fetch_rows: phase("fetch").rows,
              fetch_calls: phase("fetch").calls,
              fold: ms(elapsed - measured),
              ...(failure ? { error: failure } : {}),
            }),
          );
          if (mode) continue;
          assert.equal(failure, null, `Complete read ${index + 1}: ${failure}`);
          assert.equal(board.total, 11500);
          assert.equal(board.items.length, 25);
          for (const wallet of board.items) {
            assert.equal(wallet.realizedWei, "10");
            assert.equal(wallet.rankingTradeCount, 10);
            assert.equal(wallet.accountingTier, "tier2");
          }
          assert.equal(board.coverage.catalogPools, 52000);
          assert.equal(board.coverage.tier2Pools, 285);
          assert.equal(phase("fetch").rows, 115000);
          // Keep 800ms headroom below the unchanged runtime accounting budget.
          assert.ok(
            elapsed < 2000,
            `Complete 115k accounting request ${index + 1} took ${Math.round(elapsed)}ms`,
          );
        }
      // Estimated costs decide JIT eligibility, so they are stated in every log.
      for (const [name, sql] of statements) {
        await beginRead((statement) => db.query(statement));
        try {
          const plan = (await db.query("EXPLAIN (FORMAT JSON) " + sql)).rows[0][
            "QUERY PLAN"
          ];
          console.log(`tier2 plan ${name}`, planSummary(plan));
        } finally {
          await db.query("ROLLBACK");
        }
      }
      if (explain)
        for (const mode of [...modes, null])
          for (const [name, sql] of statements) {
            await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            try {
              await db.query("SET LOCAL statement_timeout = 0");
              if (mode) await db.query(`SET LOCAL jit = ${mode}`);
              const plan = (
                await db.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)
              ).rows[0]["QUERY PLAN"];
              console.log(
                `tier2 explain ${name}`,
                facts({ jit: mode ?? "default" }),
                planSummary(plan),
              );
              if (explain !== "1")
                await writeFile(
                  `${explain}.${name}.${mode ?? "default"}.json`,
                  JSON.stringify(plan),
                );
            } finally {
              await db.query("ROLLBACK");
            }
          }
    } finally {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
