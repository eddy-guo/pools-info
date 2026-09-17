import assert from "node:assert/strict";
import test from "node:test";
import { assertObservedMarket, type AnalyticsPoolRow } from "@pools/core";
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
} from "../../../tests/support/broad-market-db";

// The ledger's newest pool hour and its cursor, half an hour into that hour.
const H = 500000,
  cursorBlock = 23600000,
  cursorTime = H * 3600 + 1800,
  launchBatch = 23590000,
  laterLaunchBatch = 23700000;
const e30 = 10n ** 30n,
  e18 = 10n ** 18n;
// KAIJU's stored price state (pool_ref 62140 in the local pass): its last
// trade, after the pool retraced from the mid-pump state a stale deep
// publication still serves.
const kaijuSqrt = 1547971581794087805434370376550886n;
const kaijuLastPriceWei = "2619589255";
const kaijuDeepPriceWei = "59080890343";
/** wei per whole token: currency0 is ETH, currency1 the token. */
const price = (sqrt: bigint, decimals = 18) =>
  ((2n ** 192n * 10n ** BigInt(decimals)) / (sqrt * sqrt)).toString();
const change = (latest: bigint, baseline: bigint) =>
  Number(((baseline * baseline - latest * latest) * 10000n) / (latest * latest)) /
  100;
const hex = (n: number) => word(n).slice(2);

type Hour = {
  hour: number;
  trades: number;
  volume: bigint;
  open: bigint;
  close: bigint;
  min: bigint;
  max: bigint;
};
const flat = (hour: number, trades: number, volume: bigint, sqrt: bigint) => ({
  hour,
  trades,
  volume,
  open: sqrt,
  close: sqrt,
  min: sqrt,
  max: sqrt,
});
// Covered launches, each registered by the ledger's launch lane below its
// cursor: K carries KAIJU's price and a stale deep publication, N launched an
// hour before the newest hour, O traded 200 and 50 hours back, Q never traded
// and S declares 6 decimals. U launched past the cursor, in a launch batch
// the ledger has not folded yet, so it is not covered.
const pools = {
  K: {
    id: word(801),
    launchBlock: 23500000,
    launchedAt: (H - 30) * 3600 + 100,
    decimals: 18,
    holders: 8,
    supply: 10n ** 27n as bigint | null,
    hours: [
      {
        hour: H - 30,
        trades: 5,
        volume: 5n * e18,
        open: 1500n * e30,
        close: 1600n * e30,
        min: 1500n * e30,
        max: 1650n * e30,
      },
      {
        hour: H - 10,
        trades: 3,
        volume: 3n * e18,
        open: 1580n * e30,
        close: 1450n * e30,
        min: 1400n * e30,
        max: 1600n * e30,
      },
      {
        hour: H - 2,
        trades: 2,
        volume: 2n * e18,
        open: 1460n * e30,
        close: 1520n * e30,
        min: 1450n * e30,
        max: 1530n * e30,
      },
      {
        hour: H,
        trades: 1,
        volume: e18,
        open: 1530n * e30,
        close: kaijuSqrt,
        min: 1520n * e30,
        max: 1550n * e30,
      },
    ] as Hour[],
  },
  N: {
    id: word(802),
    launchBlock: 23580000,
    launchedAt: (H - 1) * 3600 + 10,
    decimals: 18,
    holders: 3,
    supply: 10n ** 27n as bigint | null,
    hours: [flat(H - 1, 2, 2n * e18, 1000n * e30), flat(H, 1, e18, 900n * e30)],
  },
  O: {
    id: word(803),
    launchBlock: 23510000,
    launchedAt: (H - 210) * 3600,
    decimals: 18,
    holders: 2,
    supply: null as bigint | null,
    hours: [
      flat(H - 200, 1, e18, 2000n * e30),
      flat(H - 50, 3, 4n * e18, 1000n * e30),
    ],
  },
  Q: {
    id: word(804),
    launchBlock: 23520000,
    launchedAt: (H - 40) * 3600,
    decimals: 18,
    holders: 0,
    supply: 10n ** 27n as bigint | null,
    hours: [] as Hour[],
  },
  S: {
    id: word(805),
    launchBlock: 23530000,
    launchedAt: (H - 5) * 3600,
    decimals: 6,
    holders: 1,
    supply: 10n ** 15n as bigint | null,
    hours: [flat(H, 1, 10n ** 15n, 2n ** 96n)],
  },
};
const U = { id: word(806), launchBlock: 23650000, launchedAt: H * 3600 + 3600 };
const covered = new Set(Object.values(pools).map((p) => p.id));
const normalized = (body: string) =>
  body.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"-"');

test(
  "Postgres HTTP: MARKET_SOURCE=ledger serves the pools the ledger covers from its hours and state, and every other answer byte for byte as the broad source does",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const fixture = await marketDatabase(),
      { db, schema } = fixture;
    const readers = {
      broad: createReader(process.env.TEST_DATABASE_URL, schema),
      ledger: createReader(process.env.TEST_DATABASE_URL, schema, {
        marketSource: "ledger",
      }),
    };
    const bases: Record<string, string> = {};
    const servers: ReturnType<typeof createApi>[] = [];
    for (const [name, reader] of Object.entries(readers)) {
      const api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      bases[name] = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      servers.push(api);
    }
    t.after(async () => {
      for (const api of servers)
        await new Promise<void>((resolve) => api.close(() => resolve()));
      for (const reader of Object.values(readers)) await reader.close();
      await fixture.close();
    });
    const fetchText = async (source: "broad" | "ledger", path: string) => {
      const response = await fetch(bases[source] + path);
      return { status: response.status, body: await response.text() };
    };
    const get = async (source: "broad" | "ledger", path: string) => {
      const { status, body } = await fetchText(source, path);
      return { status, data: JSON.parse(body) };
    };

    // Today's broad world: the canonical pool's rollups and dated units.
    await marketUnits(db);
    assert.deepEqual(await rebuildBroadMarket(db, 10), {
      rebuilt: 3,
      remaining: 0,
    });
    // The ledger's launch lane: one batch below its cursor and one past it.
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash)
      VALUES(4663,'launches:agg:v1','discovery',23467030,$1,$2)`,
      [laterLaunchBatch, word(laterLaunchBatch)],
    );
    for (const [from, to] of [
      [23467030, launchBatch],
      [launchBatch + 1, laterLaunchBatch],
    ])
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
        VALUES(4663,'launches:agg:v1',$1,$2,$3,$4,'{}')`,
        [from, to, word(to), "f".repeat(64)],
      );
    for (const [key, pool] of [...Object.entries(pools), ["U", U] as const])
      await db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch,decimals,token_total_supply_raw,token_supply_block)
        VALUES(4663,$1,$2,$3,$4,$5,$6,$7,$8,'launches:agg:v1',$9,$10,$11,$12)`,
        [
          pool.id,
          address(Number.parseInt(pool.id.slice(-4), 16)),
          `Ledger ${key}`,
          `L${key}`,
          pool.launchBlock,
          word(pool.launchBlock + 7),
          address(98),
          pool.launchedAt,
          key === "U" ? laterLaunchBatch : launchBatch,
          "decimals" in pool ? pool.decimals : 18,
          "supply" in pool && pool.supply !== null ? pool.supply.toString() : null,
          "supply" in pool && pool.supply !== null ? cursorBlock + 500 : null,
        ],
      );
    // K's deep publication stopped mid-pump, long before the ledger's cursor.
    const deepBlock = 23500500,
      deepTime = (H - 30) * 3600 + 379;
    await db.query(
      `INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'pool',$2,$3,$4,$5)`,
      [
        `pool:${pools.K.id}`,
        pools.K.id,
        pools.K.launchBlock,
        deepBlock,
        word(deepBlock),
      ],
    );
    await db.query(
      `INSERT INTO indexer_batches VALUES(4663,$1,$2,$3,$4,$5,$6,now())`,
      [
        `pool:${pools.K.id}`,
        pools.K.launchBlock,
        deepBlock,
        word(deepBlock),
        "c".repeat(64),
        { headers: [{ number: deepBlock, timestamp: deepTime }] },
      ],
    );
    await db.query(
      `INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind,source_stream,source_batch)
      VALUES(4663,$1,$2,$3,$4,$5,'indexed',$6,$2)`,
      [
        pools.K.id,
        deepBlock,
        word(deepBlock),
        deepTime,
        {
          schemaVersion: 1,
          chainId: 4663,
          toBlock: deepBlock,
          blockHash: word(deepBlock),
          toTimestamp: deepTime,
          markets: [
            {
              id: pools.K.id,
              token: address(Number.parseInt(pools.K.id.slice(-4), 16)),
              name: "Ledger K",
              symbol: "LK",
              decimals: 18,
              supply: (10n ** 27n).toString(),
              launchBlock: pools.K.launchBlock,
              launchedAt: pools.K.launchedAt,
              launchTx: word(pools.K.launchBlock + 7),
              launchSender: address(98),
              priceWei: kaijuDeepPriceWei,
              volumeWei: "0",
            },
          ],
        },
        `pool:${pools.K.id}`,
      ],
    );
    await db.query(
      `INSERT INTO analytics_accounting_pools VALUES(4663,$1,1,$2,$3,$4,$5,$6,now(),'indexed',$7,302,NULL)`,
      [
        pools.K.id,
        deepBlock,
        word(deepBlock),
        pools.K.launchBlock,
        pools.K.launchedAt,
        deepTime,
        {
          id: pools.K.id,
          token: address(Number.parseInt(pools.K.id.slice(-4), 16)),
          priceWei: kaijuDeepPriceWei,
          decimals: 18,
          supply: (10n ** 27n).toString(),
          launchedAt: pools.K.launchedAt,
        },
      ],
    );
    await db.query(
      "UPDATE analytics_accounting_pools a SET generated_at=s.generated_at FROM analytics_pool_snapshots s WHERE a.pool_id=s.pool_id",
    );

    const explorePaths = [
      ...["1h", "6h", "24h", "7d", "30d", "All"].flatMap((window) =>
        ["launch", "volume", "trades", "change", "liquidity"].map(
          (sort) => `/v1/explore?window=${window}&sort=${sort}&limit=100`,
        ),
      ),
      "/v1/explore?window=24h&sort=volume&direction=asc&limit=100",
      "/v1/explore?window=24h&sort=change&direction=asc&limit=100",
      "/v1/explore?window=24h&view=gainers&limit=100",
      "/v1/explore?window=7d&view=gainers&sort=volume&limit=100",
      "/v1/explore?window=24h&view=new&limit=100",
      "/v1/explore?window=24h&sort=trades&limit=7&offset=14",
      "/v1/explore?window=24h&q=Ledger&sort=volume&limit=100",
      `/v1/explore?window=24h&view=watchlist&ids=${pools.K.id},${word(1)},${U.id}&limit=100`,
    ];
    const poolPaths = [
      ...["1h", "24h", "All"].map((w) => `/v1/pools/${word(1)}?window=${w}`),
      `/v1/pools/${word(2)}?window=24h`,
      `/v1/pools/${word(31)}?window=24h`,
      `/v1/pools/${U.id}?window=24h`,
      `/v1/pools/${pools.N.id}?window=24h`,
    ];
    const paths = [...explorePaths, ...poolPaths];
    const today = new Map<string, string>();
    for (const path of paths) {
      const response = await fetchText("broad", path);
      assert.equal(response.status, 200, `${path} ${response.body}`);
      today.set(path, normalized(response.body));
    }
    // With no ledger at all, and then with a ledger stream and batch but no
    // folded hour, the ledger source answers exactly as the broad source.
    const sameAsToday = async (source: "broad" | "ledger") => {
      for (const path of paths) {
        const response = await fetchText(source, path);
        assert.equal(response.status, 200, `${path} ${response.body}`);
        assert.equal(normalized(response.body), today.get(path), path);
      }
    };
    await sameAsToday("ledger");
    await db.query(
      `INSERT INTO agg_streams(chain_id,stream_key,start_block,mode) VALUES(4663,'ledger:agg:v1',23467030,'tip')`,
    );
    await db.query(
      `INSERT INTO agg_batches(chain_id,stream_key,to_block,from_block,from_parent_hash,block_hash,to_timestamp,archive_height,registry_pools,content_hash,query,pages,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,requests,bytes)
      VALUES(4663,'ledger:agg:v1',$1,23467030,decode($2,'hex'),decode($3,'hex'),$4,$5,6,decode($6,'hex'),'{}','{}',0,0,6,0,0,0,1,1)`,
      [
        cursorBlock,
        hex(23467029),
        hex(cursorBlock),
        cursorTime,
        cursorBlock + 128,
        "e".repeat(64),
      ],
    );
    await db.query(
      `UPDATE agg_streams SET cursor_block=$1,cursor_hash=decode($2,'hex'),cursor_timestamp=$3`,
      [cursorBlock, hex(cursorBlock), cursorTime],
    );
    await sameAsToday("ledger");

    // Fold the pools' hours, their states and K's two newest ring trades.
    for (const pool of Object.values(pools)) {
      const ref = `(SELECT pool_ref FROM indexed_pools WHERE pool_id='${pool.id}')`;
      for (const h of pool.hours)
        await db.query(
          `INSERT INTO agg_pool_hours(chain_id,pool_ref,hour,trades,buys,sells,unattributed,volume_wei,buyers,sellers,open_sqrt_price_x96,close_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_block,close_log_index)
          VALUES(4663,${ref},$1,$2,$2,0,0,$3,1,0,$4,$5,$6,$7,$8,0)`,
          [
            h.hour,
            h.trades,
            h.volume.toString(),
            h.open.toString(),
            h.close.toString(),
            h.max.toString(),
            h.min.toString(),
            pool.launchBlock + h.hour - (H - 300),
          ],
        );
      const last = pool.hours.at(-1);
      if (last)
        await db.query(
          `INSERT INTO agg_pool_state(chain_id,pool_ref,trades,volume_wei,holders,sqrt_price_x96,liquidity,tick,price_block,price_log_index,price_tx,price_timestamp,first_trade_timestamp,last_trade_timestamp)
          VALUES(4663,${ref},$1,$2,$3,$4,51074188046840591947412,197612,$5,3,decode($6,'hex'),$7,$8,$7)`,
          [
            pool.hours.reduce((sum, h) => sum + h.trades, 0),
            pool.hours.reduce((sum, h) => sum + h.volume, 0n).toString(),
            pool.holders,
            last.close.toString(),
            cursorBlock - 10,
            hex(7000 + pool.launchBlock),
            last.hour * 3600 + 60,
            pool.hours[0].hour * 3600 + 60,
          ],
        );
    }
    const kRef = `(SELECT pool_ref FROM indexed_pools WHERE pool_id='${pools.K.id}')`;
    for (const [block, log, side] of [
      [cursorBlock - 20, 1, "buy"],
      [cursorBlock, 4, "sell"],
    ] as const)
      await db.query(
        `INSERT INTO agg_live_trades(chain_id,stream_key,pool_ref,wallet_ref,tx_hash,log_index,block_number,block_hash,timestamp,side,eth_wei,token_raw,sqrt_price_x96,attribution,batch_end)
        VALUES(4663,'ledger:agg:v1',${kRef},NULL,decode($1,'hex'),$2,$3,decode($4,'hex'),$5,$6,1000,2000,$7,'unattributed',$8)`,
        [
          hex(block * 10 + log),
          log,
          block,
          hex(block),
          cursorTime - (cursorBlock - block),
          side,
          kaijuSqrt.toString(),
          cursorBlock,
        ],
      );

    // The broad source ignores every ledger row: byte for byte as before.
    await sameAsToday("broad");

    // The ledger source: every pool the ledger does not cover answers as the
    // broad source, row for row; the covered pools answer from the ledger.
    const served = new Map<string, any>();
    for (const path of explorePaths) {
      const [broad, ledger] = [await get("broad", path), await get("ledger", path)];
      assert.equal(ledger.status, 200, `${path} ${JSON.stringify(ledger.data)}`);
      served.set(path, ledger.data);
      const broadRows = new Map<string, AnalyticsPoolRow>(
        broad.data.items.map((row: AnalyticsPoolRow) => [row.id, row]),
      );
      const paged = path.includes("offset=");
      for (const row of ledger.data.items as AnalyticsPoolRow[])
        if (!covered.has(row.id) && (!paged || broadRows.has(row.id)))
          assert.deepEqual(row, broadRows.get(row.id), `${path} ${row.id}`);
      if (!paged)
        assert.equal(
          ledger.data.total -
          ledger.data.items.filter((r: AnalyticsPoolRow) => covered.has(r.id))
            .length,
        broad.data.total -
          broad.data.items.filter((r: AnalyticsPoolRow) => covered.has(r.id))
            .length,
          path,
        );
      assert.deepEqual(ledger.data.broadMarketCutoff, broad.data.broadMarketCutoff);
      assert.deepEqual(
        { ...ledger.data.coverage, asOf: 0, generatedAt: "-" },
        { ...broad.data.coverage, asOf: 0, generatedAt: "-" },
      );
      // The response's asOf is the newest data it serves: the ledger's cursor.
      assert.equal(ledger.data.coverage.asOf, cursorTime);
    }
    for (const path of poolPaths.filter((p) => !p.includes(pools.N.id))) {
      const [broad, ledger] = [
        await fetchText("broad", path),
        await fetchText("ledger", path),
      ];
      assert.equal(ledger.status, 200, `${path} ${ledger.body}`);
      assert.equal(normalized(ledger.body), normalized(broad.body), path);
    }

    const row = (path: string, id: string) =>
      (served.get(path).items as AnalyticsPoolRow[]).find((r) => r.id === id)!;
    const launchOrder = (window: string) =>
      `/v1/explore?window=${window}&sort=launch&limit=100`;
    const volume = (p: { hours: Hour[] }, from: number | null) =>
      p.hours
        .filter((h) => from === null || h.hour >= from)
        .reduce((sum, h) => sum + h.volume, 0n)
        .toString();
    const trades = (p: { hours: Hour[] }, from: number | null) =>
      p.hours
        .filter((h) => from === null || h.hour >= from)
        .reduce((sum, h) => sum + h.trades, 0);
    const cutoff = { block: cursorBlock, hash: word(cursorBlock), asOf: cursorTime };

    // KAIJU's freshness: the ledger serves the last trade's price, 2.6196e-9
    // ETH per token, where the deep publication still serves the mid-pump
    // price about 23 times higher.
    assert.equal(price(kaijuSqrt), kaijuLastPriceWei);
    const kDeep = (await get("broad", launchOrder("24h"))).data.items.find(
      (r: AnalyticsPoolRow) => r.id === pools.K.id,
    );
    assert.equal(kDeep.stats.priceWei, kaijuDeepPriceWei);
    assert.equal(kDeep.stats.holders, 302);
    assert.equal(kDeep.marketCoverage.source, "deep_publication");
    const k24 = row(launchOrder("24h"), pools.K.id);
    // Holders and liquidity are not ledger figures: exactly as today.
    assert.deepEqual(k24.stats, {
      priceWei: kaijuLastPriceWei,
      volumeWei: volume(pools.K, H - 23),
      liquidityWei: null,
      change: change(kaijuSqrt, 1600n * e30),
      trades: trades(pools.K, H - 23),
      holders: kDeep.stats.holders,
      completeWindow: true,
    });
    assert(k24.stats.change! > 0);
    // One price per row: the deep publication the ledger outdates is not
    // served beside the ledger's figures.
    assert.equal(kDeep.processed, true);
    assert.equal(kDeep.market.priceWei, kaijuDeepPriceWei);
    assert.equal(k24.processed, false);
    assert.equal(k24.market, null);
    assert.equal(k24.asOf, null);
    assert.equal(k24.throughBlock, null);
    assert.equal(k24.generatedAt, null);
    assert.equal(k24.sourceKind, null);
    assert.deepEqual(k24.marketCoverage, {
      source: "aggregate_ledger",
      startBlock: pools.K.launchBlock,
      cutoff,
      windowStart: (H - 23) * 3600,
      indexedAt: k24.marketCoverage!.indexedAt,
      unitsConflict: false,
      unitBasis: { ...cutoff, decimals: 18, source: "aggregate_ledger" },
      rawPrice: null,
      priceBaseline: null,
    });
    // 6h: the baseline is the close before the window's first hour.
    const k6 = row(launchOrder("6h"), pools.K.id);
    assert.equal(k6.stats.trades, 3);
    assert.equal(k6.stats.change, change(kaijuSqrt, 1450n * e30));
    // 7d, 30d and All span the pool's whole life: no hour precedes the
    // window, so no change is labelled with it; the volume is complete.
    for (const window of ["7d", "30d", "All"]) {
      const r = row(launchOrder(window), pools.K.id);
      assert.equal(r.stats.change, null, window);
      assert.equal(r.stats.trades, 11, window);
      assert.equal(r.stats.volumeWei, volume(pools.K, null), window);
      assert.equal(r.stats.completeWindow, true, window);
    }
    assert.equal(row(launchOrder("All"), pools.K.id).marketCoverage!.windowStart, pools.K.launchedAt);
    // Whole hours cannot answer 1h: no bucket-rounded figure under its name.
    for (const id of covered) {
      const r = row(launchOrder("1h"), id);
      assert.equal(r.stats.volumeWei, null);
      assert.equal(r.stats.trades, null);
      assert.equal(r.stats.change, null);
      assert.equal(r.stats.completeWindow, false);
      assert.equal(r.marketCoverage!.source, "aggregate_ledger");
    }
    // N launched an hour before the newest hour: the same trades in every
    // window it lives in, and never a since-launch change under their names.
    for (const window of ["24h", "7d", "30d", "All"]) {
      const r = row(launchOrder(window), pools.N.id);
      assert.equal(r.stats.trades, 3, window);
      assert.equal(r.stats.change, null, window);
      assert.equal(r.stats.priceWei, price(900n * e30), window);
      assert.equal(r.stats.completeWindow, true, window);
      assert.equal(r.stats.holders, null, window);
    }
    // O traded 200 and 50 hours back: nothing in the day, so a proven zero
    // volume and an unmoved price; the week holds the later hour and prices
    // its change from the earlier one's close.
    assert.deepEqual(row(launchOrder("24h"), pools.O.id).stats, {
      priceWei: price(1000n * e30),
      volumeWei: "0",
      liquidityWei: null,
      change: 0,
      trades: 0,
      holders: null,
      completeWindow: true,
    });
    assert.equal(row(launchOrder("7d"), pools.O.id).stats.change, 300);
    assert.equal(row(launchOrder("7d"), pools.O.id).stats.trades, 3);
    assert.equal(row(launchOrder("30d"), pools.O.id).stats.trades, 4);
    // Q never traded: zero flow is proven, nothing else is invented.
    assert.deepEqual(row(launchOrder("24h"), pools.Q.id).stats, {
      priceWei: null,
      volumeWei: "0",
      liquidityWei: null,
      change: null,
      trades: 0,
      holders: null,
      completeWindow: false,
    });
    // S declares 6 decimals: sqrt 2^96 is one raw unit per wei, so a whole
    // token costs 10^6 wei.
    assert.equal(row(launchOrder("24h"), pools.S.id).stats.priceWei, "1000000");
    assert.equal(
      row(launchOrder("24h"), pools.S.id).marketCoverage!.unitBasis!.decimals,
      6,
    );
    // U launched past the cursor: exactly the broad source's launch row.
    assert.equal(row(launchOrder("24h"), U.id).marketCoverage, null);

    // Metric orders rank the ledger's figures beside the broad ones.
    const ids = (path: string) =>
      (served.get(path).items as AnalyticsPoolRow[]).map((r) => r.id);
    const byVolume = served.get("/v1/explore?window=24h&sort=volume&limit=100");
    assert.equal(byVolume.total, 35);
    assert.deepEqual(ids("/v1/explore?window=24h&sort=volume&limit=100").slice(0, 3), [
      word(1),
      pools.K.id,
      pools.N.id,
    ]);
    assert.equal(
      served.get("/v1/explore?window=1h&sort=volume&limit=100").total,
      30,
    );
    assert.deepEqual(ids("/v1/explore?window=24h&sort=change&limit=100"), [
      pools.K.id,
      pools.O.id,
    ]);
    assert.deepEqual(ids("/v1/explore?window=24h&sort=change&direction=asc&limit=100"), [
      pools.O.id,
      pools.K.id,
    ]);
    assert.deepEqual(ids("/v1/explore?window=24h&view=gainers&limit=100"), [pools.K.id]);
    assert.deepEqual(ids("/v1/explore?window=7d&view=gainers&sort=volume&limit=100"), [
      pools.O.id,
    ]);
    assert.equal(served.get("/v1/explore?window=All&sort=change&limit=100").total, 0);
    assert.equal(served.get("/v1/explore?window=24h&sort=liquidity&limit=100").total, 0);
    const page = served.get("/v1/explore?window=24h&sort=trades&limit=7&offset=14");
    assert.equal(page.total, 35);
    assert.deepEqual(
      page.items.map((r: AnalyticsPoolRow) => r.id),
      ids("/v1/explore?window=24h&sort=trades&limit=100").slice(14, 21),
    );
    // A row is the same whichever order served it.
    for (const path of explorePaths)
      for (const r of served.get(path).items as AnalyticsPoolRow[])
        if (covered.has(r.id)) {
          const window = new URL(path, "http://x").searchParams.get("window")!;
          assert.deepEqual(r, row(launchOrder(window), r.id), `${path} ${r.id}`);
        }

    // The pool page from the ledger, through the website's validator.
    const poolPage = async (id: string, window: string) => {
      const response = await get("ledger", `/v1/pools/${id}?window=${window}`);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      validatePoolResponse(response.data, id, window);
      assert.equal(response.data.analytics, null);
      return response.data.market;
    };
    for (const window of ["24h", "7d", "All"]) {
      const market = await poolPage(pools.N.id, window);
      const r = row(launchOrder(window), pools.N.id);
      assert.equal(market.priceWei, r.stats.priceWei, window);
      assert.equal(market.volumeWei, r.stats.volumeWei, window);
      assert.equal(market.trades, r.stats.trades, window);
      assert.equal(market.change, r.stats.change, window);
      assert.equal(market.coverage.completeWindow, r.stats.completeWindow, window);
      assert.equal(market.coverage.windowStart, r.marketCoverage!.windowStart, window);
      assert.deepEqual(market.coverage.cutoff, cutoff);
      assert.equal(
        market.fdvWei,
        ((BigInt(price(900n * e30)) * 10n ** 27n) / e18).toString(),
        window,
      );
      assert.equal(market.history.intervalSeconds, 3600);
      assert.deepEqual(
        market.history.candles.map((c: any) => [c.time, c.open, c.close, c.volume]),
        [
          [(H - 1) * 3600, price(1000n * e30), price(1000n * e30), (2n * e18).toString()],
          [H * 3600, price(1000n * e30), price(900n * e30), e18.toString()],
        ],
      );
      assert.deepEqual(market.observations, []);
    }
    const o7 = await poolPage(pools.O.id, "7d");
    assert.equal(o7.change, 300);
    assert.equal((await poolPage(pools.O.id, "24h")).change, 0);
    const q24 = await poolPage(pools.Q.id, "24h");
    assert.equal(q24.trades, 0);
    assert.equal(q24.volumeWei, "0");
    assert.equal(q24.priceWei, null);
    assert.deepEqual(q24.history.candles, []);
    const s1 = await poolPage(pools.S.id, "1h");
    assert.equal(s1.priceWei, "1000000");
    assert.equal(s1.trades, null);
    assert.equal(s1.volumeWei, null);
    assert.equal(s1.coverage.completeWindow, false);

    // K's page market, read directly (its fixture snapshot is not a renderable
    // publication), with the snapshot's verified decimals.
    const kPool = (
      await db.query("SELECT * FROM indexed_pools WHERE pool_id=$1", [pools.K.id])
    ).rows[0];
    const verified = {
      decimals: 18,
      cutoff: { block: deepBlock, hash: word(deepBlock), asOf: deepTime },
    };
    const q = (sql: string, values?: unknown[]) => db.query(sql, values);
    const k = await readObservedMarket(q, kPool, "24h", verified, "ledger");
    assertObservedMarket(JSON.parse(JSON.stringify(k)), pools.K.id, kPool.token, "24h");
    assert.equal(k.priceWei, kaijuLastPriceWei);
    assert.equal(k.fdvWei, (BigInt(kaijuLastPriceWei) * 10n ** 9n).toString());
    // A 24h label always spans the ledger's own last 24 hours, never the
    // minutes a stale capture held after launch.
    assert.deepEqual(k.coverage.cutoff, cutoff);
    assert.equal(k.coverage.windowStart, (H - 23) * 3600);
    assert(k.coverage.cutoff!.asOf - k.coverage.windowStart! > 23 * 3600);
    assert(k.coverage.cutoff!.asOf - k.coverage.windowStart! <= 24 * 3600);
    assert.notEqual(k.coverage.cutoff!.asOf, deepTime);
    assert.equal(k.volumeWei, k24.stats.volumeWei);
    assert.equal(k.trades, k24.stats.trades);
    assert.equal(k.change, k24.stats.change);
    assert.equal(k.coverage.completeWindow, true);
    assert.deepEqual(k.coverage.unitBasis, {
      ...cutoff,
      decimals: 18,
      source: "aggregate_ledger",
    });
    assert.equal(k.history.fromTimestamp, (H - 30) * 3600);
    assert.equal(k.history.truncated, false);
    // An hour opens at the previous hour's close; its high and low price
    // include that opening state (the price falls as the sqrt rises).
    assert.deepEqual(k.history.candles, [
      {
        time: (H - 30) * 3600,
        open: price(1500n * e30),
        high: price(1500n * e30),
        low: price(1650n * e30),
        close: price(1600n * e30),
        volume: (5n * e18).toString(),
      },
      {
        time: (H - 10) * 3600,
        open: price(1600n * e30),
        high: price(1400n * e30),
        low: price(1600n * e30),
        close: price(1450n * e30),
        volume: (3n * e18).toString(),
      },
      {
        time: (H - 2) * 3600,
        open: price(1450n * e30),
        high: price(1450n * e30),
        low: price(1530n * e30),
        close: price(1520n * e30),
        volume: (2n * e18).toString(),
      },
      {
        time: H * 3600,
        open: price(1520n * e30),
        high: price(1520n * e30),
        low: price(1550n * e30),
        close: kaijuLastPriceWei,
        volume: e18.toString(),
      },
    ]);
    assert.deepEqual(
      k.observations.map((o) => [o.block, o.logIndex, o.side, o.ethWei, o.tokenRaw]),
      [
        [cursorBlock, 4, "sell", "1000", "2000"],
        [cursorBlock - 20, 1, "buy", "1000", "2000"],
      ],
    );
    assert.equal(k.observations[0].blockHash, word(cursorBlock));
    // Decimals the deep snapshot contradicts are a units conflict: no price.
    const conflicted = await readObservedMarket(
      q,
      kPool,
      "24h",
      { ...verified, decimals: 6 },
      "ledger",
    );
    assert.equal(conflicted.coverage.unitsConflict, true);
    assert.equal(conflicted.priceWei, null);
    assert.equal(conflicted.change, null);
    assert.deepEqual(conflicted.history.candles, []);
    assert.equal(conflicted.trades, k.trades);
    // The broad source reads K's deep stream as it always has.
    assert.equal(
      (await readObservedMarket(q, kPool, "24h", verified)).coverage.cutoff!.block,
      deepBlock,
    );

    // A deep publication newer than the ledger's cursor is served as today.
    const newer = cursorBlock + 1;
    await db.query("BEGIN");
    try {
      await db.query(
        `UPDATE analytics_pool_snapshots SET through_block=$1,through_hash=$2,
          snapshot=snapshot||jsonb_build_object('toBlock',$1::bigint,'blockHash',$2::text)`,
        [newer, word(newer)],
      );
      await db.query(
        "UPDATE analytics_accounting_pools SET through_block=$1,through_hash=$2",
        [newer, word(newer)],
      );
      const rows = await readProjectedExploreRows(q, "24h");
      const k = rows.find((r) => r.id === pools.K.id)!;
      assert.equal(k.marketCoverage!.source, "deep_publication");
      assert.equal(k.stats.priceWei, kaijuDeepPriceWei);
      assert.equal(k.stats.holders, 302);
    } finally {
      await db.query("ROLLBACK");
    }

    // A ledger whose cursor is not its newest batch, or whose hours run past
    // its cursor, fails closed on the ledger source only.
    const failsClosed = async (poke: string, values: unknown[]) => {
      await db.query(poke, values);
      for (const path of [launchOrder("24h"), `/v1/pools/${pools.N.id}?window=24h`]) {
        const ledger = await get("ledger", path);
        assert.equal(ledger.status, 503, path);
        assert.deepEqual(ledger.data, { error: "market_evidence_invalid" });
        assert.equal((await get("broad", path)).status, 200, path);
      }
    };
    await failsClosed("UPDATE agg_streams SET cursor_hash=decode($1,'hex')", [
      hex(cursorBlock + 1),
    ]);
    await db.query("UPDATE agg_streams SET cursor_hash=decode($1,'hex')", [hex(cursorBlock)]);
    await failsClosed("UPDATE agg_streams SET cursor_timestamp=$1", [H * 3600 - 1]);
    await db.query("UPDATE agg_streams SET cursor_timestamp=$1", [cursorTime]);
    assert.equal((await get("ledger", launchOrder("24h"))).status, 200);
  },
);

async function readProjectedExploreRows(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>,
  window: "24h",
) {
  const { readProjectedExplore } = await import("./projected-explore");
  return (
    await readProjectedExplore(query, { window, sort: "launch", limit: 100 }, "ledger")
  ).items;
}
