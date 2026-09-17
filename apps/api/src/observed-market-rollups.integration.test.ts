import assert from "node:assert/strict";
import test from "node:test";
import { rebuildBroadMarket } from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createApi } from "./server";
import { readObservedMarket } from "./observed-market-read";
// The website proxies /api/product/pools/<id>/ through this exact module
// before it renders a pool page; importing it keeps the boundary honest.
import { validatePoolResponse } from "../../web/src/lib/pool-response";
import {
  marketDatabase,
  marketUnits,
  marketWord as word,
  marketAddress as address,
  marketFirst as first,
  marketAmount,
} from "../../../tests/support/broad-market-db";

// Raw sqrt price states in 18 display decimals: 2^96 is 1e18, 2^95 is 4e18
// and 2^97 is 0.25e18.
const sqrt = {
  one: "79228162514264337593543950336",
  four: "39614081257132168796771975168",
  quarter: "158456325028528675187087900672",
};
const price = { one: "1" + "0".repeat(18), four: "4" + "0".repeat(18) };
const windows = ["1h", "6h", "24h", "7d", "30d", "All"] as const;

test(
  "Postgres HTTP: a broad-selected pool page is served from the rollups and matches the raw aggregation, including cached conflicts and the raw fallbacks",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const fixture = await marketDatabase(),
      { db, schema } = fixture;
    const reader = createReader(process.env.TEST_DATABASE_URL, schema),
      api = createApi(reader, { cacheMs: 0, maxPerMinute: 10000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      await fixture.close();
    });
    const q = (sql: string, values?: unknown[]) => db.query(sql, values);
    const get = async (pool: string, window: string) => {
      const response = await fetch(`${base}/v1/pools/${pool}?window=${window}`);
      const data = (await response.json()) as any;
      if (response.status === 200) validatePoolResponse(data, pool, window);
      return { status: response.status, data };
    };
    // The raw aggregation of the same rows: the projection markers are gone
    // inside a rolled-back transaction, so every read falls back to it.
    const raw = async (pool: string, window: (typeof windows)[number]) => {
      const row = (
        await db.query("SELECT * FROM indexed_pools WHERE pool_id=$1", [pool])
      ).rows[0];
      return JSON.parse(
        JSON.stringify(await readObservedMarket(q, row, window, null)),
      );
    };
    const withoutRollups = async <T>(
      body: () => Promise<T>,
      remove = "DELETE FROM broad_market_batches",
    ) => {
      await db.query("BEGIN");
      try {
        await db.query(remove);
        return await body();
      } finally {
        await db.query("ROLLBACK");
      }
    };
    // Pool 2's swaps in blocks the fixture's second and third batches own,
    // shaped for what the rollups must fold exactly: a minute spanning two
    // batches, a second holding four swaps whose extremes sit in the middle,
    // a minute with an unsupported swap, a minute opening on its own state
    // because the previous swap was unsupported, and a closing sell at the
    // cutoff block beside pool 1's swap there.
    const pool = word(2),
      token = address(2);
    type Kind = "buy" | "sell" | "unsupported";
    const swaps: {
      block: number;
      log: number;
      sqrt: string;
      eth: number;
      kind: Kind;
    }[] = [
      { block: first + 17990, log: 0, sqrt: sqrt.one, eth: 100, kind: "buy" },
      { block: first + 18010, log: 0, sqrt: sqrt.four, eth: 200, kind: "buy" },
      { block: first + 18100, log: 0, sqrt: sqrt.one, eth: 300, kind: "buy" },
      { block: first + 18100, log: 1, sqrt: sqrt.four, eth: 400, kind: "buy" },
      {
        block: first + 18100,
        log: 2,
        sqrt: sqrt.quarter,
        eth: 500,
        kind: "buy",
      },
      { block: first + 18100, log: 3, sqrt: sqrt.one, eth: 600, kind: "buy" },
      { block: first + 18200, log: 0, sqrt: sqrt.one, eth: 700, kind: "buy" },
      {
        block: first + 18200,
        log: 1,
        sqrt: sqrt.one,
        eth: 0,
        kind: "unsupported",
      },
      { block: first + 18300, log: 0, sqrt: sqrt.four, eth: 800, kind: "buy" },
      { block: first + 21000, log: 5, sqrt: sqrt.one, eth: 900, kind: "sell" },
    ];
    const timestamp = (block: number) =>
      block === first + 21000 ? 200000 : 113600 + (block - first);
    const batchEnd = (block: number) =>
      block < first + 18000 ? first + 17999 : first + 21000;
    for (const end of [first + 17999, first + 21000])
      await db.query(
        "INSERT INTO broad_registry_members VALUES(4663,'swaps:broad:v1',$1,$2,'{}')",
        [end, pool],
      );
    for (const [i, s] of swaps.entries()) {
      const amounts =
        s.kind === "buy"
          ? [-s.eth, 10, "buy", s.eth, 10, ["missing_transfer_history"]]
          : s.kind === "sell"
            ? [s.eth, -10, "sell", s.eth, 10, ["missing_transfer_history"]]
            : [
                0,
                0,
                null,
                null,
                null,
                ["missing_transfer_history", "unsupported_swap_signs"],
              ];
      await db.query(
        `INSERT INTO broad_swaps VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,100,0,2500,$13,$14,$15,false,$16)`,
        [
          batchEnd(s.block),
          pool,
          token,
          word(900000 + i),
          s.log,
          s.block,
          word(s.block),
          timestamp(s.block),
          address(99),
          ...amounts.slice(0, 2),
          s.sqrt,
          ...amounts.slice(2),
        ],
      );
      await db.query(
        "UPDATE broad_batches SET observed_swaps=observed_swaps+1,unsupported_swaps=unsupported_swaps+$2 WHERE batch_end=$1",
        [batchEnd(s.block), s.kind === "unsupported" ? 1 : 0],
      );
    }
    await marketUnits(db, 18, first + 21000, token);
    await marketUnits(db);
    assert.deepEqual(await rebuildBroadMarket(db, 10), {
      rebuilt: 3,
      remaining: 0,
    });
    // The buckets' extremes are the extremes of their swaps, every bucket.
    assert.deepEqual(
      (
        await db.query(
          `SELECT count(*)::integer AS mismatched FROM broad_market_buckets k
          JOIN (SELECT chain_id,stream_key,batch_end,pool_id,timestamp,min(sqrt_price_x96) AS lo,max(sqrt_price_x96) AS hi
            FROM broad_swaps GROUP BY 1,2,3,4,5) s USING(chain_id,stream_key,batch_end,pool_id,timestamp)
          WHERE k.min_sqrt<>s.lo OR k.max_sqrt<>s.hi`,
        )
      ).rows,
      [{ mismatched: 0 }],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS n FROM broad_market_buckets WHERE pool_id=$1 AND trades=4 AND min_sqrt=$2 AND max_sqrt=$3 AND first_sqrt=$4 AND last_sqrt=$4",
          [pool, sqrt.four, sqrt.quarter, sqrt.one],
        )
      ).rows[0].n,
      1,
    );

    // The served page, in every window, against the raw aggregation.
    const served = new Map<string, any>();
    for (const window of windows) {
      const page = await get(pool, window);
      assert.equal(page.status, 200, JSON.stringify(page.data));
      served.set(window, page.data.market);
    }
    const all = served.get("All");
    assert.equal(all.trades, 10);
    assert.equal(all.volumeWei, null);
    assert.equal(all.priceWei, price.one);
    assert.equal(all.change, null);
    assert.equal(all.coverage.priceBaseline, null);
    assert.equal(all.coverage.unitBasis.source, "broad_token_units");
    assert.equal(all.history.truncated, false);
    assert.equal(all.history.fromTimestamp, 131580);
    assert.deepEqual(all.history.candles, [
      {
        time: 131580,
        open: price.one,
        high: price.four,
        low: price.one,
        close: price.four,
        volume: "300",
      },
      {
        time: 131700,
        open: price.four,
        high: price.four,
        low: "250000000000000000",
        close: price.one,
        volume: "1800",
      },
      {
        time: 131880,
        open: price.four,
        high: price.four,
        low: price.four,
        close: price.four,
        volume: "800",
      },
      {
        time: 199980,
        open: price.four,
        high: price.four,
        low: price.one,
        close: price.one,
        volume: "900",
      },
    ]);
    assert.deepEqual(
      all.observations.map((o: any) => [o.block - first, o.logIndex, o.side]),
      [
        [21000, 5, "sell"],
        [18300, 0, "buy"],
        [18200, 1, null],
        [18200, 0, "buy"],
        [18100, 3, "buy"],
        [18100, 2, "buy"],
        [18100, 1, "buy"],
        [18100, 0, "buy"],
        [18010, 0, "buy"],
        [17990, 0, "buy"],
      ],
    );
    assert.deepEqual(
      all.observations.slice(0, 3).map((o: any) => [o.ethWei, o.tokenRaw]),
      [
        ["900", "10"],
        ["800", "10"],
        [null, null],
      ],
    );
    const hour = served.get("1h");
    assert.equal(hour.trades, 1);
    assert.equal(hour.volumeWei, "900");
    assert.equal(hour.change, -75);
    assert.deepEqual(hour.coverage.priceBaseline, {
      block: first + 18300,
      hash: word(first + 18300),
      asOf: 131900,
    });
    assert.equal(hour.coverage.completeWindow, true);
    assert.equal(hour.history.candles.length, 4);
    const day = served.get("24h");
    assert.equal(day.trades, 10);
    assert.equal(day.coverage.windowStart, 113600);
    assert.equal(day.coverage.completeWindow, false);
    // The page reads the rollups, not the swaps: a poked whole-batch summary
    // shows in the whole history and a poked edge bucket in the hour window.
    await db.query(
      "UPDATE broad_market_summaries SET trades=trades+1 WHERE pool_id=$1 AND batch_end=$2",
      [pool, first + 17999],
    );
    await db.query(
      "UPDATE broad_market_buckets SET trades=trades+1 WHERE pool_id=$1 AND timestamp=200000",
      [pool],
    );
    assert.equal((await get(pool, "All")).data.market.trades, 11);
    assert.equal((await get(pool, "1h")).data.market.trades, 2);
    await db.query(
      "UPDATE broad_market_summaries SET trades=trades-1 WHERE pool_id=$1 AND batch_end=$2",
      [pool, first + 17999],
    );
    await db.query(
      "UPDATE broad_market_buckets SET trades=trades-1 WHERE pool_id=$1 AND timestamp=200000",
      [pool],
    );
    assert.deepEqual((await get(pool, "All")).data.market, all);
    // Pool 1's 21,001 swaps, one per second across three batches: the whole
    // history, the day window that trims its first swap and the hour window
    // that keeps only the cutoff swap and prices its baseline.
    const deep = new Map<string, any>();
    for (const window of ["1h", "24h", "All"] as const) {
      const page = await get(word(1), window);
      assert.equal(page.status, 200, JSON.stringify(page.data));
      deep.set(window, page.data.market);
    }
    assert.equal(deep.get("All").trades, 21001);
    assert.equal(
      deep.get("All").volumeWei,
      (21001n * BigInt(marketAmount)).toString(),
    );
    assert.equal(deep.get("24h").trades, 21000);
    assert.equal(deep.get("1h").trades, 1);
    assert.equal(deep.get("1h").priceWei, price.four);
    assert.equal(deep.get("1h").change, 300);
    // The pool launched past the broad cutoff has no market on either path.
    const uncovered = await get(word(31), "24h");
    assert.equal(uncovered.status, 200);
    assert.equal(uncovered.data.market.coverage.cutoff, null);
    await withoutRollups(async () => {
      for (const window of windows)
        assert.deepEqual(served.get(window), await raw(pool, window), window);
      for (const window of ["1h", "24h", "All"] as const)
        assert.deepEqual(deep.get(window), await raw(word(1), window), window);
      assert.deepEqual(uncovered.data.market, await raw(word(31), "24h"));
    });
    // A release ahead of migration 018 (the API deploys on its own; the
    // migration runs from the indexer service) finds buckets without the
    // extremes and serves the raw path: a poked summary changes nothing.
    await withoutRollups(async () => {
      await db.query(
        "UPDATE broad_market_summaries SET trades=trades+1 WHERE pool_id=$1",
        [pool],
      );
      for (const window of ["1h", "All"] as const)
        assert.deepEqual(served.get(window), await raw(pool, window), window);
    }, "ALTER TABLE broad_market_buckets DROP COLUMN min_sqrt,DROP COLUMN max_sqrt");

    // Deep and recent copies of pool 2's swaps. Consistent copies change
    // nothing; a contradicting copy reaches the page through the write-time
    // conflict caches, on whichever side of the identity names this pool.
    const stream = "pool:" + pool;
    await db.query(
      "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'pool',$2,$3,$4,$5)",
      [stream, pool, first, first + 21000, word(first + 21000)],
    );
    await db.query(
      "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,$1,$2,$3,$4,'deep',$5)",
      [
        stream,
        first,
        first + 21000,
        word(first + 21000),
        JSON.stringify({
          headers: [
            {
              number: first + 21000,
              hash: word(first + 21000),
              timestamp: 200000,
            },
          ],
        }),
      ],
    );
    await db.query(
      `INSERT INTO indexed_events(chain_id,stream_key,batch_end,tx_hash,log_index,block_number,block_hash,timestamp,kind,pool_id,token,transaction_sender,payload)
      SELECT chain_id,$1,$2,tx_hash,log_index,block_number,block_hash,timestamp,'swap',pool_id,token,transaction_sender,
        jsonb_build_object('decoded',jsonb_build_object('amount0',amount0::text,'amount1',amount1::text,'side',side,'ethWei',eth_wei::text,'sqrtPriceX96',sqrt_price_x96::text))
      FROM broad_swaps WHERE pool_id=$3`,
      [stream, first + 21000, pool],
    );
    await db.query(
      "INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'swaps',$1,$2,$3,200000)",
      [first, first + 21000, word(first + 21000)],
    );
    await db.query(
      "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'swaps',$1,$2,$3,200000,'recent','{}')",
      [first, first + 21000, word(first + 21000)],
    );
    await db.query(
      `INSERT INTO recent_swaps SELECT chain_id,'swaps',$1,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0::text,amount1::text,eth_wei::text,token_raw::text,side
      FROM broad_swaps WHERE pool_id=$2 AND side IS NOT NULL`,
      [first + 21000, pool],
    );
    for (const window of windows)
      assert.deepEqual(
        (await get(pool, window)).data.market,
        served.get(window),
      );
    const conflicts = async () =>
      (
        await db.query(
          "SELECT (SELECT count(*) FROM broad_market_conflicts)::integer AS deep,(SELECT count(*) FROM broad_market_recent_conflicts)::integer AS recent",
        )
      ).rows[0];
    assert.deepEqual(await conflicts(), { deep: 0, recent: 0 });
    const expect503 = async (id: string) => {
      const page = await get(id, "24h");
      assert.equal(page.status, 503);
      assert.equal(page.data.error, "market_identity_conflict");
    };
    await db.query(
      `UPDATE indexed_events SET payload=jsonb_set(payload,'{decoded,sqrtPriceX96}','"2"') WHERE tx_hash=$1`,
      [word(900000)],
    );
    assert.deepEqual(await conflicts(), { deep: 1, recent: 0 });
    await expect503(pool);
    assert.equal((await get(word(1), "24h")).status, 200);
    await db.query(
      `UPDATE indexed_events SET payload=jsonb_set(payload,'{decoded,sqrtPriceX96}',to_jsonb($2::text)) WHERE tx_hash=$1`,
      [word(900000), sqrt.one],
    );
    assert.deepEqual(await conflicts(), { deep: 0, recent: 0 });
    assert.deepEqual((await get(pool, "24h")).data.market, served.get("24h"));
    // The deep copy names pool 1: both pages fail closed, as the raw path
    // does through its cross-pool identity probe.
    await db.query("UPDATE indexed_events SET pool_id=$2 WHERE tx_hash=$1", [
      word(900001),
      word(1),
    ]);
    assert.deepEqual(await conflicts(), { deep: 1, recent: 0 });
    await expect503(pool);
    await expect503(word(1));
    await withoutRollups(async () => {
      for (const id of [pool, word(1)])
        await assert.rejects(raw(id, "24h"), /market_identity_conflict/);
    });
    await db.query("UPDATE indexed_events SET pool_id=$2 WHERE tx_hash=$1", [
      word(900001),
      pool,
    ]);
    await db.query("UPDATE recent_swaps SET eth_wei='101' WHERE tx_hash=$1", [
      word(900000),
    ]);
    assert.deepEqual(await conflicts(), { deep: 0, recent: 1 });
    await expect503(pool);
    await db.query("UPDATE recent_swaps SET eth_wei='100' WHERE tx_hash=$1", [
      word(900000),
    ]);
    assert.deepEqual(await conflicts(), { deep: 0, recent: 0 });
    assert.deepEqual((await get(pool, "24h")).data.market, served.get("24h"));

    // A projection gap below the cutoff hands the page to the raw path, with
    // the same answer, until the bounded rebuild closes it.
    await db.query("DELETE FROM broad_market_batches WHERE batch_end=$1", [
      first + 17999,
    ]);
    for (const window of ["1h", "All"] as const)
      assert.deepEqual(
        (await get(pool, window)).data.market,
        served.get(window),
      );
    assert.deepEqual(await rebuildBroadMarket(db, 10), {
      rebuilt: 1,
      remaining: 0,
    });
    // A pool launched before the broad stream whose deep stream reaches back
    // to that launch extends the market's start below what the rollups cover,
    // so the raw path serves it: its deep-only swap before the broad start
    // counts.
    await db.query(
      "UPDATE indexed_pools SET launch_block=$2 WHERE pool_id=$1",
      [pool, first - 100],
    );
    await db.query(
      "UPDATE indexer_streams SET start_block=$2 WHERE stream_key=$1",
      [stream, first - 100],
    );
    await db.query(
      "UPDATE indexer_batches SET from_block=$2 WHERE stream_key=$1",
      [stream, first - 100],
    );
    await db.query(
      `INSERT INTO indexed_events(chain_id,stream_key,batch_end,tx_hash,log_index,block_number,block_hash,timestamp,kind,pool_id,token,transaction_sender,payload)
      VALUES(4663,$1,$2,$3,0,$4,$5,113500,'swap',$6,$7,$8,$9)`,
      [
        stream,
        first + 21000,
        word(905555),
        first - 50,
        word(first - 50),
        pool,
        token,
        address(99),
        JSON.stringify({
          decoded: {
            amount0: "-50",
            amount1: "10",
            side: "buy",
            ethWei: "50",
            sqrtPriceX96: sqrt.one,
          },
        }),
      ],
    );
    const extended = await get(pool, "All");
    assert.equal(extended.status, 200, JSON.stringify(extended.data));
    assert.equal(extended.data.market.coverage.startBlock, first - 100);
    assert.equal(extended.data.market.trades, 11);
    assert.equal(extended.data.market.observations.length, 11);
    assert.deepEqual(await conflicts(), { deep: 0, recent: 0 });
  },
);
