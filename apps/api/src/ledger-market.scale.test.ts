import assert from "node:assert/strict";
import test from "node:test";
import { availableParallelism } from "node:os";
import type { AnalyticsPoolRow } from "@pools/core";
import { rebuildBroadMarket } from "../../../packages/db/src/index";
import { readCreators } from "./creators-read";
import { readLedgerLeaderboard } from "./ledger-leaderboard";
import { candidatesSql, createWalletCodeStore } from "./trader-contracts";
import { createReader } from "./reader";
import { createApi } from "./server";
import { validatePoolResponse } from "../../web/src/lib/pool-response";
import {
  marketDatabase,
  marketUnits,
  seedBatches,
} from "../../../tests/support/broad-market-db";

// The reader budgets 3,000 ms per statement; the ledger's reads must sit well
// inside it at production shape (62,858 pools, 166,098 pool hours on 17 Sep
// 2026). A serial phase of `pnpm test:db`, like the broad explore scale test,
// so the bound measures the reads rather than other fixtures' seeding.
const readBudgetMs = 2000;
// Every launch sender holds a ledger wallet, so the creators page's own-buy
// evidence probes a position for each of the launches it reaches, exactly as
// production does. That probe is what took the creators read to 2.5-2.8 s of
// its 3,000 ms budget on a cold production copy (62,896 pools, 2.18M
// positions) while the traders and pool reads stayed at 19-22 ms and 78 ms,
// and what production cancelled with 57014 on a first load.
const senders = 26000;
const censusWallets = 387000;
const H = 500000,
  cursorBlock = 23600000,
  cursorTime = H * 3600 + 1800,
  launchBatch = 23590000,
  scalePools = 62000,
  // Blocks the live ring spans, 0.864 s apart: the day before the cursor.
  ringBlocks = 100000;
const poolId = (i: number) =>
  "0x" + (i + 200000).toString(16).padStart(64, "0");

test(
  "ledger market serving: every explore order, every creators window and sort, the trader board and the busiest pool page at production shape stay inside the read budget",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const fixture = await marketDatabase(),
      { db, schema } = fixture;
    const reader = createReader(process.env.TEST_DATABASE_URL, schema, {
        marketSource: "ledger",
      }),
      api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      await fixture.close();
    });
    // The broad world stays beside the ledger, as in production.
    await marketUnits(db);
    await rebuildBroadMarket(db, 10);

    const seedStarted = performance.now();
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash)
      VALUES(4663,'launches:agg:v1','discovery',23467030,$1,$2)`,
      [launchBatch, poolId(-200000 + launchBatch)],
    );
    await db.query(
      `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
      VALUES(4663,'launches:agg:v1',23467030,$1,$2,$3,'{}')`,
      [launchBatch, poolId(-200000 + launchBatch), "f".repeat(64)],
    );
    // Every scale launch is covered, with a measured supply.
    await seedBatches(1, scalePools, 2000, (lo, hi) =>
      db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch,decimals,token_total_supply_raw,token_supply_block)
        SELECT 4663,'0x'||lpad(to_hex(i+200000),64,'0'),'0x'||lpad(to_hex(i+200000),40,'0'),'Ledger launch '||i,'LL'||i,
          23467030+i,'0x'||lpad(to_hex(i+300000),64,'0'),'0x'||lpad(to_hex(1000+mod(i,26000)),40,'0'),($3::bigint-1200)*3600+i,
          'launches:agg:v1',$4,18,1000000000000000000000000000,$5
        FROM generate_series($1::integer,$2::integer) i`,
        [lo, hi, H, launchBatch, cursorBlock + 500],
      ),
    );
    await db.query(
      `INSERT INTO agg_streams(chain_id,stream_key,start_block,mode) VALUES(4663,'ledger:agg:v1',23467030,'tip')`,
    );
    // The history pass's one batch, then the tip loop's: a batch every 100
    // blocks (86 s) through the day before the cursor.
    await db.query(
      `INSERT INTO agg_batches(chain_id,stream_key,to_block,from_block,from_parent_hash,block_hash,to_timestamp,archive_height,registry_pools,content_hash,query,pages,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,requests,bytes)
      SELECT 4663,'ledger:agg:v1',t,f,decode(repeat('ab',32),'hex'),decode(lpad(to_hex(t),64,'0'),'hex'),$2::bigint-($1::bigint-t)*864/1000,t+128,$3,decode(repeat('cd',32),'hex'),'{}','{}',0,0,$3,0,0,0,1,1
      FROM (SELECT $1::bigint-100*k AS t,$1::bigint-100*k-99 AS f FROM generate_series(0,$4::integer-1) k
        UNION ALL SELECT $1::bigint-100*$4::integer,23467030) batches`,
      [cursorBlock, cursorTime, scalePools, ringBlocks / 100],
    );
    await db.query(
      `UPDATE agg_streams SET cursor_block=$1,cursor_hash=decode(lpad(to_hex($1::bigint),64,'0'),'hex'),cursor_timestamp=$2`,
      [cursorBlock, cursorTime],
    );
    // Pool hours at production's count and activity: the busiest pool trades
    // in every one of 1,170 hours, a hundred pools in each of their last 400,
    // and every other pool in two adjacent hours whose newer one is k hours
    // back, spread so a day, a week and 30 days hold about the share of pools
    // they did on 17 Sep 2026 (654, 3,663 and 17,726 of 62,858: 1%, 6%, 28%).
    // A price state rises and falls by hour and pool.
    const hourRows = (pools: string, hours: string) => `
      INSERT INTO agg_pool_hours(chain_id,pool_ref,hour,trades,buys,sells,unattributed,volume_wei,buyers,sellers,open_sqrt_price_x96,close_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_block,close_log_index)
      SELECT 4663,p.pool_ref,h,t,t,0,0,t*10000000000000000::numeric,1,0,v,v+1000000000000000000000000,v+2000000000000000000000000,v,$3::bigint-($4::integer-h),0
      FROM ${pools} JOIN indexed_pools p ON p.chain_id=4663 AND p.pool_id='0x'||lpad(to_hex(i+200000),64,'0')
      CROSS JOIN LATERAL ${hours}
      CROSS JOIN LATERAL (SELECT 1000000000000000000000000000000000::numeric+mod(i::bigint*7919+h::bigint*104729,1000000)*1000000000000000000000000::numeric AS v) price`;
    await db.query(
      hourRows(
        "(SELECT 1 AS i) s",
        "(SELECT h,400 AS t FROM generate_series($4::integer-1169,$4::integer) h) hours",
      )
        .replace("$3::bigint", "$1::bigint")
        .replace(/\$4/g, "$2"),
      [cursorBlock, H],
    );
    await db.query(
      hourRows(
        "generate_series(2,101) i",
        "(SELECT h,20 AS t FROM generate_series($4::integer-399,$4::integer) h) hours",
      )
        .replace("$3::bigint", "$1::bigint")
        .replace(/\$4/g, "$2"),
      [cursorBlock, H],
    );
    await seedBatches(102, scalePools, 4000, (lo, hi) =>
      db.query(
        hourRows(
          "generate_series($1::integer,$2::integer) i",
          "(SELECT CASE WHEN mod(i,100)<1 THEN mod(i,23) WHEN mod(i,100)<6 THEN 23+mod(i,145) WHEN mod(i,100)<28 THEN 168+mod(i,551) ELSE 719+mod(i,449) END AS k) back CROSS JOIN LATERAL (SELECT $4::integer-back.k-1 AS h,3 AS t UNION ALL SELECT $4::integer-back.k,2) hours",
        ),
        [lo, hi, cursorBlock, H],
      ),
    );
    await db.query(
      `INSERT INTO agg_pool_state(chain_id,pool_ref,trades,volume_wei,holders,sqrt_price_x96,liquidity,tick,price_block,price_log_index,price_tx,price_timestamp,first_trade_timestamp,last_trade_timestamp)
      SELECT 4663,pool_ref,sum(trades),sum(volume_wei),1,(array_agg(close_sqrt_price_x96 ORDER BY hour DESC))[1],1,0,max(close_block),0,
        decode(lpad(to_hex(pool_ref),64,'0'),'hex'),max(hour)::bigint*3600,min(hour)::bigint*3600,max(hour)::bigint*3600
      FROM agg_pool_hours WHERE chain_id=4663 GROUP BY pool_ref`,
    );
    // The live ring: the 24 hours ending at the cursor at the busiest
    // rolling day measured (1,026,761 swaps, 5 to 6 Aug 2026), ten swaps a
    // block. The busiest pool takes each block's first, and ninety of the
    // hundred 400-hour pools share the rest, so the rolling hour's rank,
    // flow and baselines read the whole ring's shape.
    await seedBatches(0, ringBlocks - 1, 10000, (lo, hi) =>
      db.query(
        `INSERT INTO agg_live_trades(chain_id,stream_key,pool_ref,wallet_ref,tx_hash,log_index,block_number,block_hash,timestamp,side,eth_wei,token_raw,sqrt_price_x96,attribution,batch_end)
        SELECT 4663,'ledger:agg:v1',p.pool_ref,NULL,decode(lpad(to_hex(m*10+j),64,'0'),'hex'),j,$3::bigint-m,decode(lpad(to_hex($3::bigint-m),64,'0'),'hex'),$4::bigint-m*864/1000,
          CASE WHEN mod(m+j,2)=0 THEN 'buy' ELSE 'sell' END,10000000000000000,1000,
          1000000000000000000000000000000000::numeric+mod((m*10+j)::bigint*7919,1000000)*1000000000000000000000000::numeric,'unattributed',$3::bigint-100*(m/100)
        FROM generate_series($1::integer,$2::integer) m CROSS JOIN generate_series(0,9) j
        JOIN indexed_pools p ON p.chain_id=4663 AND p.pool_id='0x'||lpad(to_hex(CASE WHEN j=0 THEN 1 ELSE mod(m,10)*10+j+2 END+200000),64,'0')`,
        [lo, hi, cursorBlock, cursorTime],
      ),
    );
    // The wallets behind the catalog: every ledger launch sender, and the
    // broad fixture's own sender, whose 31 launches top the launches order.
    await db.query(
      `INSERT INTO agg_wallets(wallet_ref,address,first_block) OVERRIDING SYSTEM VALUE
      SELECT m+1,decode(lpad(to_hex(1000+m),40,'0'),'hex'),23467030 FROM generate_series(0,$1::integer-1) m`,
      [senders],
    );
    await db.query(
      `INSERT INTO agg_wallets(wallet_ref,address,first_block) OVERRIDING SYSTEM VALUE VALUES($1,decode(lpad(to_hex(99),40,'0'),'hex'),23467030)`,
      [senders + 1],
    );
    await seedBatches(1, censusWallets, 20000, (lo, hi) =>
      db.query(
        `INSERT INTO agg_wallets(wallet_ref,address,first_block) OVERRIDING SYSTEM VALUE
        SELECT $3::integer+m,decode(lpad(to_hex(1000000+m),40,'0'),'hex'),23467030
        FROM generate_series($1::integer,$2::integer) m`,
        [lo, hi, senders + 1],
      ),
    );
    // An even-indexed sender bought into every launch of its own and an
    // odd-indexed one into none, so the page's own-buy flags are a real mix,
    // one probe answers for a buying creator and a creator who never bought
    // is probed on every launch. Closed at a profit, so the row satisfies
    // the ledger's own accounting constraints
    // (realized = proceeds - disposed cost, invested = cost + disposed +
    // outflow cost) rather than standing outside them.
    await seedBatches(1, scalePools, 4000, (lo, hi) =>
      db.query(
        `INSERT INTO agg_positions(chain_id,pool_ref,wallet_ref,quantity_raw,cost_wei,invested_wei,proceeds_wei,disposed_cost_wei,realized_wei,
          inflow_raw,outflow_raw,outflow_cost_wei,buys,sells,wrapper_swaps,counterparty_swaps,first_block,last_block,last_timestamp,supported,flags,closed_cycles,flash_cycles,shortest_cycle_seconds)
        SELECT 4663,p.pool_ref,mod(i,$3::integer)+1,0,0,1000,1200,1000,200,0,0,0,1,1,0,0,23467030+i,23467030+i,$4::bigint,true,'{}',1,0,120
        FROM generate_series($1::integer,$2::integer) i
        JOIN indexed_pools p ON p.chain_id=4663 AND p.pool_id='0x'||lpad(to_hex(i+200000),64,'0')
        WHERE mod(mod(i,$3::integer),2)=0`,
        [lo, hi, senders, H * 3600],
      ),
    );
    // The trader leaderboard's own source, so this phase carries the control
    // the creators bound is read against: the board the tip loop ranked,
    // its ranks on the wallets' own rows and its figures on the trader rows,
    // and two contracts the census observed at the top of the net order.
    for (const window of ["7d", "All"]) {
      for (const table of ["agg_wallet_windows", "agg_trader_windows"])
        await db.query(
          `INSERT INTO ${table}(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,trades,supported_trades,
            wins,losses,closures,hold_seconds,best_wei,last_timestamp,supported_positions,excluded_positions,window_start,refreshed_at)
          SELECT 4663,$1,m+1,(5000-m)::numeric,(5000-m)::numeric,100000,1000,12+mod(m,100),12+mod(m,100),1,0,1,600,(5000-m)::numeric,$2::bigint,1,0,
            $3::integer,now()
          FROM generate_series(0,4999) m`,
          [window, H * 3600, window === "All" ? 0 : H - 168],
        );
      await db.query(
        `UPDATE agg_wallet_windows SET rank=wallet_ref-2 WHERE "window"=$1 AND wallet_ref BETWEEN 3 AND 102`,
        [window],
      );
      await db.query(
        `INSERT INTO agg_window_refreshes(chain_id,stream_key,"window",through_block,through_timestamp,window_start,wallets,ranked,refreshed_at)
        VALUES(4663,'ledger:agg:v1',$1,$2,$3,$4,5000,100,now())`,
        [window, cursorBlock, cursorTime, window === "All" ? 0 : H - 168],
      );
    }
    for (const [window, rows, start] of [
      ["1h", 2000, H - 1],
      ["6h", 5000, H - 6],
      ["24h", 20000, H - 24],
      ["7d", 70000, H - 168],
      ["30d", 180000, H - 720],
      ["All", censusWallets, 0],
    ] as const) {
      await seedBatches(1, rows, 20000, (lo, hi) =>
        db.query(
          `INSERT INTO agg_trader_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,trades,supported_trades,
            wins,losses,closures,hold_seconds,best_wei,last_timestamp,supported_positions,excluded_positions,window_start,refreshed_at)
          SELECT 4663,$3,$4::integer+m,
            CASE WHEN m<=100 THEN -m ELSE -10000-m END,
            CASE WHEN m<=100 THEN -m ELSE -10000-m END,
            100000,1000,CASE WHEN m<=100 THEN 999 ELSE mod(m*37,1000) END,
            CASE WHEN m<=100 THEN 999 ELSE mod(m*37,1000) END,
            1,0,1,600,CASE WHEN m<=100 THEN -m ELSE -10000-m END,$5::bigint,1,0,$6::integer,now()
          FROM generate_series($1::integer,$2::integer) m`,
          [lo, hi, window, senders + 1, H * 3600, start],
        ),
      );
    }
    await db.query(
      `INSERT INTO wallet_code_observations(chain_id,address,kind,code_bytes,observed_at)
      SELECT 4663,address,'contract',100,now() FROM agg_wallets WHERE wallet_ref IN (1,2)`,
    );
    await db.query(
      "ANALYZE indexed_pools,pool_launch_sources,indexer_batches,agg_streams,agg_batches,agg_pool_hours,agg_pool_state,agg_live_trades,analytics_accounting_pools,broad_market_summaries,broad_market_buckets,agg_wallets,agg_positions,agg_wallet_windows,agg_trader_windows,agg_window_refreshes,wallet_code_observations",
    );
    const counts = (
      await db.query(
        `SELECT (SELECT count(*) FROM indexed_pools)::integer AS pools,
          (SELECT count(*) FROM agg_pool_hours)::integer AS hours,
          (SELECT count(*) FROM agg_pool_state)::integer AS states,
          (SELECT count(*) FROM agg_trader_windows WHERE "window"='All')::integer AS traders,
          (SELECT count(DISTINCT "window") FROM agg_trader_windows)::integer AS trader_windows,
          (SELECT min(least(supported_trades,999)) FROM agg_trader_windows WHERE "window"='All')::integer AS min_gate,
          (SELECT max(least(supported_trades,999)) FROM agg_trader_windows WHERE "window"='All')::integer AS max_gate`,
      )
    ).rows[0];
    assert.deepEqual(counts, {
      pools: scalePools + 31,
      hours: 1170 + 100 * 400 + (scalePools - 101) * 2,
      states: scalePools,
      traders: censusWallets + 5000,
      trader_windows: 6,
      min_gate: 0,
      max_gate: 999,
    });
    const seedMs = performance.now() - seedStarted;

    const timed = async (path: string) => {
      const started = performance.now();
      const response = await fetch(base + path);
      const data = (await response.json()) as any;
      const ms = performance.now() - started;
      assert.equal(response.status, 200, `${path} ${JSON.stringify(data)}`);
      assert(
        ms < readBudgetMs,
        `${path} exceeded ${readBudgetMs}ms: ${ms.toFixed(1)}ms`,
      );
      return { data, ms };
    };
    const reads: [string, number][] = [];
    // The creators page first, on the caches the seeding left cold and before
    // the warm-up read below: production's first load after a restart is what
    // failed, and a reload is what worked. Every window and sort the route
    // serves, since the page offers all of them and the whole-catalog probe
    // cost the same in each.
    for (const window of ["1h", "6h", "24h", "7d", "30d", "All"])
      for (const sort of ["launches", "volume", "median"]) {
        const read = await timed(
          `/v1/creators?window=${window}&sort=${sort}&limit=25`,
        );
        reads.push([`creators${sort}${window}`, read.ms]);
      }
    const creators = (await timed("/v1/creators?window=All&limit=25")).data;
    assert.equal(creators.total, 100);
    assert(creators.items[0].measured > 0);
    // Its own-buy evidence is served, and it is neither uniformly true nor
    // uniformly false: a flag no launch can disagree with proves nothing.
    const flags = creators.items.map(
      (c: { boughtOwnLaunch: boolean | null }) => c.boughtOwnLaunch,
    );
    assert(
      flags.includes(true) && flags.includes(false),
      JSON.stringify(flags),
    );
    // The whole board in one request, which a reload asks for once the page
    // has grown: production answered 53100 for every window=All page of 50
    // rows or more, `could not resize shared memory segment ... to 8388608
    // bytes`, while the same page of 25 and every shorter window served.
    const whole = await timed("/v1/creators?window=All&limit=100");
    reads.push(["creatorsAll100", whole.ms]);
    assert.equal(whole.data.items.length, 100);
    // The regression, read from the plan of the statement that carries the
    // own-buy evidence rather than from its text, on the page shape that
    // failed. The probe must reach the page's own launches and no others
    // (over the whole catalog the same probe was 260k buffers and 2.1 s of a
    // cold read's 2.4 s), it must stop at a creator's first own buy (probing
    // every launch of the top 100 by launches was 12,463 random reads of the
    // position heap on the production-shaped copy, the page production
    // answered 503 under a memory cap), and it must plan no parallel worker:
    // the shared memory a parallel hash asks its container for is what this
    // page had none of, and a plan that asks for none can never be refused
    // it. A buying creator here bought every launch of its own, so its first
    // probe hits whatever order the launches are probed in.
    const pageProbes = whole.data.items.reduce(
      (sum: number, c: { launches: number; boughtOwnLaunch: boolean | null }) =>
        sum + (c.boughtOwnLaunch ? 1 : c.launches),
      0,
    );
    let probes = -1,
      sequential = false,
      parallel = "";
    await db.query("BEGIN");
    await readCreators(
      async (sql: string, values?: unknown[]) => {
        if (sql.includes("agg_positions")) {
          const walk = (node: Record<string, any>) => {
            if (node["Relation Name"] === "agg_positions") {
              probes = Math.max(probes, 0) + (node["Actual Loops"] ?? 1);
              sequential ||= String(node["Node Type"]).includes("Seq Scan");
            }
            if (node["Parallel Aware"] || node["Workers Planned"] !== undefined)
              parallel ||= String(node["Node Type"]);
            for (const child of node.Plans ?? []) walk(child);
          };
          const plan = (
            await db.query(
              "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql,
              values as unknown[],
            )
          ).rows[0]["QUERY PLAN"][0];
          walk(plan.Plan);
        }
        return db.query(sql, values as unknown[]) as any;
      },
      { window: "All", sort: "launches", limit: 100, offset: 0 },
      "ledger",
    );
    await db.query("COMMIT");
    assert(probes >= 0, "no statement carried the own-buy evidence");
    assert(!sequential, "the own-buy probe scanned the whole position table");
    assert.equal(
      parallel,
      "",
      `the own-buy probe planned a parallel ${parallel}`,
    );
    assert(
      probes <= pageProbes,
      `own-buy probes ${probes} exceeded the page's ${pageProbes} (catalog ${counts.pools})`,
    );
    // The controls, on the same cold fixture: the board the tip loop ranked
    // and, further down, the busiest pool's page.
    const board = await timed(
      "/v1/leaderboard?window=7d&limit=25&minTrades=10",
    );
    reads.push(["traders7d", board.ms]);
    assert.equal(board.data.total, 100);
    assert.equal(board.data.items.length, 25);
    const censusPlan = (
      await db.query(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + candidatesSql,
        [25],
      )
    ).rows[0]["QUERY PLAN"][0].Plan;
    const censusMs = Number(censusPlan["Actual Total Time"]);
    const censusPages =
      Number(censusPlan["Shared Hit Blocks"]) +
      Number(censusPlan["Shared Read Blocks"]);
    assert(censusMs < 1500, `candidate read took ${censusMs} ms`);
    assert(censusPages < 150000, `candidate read touched ${censusPages} pages`);
    reads.push(["censusCandidates", censusMs]);
    process.stdout.write(`census candidate pages=${censusPages}\n`);
    const codeStore = createWalletCodeStore(
      process.env.TEST_DATABASE_URL,
      schema,
    );
    try {
      assert.equal((await codeStore.candidates(25)).length, 25);
    } finally {
      await codeStore.close();
    }
    // The net order, which has no writer rank: it reads the window's
    // eligible wallets in net order off migration 025's index and stops at
    // the page's last row. Before it, the board read every eligible row of
    // the window and sorted them (about 6,700 pages for 7d and 18,800 with two
    // parallel workers for All on the 27 Sep production backup), and
    // production answered 7d and 30d net in 0.7-1.7 s once those pages had
    // left a smaller cache. Read from the plan, as the creators probe is.
    const net = await timed(
      "/v1/leaderboard?window=7d&metric=net&limit=100&minTrades=10",
    );
    reads.push(["tradersNet7d", net.ms]);
    assert.equal(net.data.items.length, 100);
    const netRows: number[] = [];
    let netParallel = "";
    await db.query("BEGIN");
    await readLedgerLeaderboard(
      async (sql: string, values?: unknown[]) => {
        if (sql.includes("net_wei DESC")) {
          const walk = (node: Record<string, any>) => {
            if (node["Relation Name"] === "agg_trader_windows")
              netRows.push(
                Math.round(node["Actual Rows"] * (node["Actual Loops"] ?? 1)),
              );
            if (node["Parallel Aware"] || node["Workers Planned"] !== undefined)
              netParallel ||= String(node["Node Type"]);
            for (const child of node.Plans ?? []) walk(child);
          };
          walk(
            (
              await db.query(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql,
                values as unknown[],
              )
            ).rows[0]["QUERY PLAN"][0].Plan,
          );
        }
        return db.query(sql, values as unknown[]) as any;
      },
      { window: "7d", metric: "net", minTrades: 10, limit: 100, offset: 0 },
    );
    await db.query("COMMIT");
    assert(netRows.length > 0, "no statement read the net order");
    // The page and the two contracts above it, whose rows the order passes.
    assert(
      netRows.every((rows) => rows <= 102),
      `the net board read ${JSON.stringify(netRows)} window rows for a page of 100 of 5,000 eligible`,
    );
    assert.equal(
      netParallel,
      "",
      `the net board planned a parallel ${netParallel}`,
    );
    // One untimed read loads the relation caches the seeding left cold, so
    // the timings below measure the statements rather than a first touch.
    assert.equal(
      (await fetch(`${base}/v1/explore?window=All&limit=1`)).status,
      200,
    );
    const explore = async (name: string, query: string) => {
      const read = await timed(`/v1/explore?${query}`);
      reads.push([name, read.ms]);
      return read.data;
    };
    const launch = await explore("launch24h", "window=24h&limit=25");
    assert.equal(launch.total, scalePools + 31);
    assert.equal(launch.items[0].marketCoverage.source, "aggregate_ledger");
    const volume = await explore(
      "volume24h",
      "window=24h&sort=volume&limit=25",
    );
    assert.equal(volume.total, scalePools + 30);
    assert.equal(volume.items[1].id, poolId(1));
    const trades = await explore(
      "tradesAll",
      "window=All&sort=trades&limit=25",
    );
    assert.equal(trades.items[0].stats.trades, 1170 * 400);
    await explore("trades30d", "window=30d&sort=trades&limit=25&offset=975");
    // A change needs an hour before the window: a two-hour pool k hours back
    // has none when both hours are inside an n-hour window (k <= n-2), and
    // the hundred 400-hour pools have none inside 30 days.
    const back = (i: number) =>
      i % 100 < 1
        ? i % 23
        : i % 100 < 6
          ? 23 + (i % 145)
          : i % 100 < 28
            ? 168 + (i % 551)
            : 719 + (i % 449);
    const withoutBaseline = (n: number) => {
      let count = 0;
      for (let i = 102; i <= scalePools; i++) if (back(i) <= n - 2) count++;
      return count;
    };
    const day = await explore("change24h", "window=24h&sort=change&limit=25");
    assert.equal(day.total, scalePools - withoutBaseline(24));
    const month = await explore(
      "change30d",
      "window=30d&sort=change&direction=asc&limit=25",
    );
    assert.equal(month.total, scalePools - withoutBaseline(720) - 100);
    const gainers = await explore(
      "gainers7d",
      "window=7d&view=gainers&sort=volume&limit=25",
    );
    assert(gainers.total > 0);
    for (const row of gainers.items as AnalyticsPoolRow[])
      assert(row.stats.change! > 0);
    // 1h is the rolling hour in the ring: every covered launch answers it,
    // and the busiest pool traded in each of its 4,168 blocks (a block m
    // back is at cursorTime - floor(0.864m), at or after the start while
    // m <= 4,167).
    const hour = await explore("volume1h", "window=1h&sort=volume&limit=25");
    assert.equal(hour.total, scalePools + 30);
    const busiest = (hour.items as AnalyticsPoolRow[]).find(
      (row) => row.id === poolId(1),
    )!;
    assert.equal(busiest.stats.trades, 4168);
    assert.equal(busiest.stats.completeWindow, true);
    await explore("trades1h", "window=1h&sort=trades&limit=25");
    const hourChange = await explore(
      "change1h",
      "window=1h&sort=change&limit=25",
    );
    assert(hourChange.total > 0);
    await explore("gainers1h", "window=1h&view=gainers&sort=volume&limit=25");
    await explore("launch1h", "window=1h&view=new&sort=launch&limit=25");
    await explore("volume1h100", "window=1h&sort=volume&limit=100");
    const liquidity = await explore(
      "liquidity7d",
      "window=7d&sort=liquidity&limit=25",
    );
    assert.equal(liquidity.total, 0);
    await explore(
      "search24h",
      "window=24h&q=Ledger%20launch%2061&sort=change&limit=25",
    );
    // The busiest pool's page: 1,170 hours, the newest thousand as candles.
    for (const window of ["1h", "24h", "All"]) {
      const read = await timed(`/v1/pools/${poolId(1)}?window=${window}`);
      reads.push([`pool${window}`, read.ms]);
      validatePoolResponse(read.data, poolId(1), window);
      assert.equal(read.data.market.history.candles.length, 1000);
      assert.equal(read.data.market.history.truncated, true);
      assert.equal(read.data.market.observations.length, 50);
      assert.equal(
        read.data.market.trades,
        { "1h": 4168, "24h": 9600, All: 468000 }[window],
      );
      assert.equal(read.data.analytics, null);
    }
    // The creators aggregate warm, beside the cold reads above.
    for (const [name, query] of [
      ["creatorsAllWarm", "window=All&limit=25"],
      ["creatorsVolume24hWarm", "window=24h&sort=volume&limit=25"],
    ]) {
      const read = await timed(`/v1/creators?${query}`);
      reads.push([name, read.ms]);
      assert(read.data.items[0].measured > 0);
    }
    const settings = (
      await db.query(
        "SELECT version() AS version,current_setting('jit') AS jit,current_setting('jit_above_cost') AS above",
      )
    ).rows[0];
    process.stdout.write(
      `postgres: ${settings.version}; jit=${settings.jit} jit_above_cost=${settings.above}; cpus=${availableParallelism()}\nledger market serving: seedMs=${seedMs.toFixed(0)} ${reads.map(([name, ms]) => `${name}Ms=${ms.toFixed(1)}`).join(" ")} pools=${counts.pools} hours=${counts.hours}\n`,
    );
  },
);
