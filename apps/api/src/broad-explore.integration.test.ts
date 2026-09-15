import assert from "node:assert/strict";
import test from "node:test";
import {
  rebuildBroadMarket,
  rewind,
  getStream,
} from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { createApi } from "./server";
import {
  marketDatabase,
  marketUnits,
  marketWord as word,
  marketAddress as address,
  marketFirst as first,
  marketAmount,
} from "../../../tests/support/broad-market-db";

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
    const all = (await get("sort=trades&window=All&limit=100")).data;
    assert.equal(all.items[0].stats.trades, 21001);
    assert.equal(all.total, 31);
    assert.equal(all.items.at(-1).stats.trades, null);
    for (const sort of ["volume", "price", "trades", "change", "launch"])
      for (const direction of ["asc", "desc"]) {
        const full = (
          await get(`sort=${sort}&direction=${direction}&limit=100`)
        ).data.items.map((p: any) => p.id);
        const collected: string[] = [];
        for (let offset = 0; offset < 31; offset += 7) {
          const p = (
            await get(
              `sort=${sort}&direction=${direction}&limit=7&offset=${offset}`,
            )
          ).data;
          assert.equal(p.total, 31);
          collected.push(...p.items.map((r: any) => r.id));
        }
        assert.deepEqual(collected, full);
        assert.equal(new Set(collected).size, 31);
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
    await db.query(
      `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
      SELECT 4663,'0x'||lpad(to_hex(i+50000),64,'0'),'0x'||lpad(to_hex(i+50000),40,'0'),
      'Scale launch '||i,'S'||i,$1,'0x'||lpad(to_hex(i+90000),64,'0'),$2,100000,'discovery:v2',$3
      FROM generate_series(1,52000)i`,
      [first, address(99), first + 29999],
    );
    await db.query("ANALYZE");
    page = await get("sort=trades&window=All&limit=25");
    assert.equal(page.status, 200, JSON.stringify(page.data));
    assert.equal(page.data.total, 52031);
    assert.equal(page.data.items.length, 25);
    assert.equal(page.data.items[0].stats.trades, 18000);
    assert.equal(page.data.nextOffset, 25);
  },
);
