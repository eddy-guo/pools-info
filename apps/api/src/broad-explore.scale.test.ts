import assert from "node:assert/strict";
import test from "node:test";
import type { AnalyticsPoolRow } from "@pools/core";
import {
  rebuildBroadMarket,
  rewind,
  getStream,
} from "../../../packages/db/src/index";
import { availableParallelism } from "node:os";
import { createReader } from "./reader";
import { createApi } from "./server";
import { readProjectedExplore } from "./projected-explore";
import {
  marketDatabase,
  marketUnits,
  marketWord as word,
  marketAddress as address,
  marketFirst as first,
  marketAmount,
  seedBatches,
} from "../../../tests/support/broad-market-db";

// The reader budgets 3,000 ms per statement. A complete 52k-pool catalog read
// must finish well inside that on CI's stock postgres:17 container. This file
// is the serial second phase of `pnpm test:db`, after the concurrent files, so
// the bound measures the query on an idle database rather than contention with
// other fixtures' seeding.
const catalogReadBudgetMs = 2000;

test(
  "canonical broad explore: bounded rebuild, exact full totals, units, stable pages, source selection and rewind",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const fixture = await marketDatabase(),
      { db, schema } = fixture;
    const reader = createReader(process.env.TEST_DATABASE_URL, schema),
      api = createApi(reader, { cacheMs: 0, maxPerMinute: 1000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      await fixture.close();
    });
    const get = async (q = "") => {
      const r = await fetch(base + "/v1/explore?" + q);
      return { status: r.status, data: (await r.json()) as any };
    };
    let page = await get("limit=1");
    assert.equal(page.status, 200);
    assert.equal(page.data.total, 31);
    assert.equal(page.data.items[0].stats.volumeWei, null);
    assert.deepEqual(await rebuildBroadMarket(db, 1), {
      rebuilt: 1,
      remaining: 2,
    });
    page = await get("q=Canonical&window=All");
    assert.equal(page.status, 200);
    assert.equal(page.data.items[0].stats.trades, 9000);
    assert.equal(page.data.broadMarketCutoff.rebuildPending, true);
    assert.equal(page.data.items[0].stats.priceWei, null);
    assert.deepEqual(await rebuildBroadMarket(db, 2), {
      rebuilt: 2,
      remaining: 0,
    });
    page = await get("q=Canonical&window=24h");
    assert.equal(page.status, 200);
    assert.equal(page.data.items[0].stats.trades, 21000);
    assert.equal(
      page.data.items[0].stats.volumeWei,
      (BigInt(marketAmount) * 21000n).toString(),
    );
    assert.equal(page.data.items[0].stats.priceWei, null);
    assert.equal(page.data.items[0].marketCoverage.unitBasis, null);
    await marketUnits(db);
    page = await get("q=Canonical&window=24h");
    assert.equal(page.data.items[0].stats.priceWei, "4000000000000000000");
    assert.equal(page.data.items[0].stats.change, 300);
    assert.equal(page.data.items[0].stats.holders, null);
    assert.equal(page.data.items[0].stats.liquidityWei, null);
    assert.equal(page.data.items[0].processed, false);
    assert.equal(
      page.data.items[0].marketCoverage.rawPrice.sqrtPriceX96,
      "39614081257132168796771975168",
    );
    // Launch order keeps every discovered pool. A metric sort lists only pools
    // whose selected source proves that metric: launch 31 is past the broad
    // cutoff, quiet covered pools prove zero trades, and only the canonical
    // market has dated units for a price and a pre-window baseline.
    const all = (await get("sort=trades&window=All&limit=100")).data;
    assert.equal(all.items[0].stats.trades, 21001);
    assert.equal(all.total, 30);
    assert.equal(all.items.at(-1).stats.trades, 0);
    const launches = (await get("sort=launch&window=All&limit=100")).data;
    assert.equal(launches.total, 31);
    assert.equal(
      launches.items.find((p: AnalyticsPoolRow) => p.id === word(31)).stats
        .trades,
      null,
    );
    // Page-first launch order and the whole-catalog metric path compute
    // identical rows for every pool they share.
    const byTrades = new Map<string, AnalyticsPoolRow>(
      all.items.map((p: AnalyticsPoolRow) => [p.id, p]),
    );
    for (const pool of launches.items as AnalyticsPoolRow[])
      if (byTrades.has(pool.id)) assert.deepEqual(pool, byTrades.get(pool.id));
    // Change and liquidity rank the pools with a deep publication (none yet);
    // a catalog-wide price order waits for the per-pool latest-state rollup
    // and answers invalid_sort exactly as main does.
    const invalid = await get("sort=price&window=All");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, "invalid_sort");
    const sortTotals = {
      volume: 30,
      trades: 30,
      change: 0,
      liquidity: 0,
      launch: 31,
    };
    for (const [sort, total] of Object.entries(sortTotals))
      for (const direction of ["asc", "desc"]) {
        const full = (
          await get(`sort=${sort}&direction=${direction}&limit=100`)
        ).data;
        assert.equal(full.total, total);
        const collected: string[] = [];
        for (let offset = 0; offset < total; offset += 7) {
          const p = (
            await get(
              `sort=${sort}&direction=${direction}&limit=7&offset=${offset}`,
            )
          ).data;
          assert.equal(p.total, total);
          collected.push(...p.items.map((r: AnalyticsPoolRow) => r.id));
        }
        assert.deepEqual(
          collected,
          full.items.map((p: AnalyticsPoolRow) => p.id),
        );
        assert.equal(new Set(collected).size, total);
      }
    // An unsupported last trade preserves activity and suppresses volume/price.
    await db.query(
      `UPDATE broad_swaps SET amount0=0,amount1=1,side=NULL,eth_wei=NULL,token_raw=NULL,flags=ARRAY['missing_transfer_history','unsupported_swap_signs'] WHERE tx_hash=$1`,
      [word(22000)],
    );
    await db.query(
      "UPDATE broad_batches SET unsupported_swaps=(SELECT count(*) FROM broad_swaps WHERE batch_end=$1 AND side IS NULL) WHERE batch_end=$1",
      [first + 21000],
    );
    await db.query("SELECT project_broad_market($1)", [first + 21000]);
    page = await get("q=Canonical");
    assert.equal(page.data.items[0].stats.volumeWei, null);
    assert.equal(page.data.items[0].stats.priceWei, null);
    assert.equal(page.data.items[0].stats.trades, 21000);
    await db.query(
      `UPDATE broad_swaps SET amount0=-$1::numeric,amount1=10,side='buy',eth_wei=$1,token_raw=10,flags=ARRAY['missing_transfer_history'] WHERE tx_hash=$2`,
      [marketAmount, word(22000)],
    );
    await db.query(
      "UPDATE broad_batches SET unsupported_swaps=(SELECT count(*) FROM broad_swaps WHERE batch_end=$1 AND side IS NULL) WHERE batch_end=$1",
      [first + 21000],
    );
    await db.query("SELECT project_broad_market($1)", [first + 21000]);
    // Conflicting surviving dated units suppress normalization.
    await marketUnits(db, 6, first + 8999);
    page = await get("q=Canonical");
    assert.equal(page.data.items[0].stats.priceWei, null);
    assert.equal(page.data.items[0].marketCoverage.unitsConflict, true);
    await db.query("DELETE FROM broad_token_units WHERE batch_end=$1", [
      first + 8999,
    ]);
    // A deep copy never adds to broad totals; conflicts fail closed and clear on rewind.
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'pool',$2,$3,$4,$5)`,
      [`pool:${word(1)}`, word(1), first, first + 29999, word(first + 29999)],
    );
    await db.query(
      `INSERT INTO indexer_batches VALUES(4663,$1,$2,$3,$4,$5,'{}',now())`,
      [
        `pool:${word(1)}`,
        first,
        first + 29999,
        word(first + 29999),
        "c".repeat(64),
      ],
    );
    await db.query(
      `INSERT INTO indexed_events SELECT chain_id,$1,$2,tx_hash,log_index,block_number,block_hash,timestamp,'swap',pool_id,token,transaction_sender,
    jsonb_build_object('decoded',jsonb_build_object('amount0',amount0::text,'amount1',amount1::text,'sqrtPriceX96',sqrt_price_x96::text)) FROM broad_swaps WHERE tx_hash=$3`,
      [`pool:${word(1)}`, first + 29999, word(1001)],
    );
    page = await get("q=Canonical");
    assert.equal(page.data.items[0].stats.trades, 21000);
    await db.query("UPDATE indexed_events SET token=$1", [address(9)]);
    assert.equal((await get()).status, 503);
    await db.query("UPDATE indexed_events SET token=$1", [address(1)]);
    assert.equal((await get()).status, 200);
    // Recent copies corroborate identities but never advance historical market
    // coverage or inflate broad totals. Contradictions are cached at writes.
    await db.query(
      "INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'swaps',$1,$2,$3,300000)",
      [first, first + 29999, word(first + 29999)],
    );
    await db.query(
      "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'swaps',$1,$2,$3,300000,$4,'{}')",
      [first, first + 29999, word(first + 29999), "e".repeat(64)],
    );
    await db.query(
      `INSERT INTO recent_swaps SELECT chain_id,'swaps',$1,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0::text,amount1::text,eth_wei::text,token_raw::text,side FROM broad_swaps WHERE tx_hash=$2`,
      [first + 29999, word(1001)],
    );
    page = await get("q=Canonical");
    assert.equal(page.status, 200);
    assert.equal(page.data.items[0].stats.trades, 21000);
    await db.query("UPDATE recent_swaps SET token=$1", [address(9)]);
    assert.equal((await get()).status, 503);
    await db.query("DELETE FROM recent_swaps");
    assert.equal((await get()).status, 200);
    // Deep publication newer than broad wins without summing overlapping events.
    const snapshot = {
      schemaVersion: 1,
      chainId: 4663,
      toBlock: first + 29999,
      blockHash: word(first + 29999),
      toTimestamp: 300000,
      markets: [{ id: word(1) }],
    };
    await db.query(
      `INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind,source_stream,source_batch)
    VALUES(4663,$1,$2,$3,300000,$4,'indexed',$5,$2)`,
      [
        word(1),
        first + 29999,
        word(first + 29999),
        snapshot,
        `pool:${word(1)}`,
      ],
    );
    await db.query(
      `INSERT INTO analytics_accounting_pools VALUES(4663,$1,1,$2,$3,$4,100000,300000,now(),'indexed',$5,7,NULL)`,
      [
        word(1),
        first + 29999,
        word(first + 29999),
        first,
        {
          id: word(1),
          token: address(1),
          priceWei: "99",
          decimals: 18,
          launchedAt: 100000,
        },
      ],
    );
    await db.query(
      `INSERT INTO analytics_accounting_trades VALUES(4663,$1,$2,0,$3,300000,'buy',123,10,NULL,NULL,false,NULL,NULL,NULL,NULL)`,
      [word(1), word(90000), first + 29999],
    );
    await db.query(
      "UPDATE analytics_accounting_pools a SET generated_at=s.generated_at FROM analytics_pool_snapshots s WHERE a.pool_id=s.pool_id",
    );
    await db.query(
      `INSERT INTO analytics_accounting_trades SELECT chain_id,pool_id,tx_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,NULL,NULL,false,NULL,NULL,NULL,NULL FROM broad_swaps WHERE tx_hash=$1`,
      [word(1002)],
    );
    page = await get("q=Canonical");
    assert.equal(page.status, 200, JSON.stringify(page.data));
    assert.equal(page.data.items[0].stats.volumeWei, "123");
    assert.equal(page.data.items[0].stats.priceWei, "99");
    assert.equal(page.data.items[0].stats.holders, 7);
    assert.equal(page.data.items[0].marketCoverage.source, "deep_publication");
    assert.equal(page.data.items[0].throughBlock, first + 29999);
    await marketUnits(db, 6, first + 8999);
    page = await get("q=Canonical");
    assert.equal(page.data.items[0].marketCoverage.source, "deep_publication");
    assert.equal(page.data.items[0].stats.priceWei, null);
    assert.equal(page.data.items[0].marketCoverage.unitsConflict, true);
    assert.equal(page.data.items[0].market.priceWei, "99"); // preserved dated deep publication
    await db.query("DELETE FROM broad_token_units WHERE batch_end=$1", [
      first + 8999,
    ]);
    await rewind(db, await getStream(db, `pool:${word(1)}`), null);
    page = await get("q=Canonical");
    assert.equal(page.data.items[0].marketCoverage.source, "canonical_broad");
    assert.equal(page.data.items[0].stats.trades, 21000);
    // Empty advancing global batch retains the earlier unit observation's date.
    await db.query(
      `INSERT INTO indexer_batches VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,'{}',now())`,
      [first + 21001, first + 21002, word(first + 21002), "d".repeat(64)],
    );
    await db.query(
      `INSERT INTO broad_batches VALUES(4663,'swaps:broad:v1',$1,$2,$3,210000,'discovery:v2',$4,$5,$6,1,'{}',0,0,0)`,
      [
        first + 21002,
        first + 21001,
        word(first + 21000),
        first + 29999,
        word(first + 29999),
        "a".repeat(64),
      ],
    );
    await db.query("SELECT project_broad_market($1)", [first + 21002]);
    await db.query(
      "UPDATE indexer_streams SET cursor_block=$1,cursor_hash=$2 WHERE kind='broad'",
      [first + 21002, word(first + 21002)],
    );
    page = await get("q=Canonical");
    assert.equal(page.data.items[0].stats.priceWei, "4000000000000000000");
    assert.equal(
      page.data.items[0].marketCoverage.unitBasis.block,
      first + 21000,
    );
    assert.equal(page.data.items[0].marketCoverage.cutoff.block, first + 21002);
    await rewind(db, await getStream(db, "swaps:broad:v1"), first + 17999);
    page = await get("q=Canonical&window=All");
    assert.equal(page.data.items[0].stats.trades, 18000);
    assert.equal(page.data.items[0].stats.priceWei, null);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS count FROM broad_market_batches",
        )
      ).rows[0].count,
      2,
    );
    // Full catalog size: all launches participate before LIMIT. No raw swap
    // scan is needed for quiet covered pools, and page sorting remains exact.
    const seedStarted = performance.now();
    await seedBatches(1, 52000, 1000, (lo, hi) =>
      db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
        SELECT 4663,'0x'||lpad(to_hex(i+50000),64,'0'),'0x'||lpad(to_hex(i+50000),40,'0'),
        'Scale launch '||i,'S'||i,$1,'0x'||lpad(to_hex(i+90000),64,'0'),$2,100000,'discovery:v2',$3
        FROM generate_series($4::integer,$5::integer)i`,
        [first, address(99), first + 29999, lo, hi],
      ),
    );
    // Fresh statistics for every relation the explore read touches, so the
    // plans below are the ones production's autoanalyze would settle on.
    await db.query(
      "ANALYZE indexed_pools,recent_pools,pool_launch_sources,indexer_batches,broad_batches,broad_swaps,broad_token_units,broad_market_summaries,broad_market_buckets,analytics_pool_snapshots,analytics_accounting_pools,analytics_accounting_trades,analytics_accounting_prices",
    );
    const seedMs = performance.now() - seedStarted;
    // Evidence for the explore read's jit=off, printed rather than asserted:
    // the metric statement's cost estimate sits far above
    // jit_optimize_above_cost, so a host with JIT available spends seconds
    // compiling it before a sub-second execution. Homebrew builds have no JIT.
    const explain = async (jit: "on" | "off") => {
      let summary = "not captured";
      await db.query("BEGIN");
      await readProjectedExplore(
        async (sql, values) => {
          if (sql.startsWith("SET LOCAL jit"))
            return db.query(`SET LOCAL jit = ${jit}`);
          if (!sql.includes("count(*) OVER ()")) return db.query(sql, values);
          const plan = (
            await db.query(
              "EXPLAIN (ANALYZE, SETTINGS, SUMMARY) " + sql,
              values,
            )
          ).rows.map((row) => String(row["QUERY PLAN"]));
          const pick = (re: RegExp) =>
            plan.map((line) => line.match(re)?.[1]).find(Boolean) ?? "n/a";
          summary = `cost=${plan[0]?.match(/cost=[\d.]+\.\.([\d.]+)/)?.[1] ?? "n/a"} planning=${pick(/^Planning Time: ([\d.]+) ms/)}ms execution=${pick(/^Execution Time: ([\d.]+) ms/)}ms jitFunctions=${pick(/^\s*Functions: (\d+)/)} jitTotal=${pick(/Timing: .*Total ([\d.]+) ms/)}ms`;
          return db.query(sql, values);
        },
        { sort: "trades", window: "All", limit: 25 },
      );
      await db.query("COMMIT");
      return summary;
    };
    const settings = (
      await db.query(
        "SELECT version() AS version,current_setting('jit') AS jit,current_setting('jit_above_cost') AS above,current_setting('jit_optimize_above_cost') AS optimize",
      )
    ).rows[0];
    process.stdout.write(
      `postgres: ${settings.version}; jit=${settings.jit} jit_above_cost=${settings.above} jit_optimize_above_cost=${settings.optimize}; cpus=${availableParallelism()}\nmetric statement jit=on: ${await explain("on")}\nmetric statement jit=off: ${await explain("off")}\n`,
    );
    const timed = async (q: string) => {
      const started = performance.now();
      const result = await get(q);
      return { ...result, ms: performance.now() - started };
    };
    // First reads after seeding: the metric sort joins every covered launch,
    // then launch order counts the whole catalog including launch 31.
    const metric = await timed("sort=trades&window=All&limit=25");
    assert.equal(metric.status, 200, JSON.stringify(metric.data));
    assert.equal(metric.data.total, 52030);
    assert.equal(metric.data.items.length, 25);
    assert.equal(metric.data.items[0].stats.trades, 18000);
    assert.equal(metric.data.nextOffset, 25);
    const catalog = await timed("window=All&limit=25");
    assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
    assert.equal(catalog.data.total, 52031);
    for (const read of [metric, catalog])
      assert(
        read.ms < catalogReadBudgetMs,
        `52k catalog read exceeded ${catalogReadBudgetMs}ms: ${read.ms.toFixed(1)}ms`,
      );
    // Page the entire catalog at 100 per page with two requests in flight,
    // checking every page's nextOffset chains to the next page or ends null.
    const pageIds: string[][] = [];
    const pageMs: number[] = [];
    let nextPage = 0;
    const walkStarted = performance.now();
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (nextPage * 100 < catalog.data.total) {
          const index = nextPage++,
            offset = index * 100;
          const started = performance.now();
          const mapped = await get(`window=All&limit=100&offset=${offset}`);
          pageMs.push(performance.now() - started);
          assert.equal(mapped.status, 200, JSON.stringify(mapped.data));
          assert.equal(mapped.data.total, 52031);
          assert.equal(
            mapped.data.nextOffset,
            offset + 100 < 52031 ? offset + 100 : null,
          );
          pageIds[index] = mapped.data.items.map(
            (pool: AnalyticsPoolRow) => pool.id,
          );
        }
      }),
    );
    const walkMs = performance.now() - walkStarted;
    const scaleIds = pageIds.flat();
    assert.equal(pageIds.length, 521);
    assert.equal(scaleIds.length, 52031);
    assert.equal(new Set(scaleIds).size, 52031);
    process.stdout.write(
      `52k catalog serving: seedMs=${seedMs.toFixed(1)} metricReadMs=${metric.ms.toFixed(1)} catalogReadMs=${catalog.ms.toFixed(1)} walkMs=${walkMs.toFixed(1)} pageMaxMs=${Math.max(...pageMs).toFixed(1)} pageMeanMs=${(pageMs.reduce((a, b) => a + b, 0) / pageMs.length).toFixed(1)} rows=${scaleIds.length} pages=${pageIds.length} unique=${new Set(scaleIds).size}\n`,
    );
  },
);
