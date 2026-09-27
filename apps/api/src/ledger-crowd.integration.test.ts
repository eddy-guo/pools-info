import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createClient, migrate } from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createApi } from "./server";
import { crowdServedLagBlocks } from "./ledger-market";
// The website validates a pool page's response with this exact module.
import { validatePoolResponse } from "../../web/src/lib/pool-response";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hex = (n: number) => word(n).slice(2);
const H = 500000,
  cursor = 23600000,
  cursorTime = H * 3600 + 1800,
  e18 = 10n ** 18n,
  sqrt = 1000n * 10n ** 30n;
const I = word(901),
  X = word(902);

test(
  "Postgres HTTP: a crowd launch is served from the ledger like any other launch while the crowd stream is level, carries its launch type, and fills the crowd view",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = "api_test_crowd_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    const reader = createReader(process.env.TEST_DATABASE_URL, schema, {
      marketSource: "ledger",
    });
    const api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    t.after(async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await reader.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    const get = async (path: string) => {
      const response = await fetch(base + path);
      const body = await response.text();
      assert.equal(response.status, 200, `${path} ${body}`);
      return JSON.parse(body);
    };

    // Both launch lanes, one batch each below the cursor.
    for (const stream of ["launches:agg:v1", "launches:crowd:v1"]) {
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash)
        VALUES(4663,$1,'discovery',23467030,$2,$3)`,
        [stream, cursor - 10, word(cursor - 10)],
      );
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
        VALUES(4663,$1,23467030,$2,$3,$4,'{}')`,
        [stream, cursor - 10, word(cursor - 10), "f".repeat(64)],
      );
    }
    for (const [id, stream, type, name] of [
      [I, "launches:agg:v1", "instant", "Instant I"],
      [X, "launches:crowd:v1", "crowd", "Crowd X"],
    ])
      await db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch,decimals,token_total_supply_raw,token_supply_block,creator_fees,launch_type)
        VALUES(4663,$1,$2,$3,'SYM',23500000,$4,$5,$6,$7,$8,18,$9,$10,true,$11)`,
        [
          id,
          address(Number.parseInt(id.slice(-4), 16)),
          name,
          word(Number.parseInt(id.slice(-4), 16) + 7),
          address(98),
          (H - 10) * 3600,
          stream,
          cursor - 10,
          (10n ** 27n).toString(),
          cursor,
          type,
        ],
      );
    // The main ledger at its cursor, and each pool's folded hour and state.
    for (const key of ["ledger:agg:v1", "ledger:crowd:v1"])
      await db.query(
        `INSERT INTO agg_streams(chain_id,stream_key,start_block,mode) VALUES(4663,$1,23467030,'tip')`,
        [key],
      );
    const batch = async (key: string, to: number) => {
      await db.query(
        `INSERT INTO agg_batches(chain_id,stream_key,to_block,from_block,from_parent_hash,block_hash,to_timestamp,archive_height,registry_pools,content_hash,query,pages,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,requests,bytes)
        VALUES(4663,$1,$2,23467030,decode($3,'hex'),decode($4,'hex'),$5,$6,1,decode($7,'hex'),'{}','{}',0,0,1,0,0,0,1,1)`,
        [key, to, hex(23467029), hex(to), cursorTime, to + 128, "e".repeat(64)],
      );
      await db.query(
        `UPDATE agg_streams SET cursor_block=$2,cursor_hash=decode($3,'hex'),cursor_timestamp=$4 WHERE stream_key=$1`,
        [key, to, hex(to), cursorTime],
      );
    };
    await batch("ledger:agg:v1", cursor);
    for (const [id, volume] of [
      [I, 2n * e18],
      [X, 5n * e18],
    ] as const) {
      const ref = `(SELECT pool_ref FROM indexed_pools WHERE pool_id='${id}')`;
      await db.query(
        `INSERT INTO agg_pool_hours(chain_id,pool_ref,hour,trades,buys,sells,unattributed,volume_wei,buyers,sellers,open_sqrt_price_x96,close_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_block,close_log_index)
        VALUES(4663,${ref},$1,3,3,0,0,$2,1,0,$3,$3,$3,$3,$4,0)`,
        [H, volume.toString(), sqrt.toString(), cursor - 5],
      );
      await db.query(
        `INSERT INTO agg_pool_state(chain_id,pool_ref,trades,volume_wei,holders,sqrt_price_x96,liquidity,tick,price_block,price_log_index,price_tx,price_timestamp,first_trade_timestamp,last_trade_timestamp)
        VALUES(4663,${ref},3,$1,1,$2,1,0,$3,0,decode($4,'hex'),$5,$5,$5)`,
        [
          volume.toString(),
          sqrt.toString(),
          cursor - 5,
          hex(7),
          cursorTime - 100,
        ],
      );
    }
    const explore = async (view = "all", sort = "volume") =>
      (await get(`/v1/explore?window=24h&sort=${sort}&view=${view}&limit=100`))
        .items as {
        id: string;
        launchType?: string;
        volumeWei?: string | null;
        market?: unknown;
      }[];
    const served = async (id: string) =>
      (await get(`/v1/pools/${id}?window=24h`)) as {
        pool: { launchType: string };
        market: {
          volumeWei?: string;
          coverage?: { unitBasis?: { source?: string } | null };
        } | null;
      };

    // A crowd stream too far behind the main cursor: its pool is catalogued
    // but not measured, while the Instant pool is.
    await batch("ledger:crowd:v1", cursor - crowdServedLagBlocks - 1);
    let rows = await explore("all", "launch");
    assert.deepEqual(rows.map((r) => r.launchType).sort(), [
      "crowd",
      "instant",
    ]);
    assert.deepEqual(
      (await explore()).map((r) => r.id),
      [I],
    );
    let page = await served(X);
    assert.equal(page.pool.launchType, "crowd");
    const ledgerServed = (p: typeof page) =>
      p.market?.coverage?.unitBasis?.source === "aggregate_ledger";
    assert.equal(ledgerServed(page), false);
    assert.equal(ledgerServed(await served(I)), true);

    // Level again: the crowd pool is served from its hours and state, first
    // by volume.
    await batch("ledger:crowd:v1", cursor);
    rows = await explore();
    assert.deepEqual(
      rows.map((r) => r.id),
      [X, I],
    );
    page = await served(X);
    assert.equal(ledgerServed(page), true);
    assert.equal(page.market?.volumeWei, (5n * e18).toString());
    validatePoolResponse(page, X);
    // The crowd view lists the crowd launches only.
    assert.deepEqual(
      (await explore("crowd")).map((r) => [r.id, r.launchType]),
      [[X, "crowd"]],
    );
    const crowd = await get("/v1/explore?window=24h&view=crowd&limit=100");
    assert.equal(crowd.message, undefined);
    assert.equal(crowd.total, 1);
  },
);
