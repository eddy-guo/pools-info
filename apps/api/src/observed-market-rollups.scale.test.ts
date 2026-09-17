import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  createClient,
  migrate,
  rebuildBroadMarket,
} from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createApi } from "./server";
import { readObservedMarket } from "./observed-market-read";
import {
  marketWord as word,
  marketAddress as address,
  marketFirst as first,
  seedBatches,
} from "../../../tests/support/broad-market-db";

// The reader budgets 3,000 ms per statement and serves a timeout as a 503.
// Production's busiest pool holds 81,927 broad swaps, and aggregating them
// per request took 6 to 8 s, so its page answered 503 (review D1). A pool
// whose cut is the canonical broad stream is now served from the batch
// summaries and one-second buckets; this file, a serial phase of
// `pnpm test:db`, seeds that many swaps for one pool, one per second so the
// fold has a bucket per swap (production's pool packs several swaps into a
// second and folds five times fewer), and bounds the served reads at a third
// of the budget on an idle database, as the 21k raw-path phase does.
const marketReadBudgetMs = 1000;
const swaps = 80000;
const batchBlocks = 5000;
const eth = 900719925474099300001n;

test(
  "a broad-selected pool's page at 80k swaps is served from the rollups inside the statement budget with margin",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL);
    await db.connect();
    const schema = "api_test_market_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    const reader = createReader(process.env.TEST_DATABASE_URL, schema),
      api = createApi(reader, { cacheMs: 0, maxPerMinute: 1000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    const last = first + swaps - 1,
      end = first + 199999;
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v2','discovery',$1,$2,$3)`,
      [first, end, word(end)],
    );
    await db.query(
      `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v2',$1,$2,$3,$4,'{}')`,
      [first, end, word(end), "a".repeat(64)],
    );
    await db.query(
      `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Busiest pool','BP',$3,$4,$5,100000,'discovery:v2',$6)`,
      [word(1), address(1), first, word(99), address(99), end],
    );
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,registry_revision,registry_source_revision,cursor_block,cursor_hash) VALUES(4663,'swaps:broad:v1','broad',$1,'robinhood-instant-v2','2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f',$2,$3)`,
      [first, last, word(last)],
    );
    // Sixteen 5,000-block batches, one swap per block and per second, the
    // sqrt price cycling so every minute's extremes differ from its open and
    // close; each batch's timestamp is its last swap's.
    const batches = `SELECT $1::bigint+lo AS from_block,$1::bigint+lo+${batchBlocks - 1} AS to_block,100001+lo+${batchBlocks - 1} AS timestamp
      FROM generate_series(0,${swaps - batchBlocks},${batchBlocks}) lo`;
    await db.query(
      `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
      SELECT 4663,'swaps:broad:v1',from_block,to_block,'0x'||lpad(to_hex(to_block),64,'0'),repeat('b',64),'{}' FROM (${batches}) b`,
      [first],
    );
    await db.query(
      `INSERT INTO broad_batches(chain_id,stream_key,batch_end,from_block,parent_hash,timestamp,discovery_stream,discovery_batch,discovery_hash,discovery_content_hash,serializer_version,serialized_group,observed_swaps,unregistered_swaps,unsupported_swaps)
      SELECT 4663,'swaps:broad:v1',to_block,from_block,'0x'||lpad(to_hex(from_block-1),64,'0'),timestamp,'discovery:v2',$2,$3,repeat('a',64),1,'{}',${batchBlocks},0,0 FROM (${batches}) b`,
      [first, end, word(end)],
    );
    await db.query(
      `INSERT INTO broad_registry_members SELECT 4663,'swaps:broad:v1',to_block,$2,'{}' FROM (${batches}) b`,
      [first, word(1)],
    );
    await seedBatches(0, swaps - 1, 1000, (lo, hi) =>
      db.query(
        `INSERT INTO broad_swaps
        SELECT 4663,'swaps:broad:v1',$1+(i/${batchBlocks})*${batchBlocks}+${batchBlocks - 1},$2,$3,'0x'||lpad(to_hex(i+1000),64,'0'),0,$1+i,'0x'||lpad(to_hex($1+i),64,'0'),
          100001+i,$4,$4,-$5::numeric,10,79228162514264337593543950336::numeric+(i%7)*1237940039285380274899124224::numeric,100,0,2500,'buy',$5::numeric,10,false,ARRAY['missing_transfer_history']
        FROM generate_series($6::integer,$7::integer) i`,
        [first, word(1), address(1), address(99), eth.toString(), lo, hi],
      ),
    );
    await db.query(
      `INSERT INTO broad_token_units VALUES(4663,'swaps:broad:v1',$1,$2,$1,$3,$4,18,100,$5,$6)`,
      [last, address(1), word(last), 100000 + swaps, word(18), word(100)],
    );
    const projected = performance.now();
    assert.deepEqual(await rebuildBroadMarket(db, 100), {
      rebuilt: swaps / batchBlocks,
      remaining: 0,
    });
    const buckets = (
      await db.query(
        "SELECT count(*)::integer AS buckets,(SELECT count(*) FROM broad_market_summaries)::integer AS summaries FROM broad_market_buckets",
      )
    ).rows[0];
    assert.deepEqual(buckets, {
      buckets: swaps,
      summaries: swaps / batchBlocks,
    });
    // Fresh statistics, so the plan is the one production's autoanalyze
    // settles on rather than the empty-table plan of a just-seeded fixture.
    await db.query(
      "ANALYZE indexed_pools,indexer_streams,indexer_batches,broad_batches,broad_registry_members,broad_swaps,broad_token_units,broad_market_batches,broad_market_summaries,broad_market_buckets,broad_market_conflicts,broad_market_recent_conflicts,pool_launch_sources,indexed_events,recent_streams,recent_batches,recent_swaps",
    );
    // Plan evidence for the CI log, printed rather than asserted: the cost
    // estimate against the JIT thresholds, the sort methods (an external sort
    // is a spill) and the JIT time a JIT-capable host spends on the statement.
    const pool = (await db.query("SELECT * FROM indexed_pools")).rows[0];
    let summary = "not captured";
    await db.query("BEGIN");
    await readObservedMarket(
      async (sql, values) => {
        if (!sql.startsWith("WITH flow")) return db.query(sql, values);
        const plan = (
          await db.query(
            "EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY) " + sql,
            values,
          )
        ).rows.map((row) => String(row["QUERY PLAN"]));
        const pick = (re: RegExp) =>
          plan.map((line) => line.match(re)?.[1]).find(Boolean) ?? "n/a";
        const sorts = [
          ...new Set(
            plan
              .map((line) => line.match(/Sort Method: (.+?)  /)?.[1])
              .filter(Boolean),
          ),
        ];
        summary = `cost=${plan[0]?.match(/cost=[\d.]+\.\.([\d.]+)/)?.[1] ?? "n/a"} planning=${pick(/^Planning Time: ([\d.]+) ms/)}ms execution=${pick(/^Execution Time: ([\d.]+) ms/)}ms sorts=${sorts.join("|") || "none"} temp=${pick(/temp read=(\d+)/)} jitFunctions=${pick(/^\s*Functions: (\d+)/)} jitTotal=${pick(/Timing: .*Total ([\d.]+) ms/)}ms`;
        return db.query(sql, values);
      },
      pool,
      "All",
      null,
    );
    await db.query("COMMIT");
    assert.notEqual(summary, "not captured");
    // The fold hashes the pool's buckets by minute and never spills: an
    // external sort or a temp buffer here is the regression this file guards.
    assert(
      !summary.includes("external") && summary.includes(" temp=n/a "),
      summary,
    );
    const settings = (
      await db.query(
        "SELECT version() AS version,current_setting('jit') AS jit,current_setting('jit_above_cost') AS above,current_setting('work_mem') AS work_mem",
      )
    ).rows[0];
    process.stdout.write(
      `postgres: ${settings.version}; jit=${settings.jit} jit_above_cost=${settings.above} work_mem=${settings.work_mem}; cpus=${availableParallelism()}\n80k swap projection: ${(performance.now() - projected).toFixed(0)}ms for ${buckets.buckets} buckets\n80k swap rollup statement: ${summary}\n`,
    );
    // The served reads, through the reader's own statement budget: every
    // window the page offers, the whole history and the hour twice.
    const timed = async (window: string) => {
      const started = performance.now();
      const response = await fetch(
        `${base}/v1/pools/${word(1)}?window=${window}`,
      );
      const data = (await response.json()) as any;
      return {
        window,
        status: response.status,
        data,
        ms: performance.now() - started,
      };
    };
    const reads = [];
    for (const window of ["All", "24h", "7d", "30d", "1h", "All", "1h"])
      reads.push(await timed(window));
    for (const read of reads)
      assert.equal(read.status, 200, JSON.stringify(read.data));
    const [all, day, , , hour] = reads;
    assert.equal(all.data.market.trades, swaps);
    assert.equal(all.data.market.volumeWei, (BigInt(swaps) * eth).toString());
    // The last swap's sqrt price is 67 * 2^90: 2^12 * 10^18 / 67^2, truncated.
    assert.equal(all.data.market.priceWei, "912452662062820227");
    assert.equal(all.data.market.history.candles.length, 1000);
    assert.equal(all.data.market.history.truncated, true);
    assert.equal(all.data.market.observations.length, 50);
    assert.equal(all.data.market.coverage.completeWindow, true);
    assert.equal(day.data.market.trades, swaps);
    // The cutoff is the last swap's second, so the hour holds 3,601 swaps and
    // its baseline is the swap of the second before the window.
    const asOf = 100000 + swaps,
      hourTrades = 3601;
    assert.equal(hour.data.market.coverage.cutoff.asOf, asOf);
    assert.equal(hour.data.market.trades, hourTrades);
    assert.equal(
      hour.data.market.volumeWei,
      (BigInt(hourTrades) * eth).toString(),
    );
    assert.equal(hour.data.market.coverage.priceBaseline.asOf, asOf - 3601);
    assert.equal(hour.data.market.coverage.completeWindow, true);
    process.stdout.write(
      `80k swap pool page serving: ${reads.map((r) => `${r.window}=${r.ms.toFixed(1)}ms`).join(" ")}\n`,
    );
    for (const read of reads)
      assert(
        read.ms < marketReadBudgetMs,
        `80k swap pool page read (${read.window}) exceeded ${marketReadBudgetMs}ms: ${read.ms.toFixed(1)}ms`,
      );
  },
);
