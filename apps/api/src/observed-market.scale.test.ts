import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { createClient, migrate } from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createApi } from "./server";
import { literal, readObservedMarket } from "./observed-market-read";
import {
  marketWord as word,
  marketAddress as address,
  marketFirst as first,
} from "../../../tests/support/broad-market-db";

// The reader budgets 3,000 ms per statement and serves a timeout as a 503. A
// pool page aggregates the pool's whole canonical history per request, so the
// read at the market suite's deepest fixture (21,001 swaps, one per minute,
// as in observed-market.integration.test.ts) must finish well inside that
// budget on an idle database. This file is a serial phase of `pnpm test:db`:
// the concurrent phase shares the runner's CPUs between test files, and there
// the same read timed out on CI's public runner while its bounded-repetition
// regexes cost 1.0 to 1.9 s per statement. A bound of a third of the budget
// leaves that contention its margin.
const marketReadBudgetMs = 1000;

test(
  "the read's literal predicates accept exactly what the bounded regexes accept",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = createClient(process.env.TEST_DATABASE_URL);
    await db.connect();
    try {
      const digits = (n: number) => "9".repeat(n);
      const inputs = [
        "0",
        "-0",
        "00",
        "-",
        "--1",
        "",
        "1",
        "-1",
        "01",
        "-01",
        "+1",
        "1.0",
        "1e5",
        " 1",
        "1 ",
        "1\n",
        "-1\n",
        digits(96),
        digits(97),
        "-" + digits(96),
        "-" + digits(97),
        "1" + "0".repeat(95),
        "1" + "0".repeat(96),
        "0x",
        "0x" + "a".repeat(64),
        "0x" + "a".repeat(63),
        "0x" + "a".repeat(65),
        "0X" + "a".repeat(64),
        "0x" + "A".repeat(64),
        "0x" + "g".repeat(64),
        "0x" + "a".repeat(63) + "\n",
        " 0x" + "a".repeat(64),
        "a".repeat(66),
      ];
      const result = await db.query(
        `SELECT t,
          (t ~ '^(0|-?[1-9][0-9]{0,95})$') IS DISTINCT FROM (${literal.signed("t")}) AS signed,
          (t ~ '^(0|[1-9][0-9]{0,95})$') IS DISTINCT FROM (${literal.unsigned("t")}) AS unsigned,
          (t ~ '^[1-9][0-9]{0,95}$') IS DISTINCT FROM (${literal.positive("t")}) AS positive,
          (t !~ '^0x[0-9a-f]{64}$') IS DISTINCT FROM NOT (${literal.hash("t")}) AS hash
        FROM unnest($1::text[]) t`,
        [inputs],
      );
      assert.equal(result.rows.length, inputs.length);
      assert.deepEqual(
        result.rows.filter(
          (r) => r.signed || r.unsigned || r.positive || r.hash,
        ),
        [],
      );
      const nulls = await db.query(
        `SELECT (NULL::text ~ '^(0|-?[1-9][0-9]{0,95})$') IS DISTINCT FROM (${literal.signed("NULL::text")}) AS signed,
          (NULL::text !~ '^0x[0-9a-f]{64}$') IS DISTINCT FROM NOT (${literal.hash("NULL::text")}) AS hash`,
      );
      assert.deepEqual(nulls.rows, [{ signed: false, hash: false }]);
    } finally {
      await db.end();
    }
  },
);

test(
  "a pool's market read at 21k swaps fits the statement budget with margin",
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
    const end = first + 29999;
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v2','discovery',$1,$2,$3)`,
      [first, end, word(end)],
    );
    await db.query(
      `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v2',$1,$2,$3,$4,'{}')`,
      [first, end, word(end), "a".repeat(64)],
    );
    await db.query(
      `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Broad token','BT',$3,$4,$5,100000,'discovery:v2',$6)`,
      [word(1), address(1), first, word(99), address(99), end],
    );
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,registry_revision,registry_source_revision,cursor_block,cursor_hash) VALUES(4663,'swaps:broad:v1','broad',$1,'robinhood-instant-v2','2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f',$2,$3)`,
      [first, first + 21000, word(first + 21000)],
    );
    // Two 10,000-block batches, then one batch per block: the integration
    // suite's deepest coverage shape, with every swap in its own minute.
    const batches = `SELECT $1::bigint+lo AS from_block,$1::bigint+hi AS to_block,100000+hi*60 AS timestamp,hi-lo+1 AS swaps
      FROM (SELECT 0 AS lo,9999 AS hi UNION ALL SELECT 10000,19999 UNION ALL SELECT n,n FROM generate_series(20000,21000) n) ranges`;
    await db.query(
      `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
      SELECT 4663,'swaps:broad:v1',from_block,to_block,'0x'||lpad(to_hex(to_block),64,'0'),repeat('b',64),'{}' FROM (${batches}) b`,
      [first],
    );
    await db.query(
      `INSERT INTO broad_batches(chain_id,stream_key,batch_end,from_block,parent_hash,timestamp,discovery_stream,discovery_batch,discovery_hash,discovery_content_hash,serializer_version,serialized_group,observed_swaps,unregistered_swaps,unsupported_swaps)
      SELECT 4663,'swaps:broad:v1',to_block,from_block,'0x'||lpad(to_hex(from_block-1),64,'0'),timestamp,'discovery:v2',$2,$3,repeat('a',64),1,'{}',swaps,0,0 FROM (${batches}) b`,
      [first, end, word(end)],
    );
    await db.query(
      `INSERT INTO broad_registry_members SELECT 4663,'swaps:broad:v1',to_block,$2,'{}' FROM (${batches}) b`,
      [first, word(1)],
    );
    await db.query(
      `INSERT INTO broad_swaps SELECT 4663,'swaps:broad:v1',$1+CASE WHEN n<10000 THEN 9999 WHEN n<20000 THEN 19999 ELSE n END,$2,$3,'0x'||lpad(to_hex(n+1000),64,'0'),0,$1+n,'0x'||lpad(to_hex($1+n),64,'0'),100000+n*60,$4,$4,-900719925474099300001,10,79228162514264337593543950336,100,0,2500,'buy',900719925474099300001,10,false,ARRAY['missing_transfer_history'] FROM generate_series(0,21000) n`,
      [first, word(1), address(1), address(99)],
    );
    await db.query(
      `INSERT INTO broad_token_units SELECT bb.chain_id,bb.stream_key,bb.batch_end,$1,bb.batch_end,ib.block_hash,bb.timestamp,18,0,$2,$3 FROM broad_batches bb JOIN indexer_batches ib ON ib.chain_id=bb.chain_id AND ib.stream_key=bb.stream_key AND ib.to_block=bb.batch_end`,
      [address(1), word(18), word(0)],
    );
    // Fresh statistics, so the plan is the one production's autoanalyze
    // settles on rather than the empty-table plan of a just-seeded fixture.
    await db.query(
      "ANALYZE indexed_pools,indexer_streams,indexer_batches,broad_batches,broad_registry_members,broad_swaps,broad_token_units,pool_launch_sources,indexed_events,recent_streams,recent_batches,recent_swaps",
    );
    // Plan evidence for the CI log, printed rather than asserted: the cost
    // estimate against the JIT thresholds and the JIT time a JIT-capable host
    // (CI's stock container; not Homebrew) spends on the aggregate statement.
    const pool = (await db.query("SELECT * FROM indexed_pools")).rows[0];
    let summary = "not captured";
    await db.query("BEGIN");
    await readObservedMarket(
      async (sql, values) => {
        if (!sql.includes("WITH historical")) return db.query(sql, values);
        const plan = (
          await db.query("EXPLAIN (ANALYZE, SETTINGS, SUMMARY) " + sql, values)
        ).rows.map((row) => String(row["QUERY PLAN"]));
        const pick = (re: RegExp) =>
          plan.map((line) => line.match(re)?.[1]).find(Boolean) ?? "n/a";
        summary = `cost=${plan[0]?.match(/cost=[\d.]+\.\.([\d.]+)/)?.[1] ?? "n/a"} planning=${pick(/^Planning Time: ([\d.]+) ms/)}ms execution=${pick(/^Execution Time: ([\d.]+) ms/)}ms jitFunctions=${pick(/^\s*Functions: (\d+)/)} jitTotal=${pick(/Timing: .*Total ([\d.]+) ms/)}ms`;
        return db.query(sql, values);
      },
      pool,
      "All",
      null,
    );
    await db.query("COMMIT");
    const settings = (
      await db.query(
        "SELECT version() AS version,current_setting('jit') AS jit,current_setting('jit_above_cost') AS above,current_setting('jit_optimize_above_cost') AS optimize",
      )
    ).rows[0];
    process.stdout.write(
      `postgres: ${settings.version}; jit=${settings.jit} jit_above_cost=${settings.above} jit_optimize_above_cost=${settings.optimize}; cpus=${availableParallelism()}\n21k swap market statement: ${summary}\n`,
    );
    // The served reads, through the reader's own statement budget: the whole
    // history and the default day window, twice each.
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
    for (const window of ["All", "24h", "All", "24h"])
      reads.push(await timed(window));
    for (const read of reads)
      assert.equal(read.status, 200, JSON.stringify(read.data));
    const [all, day] = reads;
    assert.equal(all.data.market.trades, 21001);
    assert.equal(
      all.data.market.volumeWei,
      (21001n * 900719925474099300001n).toString(),
    );
    assert.equal(all.data.market.priceWei, "1000000000000000000");
    assert.equal(all.data.market.history.candles.length, 1000);
    assert.equal(all.data.market.history.truncated, true);
    assert.equal(all.data.market.observations.length, 50);
    assert.equal(day.data.market.trades, 1441);
    assert.equal(day.data.market.coverage.completeWindow, true);
    process.stdout.write(
      `21k swap market serving: ${reads.map((r) => `${r.window}=${r.ms.toFixed(1)}ms`).join(" ")}\n`,
    );
    for (const read of reads)
      assert(
        read.ms < marketReadBudgetMs,
        `21k swap market read (${read.window}) exceeded ${marketReadBudgetMs}ms: ${read.ms.toFixed(1)}ms`,
      );
  },
);
