import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate } from "../../../packages/db/src/index";
import { createReader } from "./reader";
import { parseRequest } from "./request";
import type { ChainSnapshot } from "@pools/core";
import { readData } from "./reader";
import { validatePoolResponse } from "../../web/src/lib/pool-response";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
test(
  "Postgres: status counts exact pool identities, factory images and surviving discovery overlap",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_status_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      await migrate(db);

      const counts = async () =>
        ((await reader.read(parseRequest("/v1/status"))) as any).indexedPools;
      assert.deepEqual(await counts(), {
        total: "0",
        withFactoryImage: "0",
        discoveryV1: "0",
        discoveryV2: "0",
        discoveryV1V2Overlap: "0",
      });
      for (const stream of [
        "discovery:v1",
        "discovery:v2",
        "discovery:candidate",
      ]) {
        await db.query(
          "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'discovery',100,299,$2)",
          [stream, word(299)],
        );
        for (const end of [199, 299])
          await db.query(
            "INSERT INTO indexer_batches VALUES(4663,$1,$2,$3,$4,'checksum','{}')",
            [stream, end - 99, end, word(end)],
          );
      }
      for (const [id, stream, image] of [
        [1, "discovery:v1", null],
        [2, "discovery:v2", "ipfs://factory/two.png"],
        [3, "discovery:v1", null],
        [4, "discovery:candidate", "ipfs://factory/four.png"],
        [5, "discovery:v2", "   "],
      ] as const)
        await db.query(
          `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,
            launch_sender,launched_at,source_stream,source_batch,image_url)
          VALUES(4663,$1,$2,'Token','T',100,$3,$4,1000,$5,199,$6)`,
          [word(id), address(id), word(id + 10), address(90), stream, image],
        );
      // Multiple observations of the same pool must not inflate either source count.
      for (const end of [199, 299])
        await db.query(
          `INSERT INTO pool_launch_sources(chain_id,pool_id,stream_key,batch_end,image_url)
          VALUES(4663,$1,'discovery:v2',$2,'ipfs://factory/three.png')`,
          [word(3), end],
        );
      assert.equal(
        (
          await db.query(
            "SELECT source_stream FROM indexed_pools WHERE pool_id=$1",
            [word(3)],
          )
        ).rows[0].source_stream,
        "discovery:v2",
      );
      // A recent-only pool belongs to the blended catalog, not indexed_pools.
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block) VALUES(4663,'discovery',100)",
      );
      await db.query(
        `INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence)
        VALUES(4663,'discovery',100,199,$1,1000,'checksum','{}')`,
        [word(199)],
      );
      await db.query(
        `INSERT INTO recent_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch,image_url)
        VALUES(4663,$1,$2,'Recent','R',100,$3,$4,1000,199,'ipfs://factory/recent.png')`,
        [word(6), address(6), word(16), address(90)],
      );
      assert.deepEqual(await counts(), {
        total: "5",
        withFactoryImage: "3",
        discoveryV1: "2",
        discoveryV2: "3",
        discoveryV1V2Overlap: "1",
      });
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='discovery:v2' AND to_block=199",
      );
      assert.deepEqual(await counts(), {
        total: "3",
        withFactoryImage: "2",
        discoveryV1: "2",
        discoveryV2: "1",
        discoveryV1V2Overlap: "1",
      });
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='discovery:v2' AND to_block=299",
      );
      assert.deepEqual(await counts(), {
        total: "3",
        withFactoryImage: "1",
        discoveryV1: "2",
        discoveryV2: "0",
        discoveryV1V2Overlap: "0",
      });
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key='discovery:v1'",
      );
      assert.deepEqual(await counts(), {
        total: "1",
        withFactoryImage: "1",
        discoveryV1: "0",
        discoveryV2: "0",
        discoveryV1V2Overlap: "0",
      });
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
test(
  "Postgres: tied pagination, exact amounts, transfer participants, coverage and canonical feed boundary",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    // Never falls back to DATABASE_URL. All writes live in a throwaway schema.
    const schema = "api_test_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      await migrate(db);
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',100,199,$1)",
        [word(99)],
      );
      await db.query(
        "INSERT INTO indexer_batches VALUES(4663,'discovery:v1',100,199,$1,'checksum','{}')",
        [word(99)],
      );
      for (const i of [1, 2]) {
        await db.query(
          "INSERT INTO indexed_pools VALUES(4663,$1,$2,$3,$4,100,$5,$6,1000,'discovery:v1',199)",
          [
            word(i),
            address(i),
            i === 1 ? "Pepe_%" : "Other",
            "T" + i,
            word(10 + i),
            address(10 + i),
          ],
        );
        await db.query(
          "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'pool',$2,100,199,$3)",
          ["pool:" + word(i), word(i), word(99)],
        );
        await db.query(
          "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,$1,100,199,$2,'checksum',$3)",
          [
            "pool:" + word(i),
            word(99),
            JSON.stringify({
              headers: [{ number: "0xc7", hash: word(99), timestamp: "0x7d0" }],
            }),
          ],
        );
        await db.query(
          "INSERT INTO indexed_events VALUES(4663,$1,199,$2,0,150,$3,1500,'swap',$4,$5,$6,$7)",
          [
            "pool:" + word(i),
            word(20 + i),
            word(50),
            word(i),
            address(i),
            address(90),
            JSON.stringify({
              decoded: {
                amount0: "-90071992547409930000",
                amount1: "100000000000000000000",
              },
            }),
          ],
        );
      }
      await db.query(
        "INSERT INTO indexed_events VALUES(4663,$1,199,$2,1,150,$3,1500,'transfer',$4,$5,$6,$7)",
        [
          "pool:" + word(1),
          word(21),
          word(50),
          word(1),
          address(1),
          address(90),
          JSON.stringify({ from: address(90), to: address(91), value: "100" }),
        ],
      );
      const first = (await reader.read(
        parseRequest("/v1/pools?limit=1"),
      )) as any;
      assert.equal(first.items[0].poolId, word(2));
      assert.equal(first.items[0].imageUrl, null);
      await db.query(
        "UPDATE pool_launch_sources SET image_url=$2,description=$3,external_url=$4 WHERE pool_id=$1",
        [
          word(1),
          "ipfs://bafyfixture/token.png",
          "Verified factory description",
          "https://example.com/token",
        ],
      );
      const second = (await reader.read(
        parseRequest("/v1/pools?limit=1&cursor=" + first.nextCursor),
      )) as any;
      assert.equal(second.items[0].poolId, word(1));
      assert.equal(second.items[0].imageUrl, "ipfs://bafyfixture/token.png");
      assert.equal(second.items[0].description, "Verified factory description");
      assert.equal(second.items[0].externalUrl, "https://example.com/token");
      assert.equal(second.nextCursor, null);
      const literal = (await reader.read(
        parseRequest("/v1/pools?q=_%"),
      )) as any;
      assert.equal(literal.items.length, 1);
      const trades = (await reader.read(
        parseRequest("/v1/trades?limit=1"),
      )) as any;
      assert.equal(
        trades.items[0].payload.decoded.amount0,
        "-90071992547409930000",
      );
      const more = (await reader.read(
        parseRequest("/v1/trades?limit=1&cursor=" + trades.nextCursor),
      )) as any;
      assert.notEqual(more.items[0].id, trades.items[0].id);
      const wallet = (await reader.read(
        parseRequest(`/v1/wallets/${address(91)}/activity`),
      )) as any;
      assert.equal(wallet.items.length, 1);
      assert.equal(wallet.items[0].kind, "transfer");
      assert.equal(wallet.coverage.pnlAvailable, false);
      const feed = (await reader.read(
        parseRequest(`/v1/feed?pools=${word(1)},${word(2)}`),
      )) as any;
      assert.equal(feed.fromBlock, 100);
      assert.equal(feed.toBlock, 199);
      assert.equal(feed.toTimestamp, 2000); // Header timestamp, not last trade's 1500.
      assert.equal(feed.toBlockHash, word(99));
      assert.equal(feed.events.length, 2);
      const snapshot: ChainSnapshot = {
        schemaVersion: 1,
        chainId: 4663,
        generatedAt: "2026-09-15T00:00:00Z",
        fromBlock: 100,
        toBlock: 199,
        fromTimestamp: 1000,
        toTimestamp: 2000,
        blockHash: word(99),
        discoveredLaunches: 1,
        requests: 0,
        durationMs: 0,
        reconciliation: null,
        markets: [
          {
            id: word(1),
            token: address(1),
            name: "Pepe_%",
            symbol: "T1",
            decimals: 0,
            supply: "10000",
            launchBlock: 100,
            launchedAt: 1000,
            launchTx: word(11),
            launchSender: address(11),
            positionRecipient: address(11),
            strategy: address(9),
            creatorFees: false,
            fee: 100,
            priceWei: "2",
            volumeWei: "250",
            swaps: 2,
            buys: 1,
            sells: 1,
            series: [
              { time: 1000, wei: "1" },
              { time: 1500, wei: "2" },
            ],
            accounting: {
              wallets: [
                {
                  address: address(90),
                  swaps: 2,
                  buys: 1,
                  sells: 1,
                  volumeWei: "250",
                  realizedWei: "50",
                  inventoryRaw: "0",
                  balanceRaw: "0",
                  balanceMatches: true,
                  eligible: false,
                  flags: [],
                  evidenceTx: word(21),
                },
              ],
              executions: [
                {
                  trade: {
                    id: "buy",
                    poolId: word(1) as `0x${string}`,
                    trader: address(90) as `0x${string}`,
                    txHash: word(20) as `0x${string}`,
                    logIndex: 0,
                    block: 101,
                    timestamp: 1000,
                    side: "buy",
                    ethWei: "100",
                    tokenRaw: "100",
                  },
                  flags: [],
                  matchedTransfer: null,
                },
                {
                  trade: {
                    id: "sell",
                    poolId: word(1) as `0x${string}`,
                    trader: address(90) as `0x${string}`,
                    txHash: word(21) as `0x${string}`,
                    logIndex: 0,
                    block: 150,
                    timestamp: 1500,
                    side: "sell",
                    ethWei: "150",
                    tokenRaw: "100",
                  },
                  flags: [],
                  matchedTransfer: null,
                },
              ],
              unattributedSwaps: 0,
              transfersChecked: 2,
            },
          },
        ],
        trades: [
          {
            poolId: word(1),
            txHash: word(20),
            logIndex: 0,
            block: 101,
            timestamp: 1000,
            side: "buy",
            ethWei: "100",
            tokenRaw: "100",
          },
          {
            poolId: word(1),
            txHash: word(21),
            logIndex: 0,
            block: 150,
            timestamp: 1500,
            side: "sell",
            ethWei: "150",
            tokenRaw: "100",
          },
        ],
      };
      await db.query(
        "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind,source_stream,source_batch) VALUES(4663,$1,199,$2,2000,$3,'indexed',$4,199)",
        [word(1), word(99), JSON.stringify(snapshot), "pool:" + word(1)],
      );
      const { replaceAccountingRows } = await import(
        new URL("../../indexer/src/accounting-projection.ts", import.meta.url)
          .href
      );
      await db.query(
        "UPDATE analytics_pool_snapshots SET generated_at=$1 WHERE pool_id=$2",
        [snapshot.generatedAt, word(1)],
      );
      const publishedAt = (
        await db.query(
          "SELECT generated_at FROM analytics_pool_snapshots WHERE pool_id=$1",
          [word(1)],
        )
      ).rows[0].generated_at.toISOString();
      await db.query("BEGIN");
      await replaceAccountingRows(db, {
        snapshot,
        holders: null,
        liquidityWei: null,
        sourceKind: "indexed",
        generatedAt: publishedAt,
      });
      await db.query("COMMIT");
      await assert.rejects(
        db.query("UPDATE analytics_pool_snapshots SET snapshot='{}'"),
        /check constraint/,
      );
      const explore = (await reader.read(
        parseRequest("/v1/explore?sort=volume&limit=1"),
      )) as any;
      assert.equal(explore.total, 1);
      assert.equal(explore.coverage.catalogPools, 2);
      assert.equal(explore.nextOffset, null);
      assert.equal(explore.coverage.processedPools, 1);
      assert.equal(explore.items[0].stats.volumeWei, "250");
      const beyondMarketData = (await reader.read(
        parseRequest("/v1/explore?sort=volume&limit=1&offset=1"),
      )) as any;
      assert.deepEqual(beyondMarketData.items, []);
      const launches = (await reader.read(
        parseRequest("/v1/explore?sort=launch&limit=25"),
      )) as any;
      assert.equal(launches.total, 2);
      assert.equal(
        launches.items.filter((pool: any) => !pool.processed).length,
        1,
      );
      const leaderboard = (await reader.read(
        parseRequest("/v1/leaderboard?minTrades=0"),
      )) as any;
      assert.equal(leaderboard.items[0].realizedWei, "50");
      const profile = (await reader.read(
        parseRequest(`/v1/wallets/${address(90)}`),
      )) as any;
      assert.equal(profile.wallet.realizedWei, "50");
      assert.equal(profile.positions.length, 1);
      const details = (await reader.read(
        parseRequest(`/v1/pools/${word(1)}`),
      )) as any;
      assert.equal(details.analytics.audit.wallets[0].realizedWei, "50");
      // The website's validator also parses the published analytics snapshot,
      // so a pool with one attached must clear the same boundary.
      validatePoolResponse(JSON.parse(JSON.stringify(details)), word(1));
      const found = (await reader.read(
        parseRequest("/v1/search?q=Pepe"),
      )) as any;
      assert(found.entries.some((e: any) => e.address === address(1)));
      // Exercise the public product paths above the former 10,000-pool cap.
      // Only the requested page and bounded financial publications may enter JS.
      await db.query(`INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
        SELECT 4663,'0x'||lpad(to_hex(g),64,'0'),'0x'||lpad(to_hex(g),40,'0'),
          CASE WHEN g=22000 THEN 'FarawayNeedle_%' ELSE 'Bulk Token '||g END,'B'||g,
          100+(g%99),'0x'||lpad(to_hex(g+100000),64,'0'),'0x'||lpad(to_hex(500000),40,'0'),1000,
          'discovery:v1',199 FROM generate_series(10000,22000) g`);
      await db.query("ANALYZE indexed_pools");
      let largestRead = 0;
      let searchPlan: any = null;
      const boundedQuery = async (sql: string, values?: unknown[]) => {
        if (
          sql.includes("token_matches AS") &&
          values?.[0] === "farawayneedle_%"
        )
          searchPlan = (
            await db.query("EXPLAIN (ANALYZE,FORMAT JSON) " + sql, values)
          ).rows[0]["QUERY PLAN"];
        const result = await db.query(sql, values);
        largestRead = Math.max(largestRead, result.rows.length);
        return result;
      };
      const productRead = (path: string) =>
        readData(boundedQuery, parseRequest(path)) as Promise<any>;
      const large = await productRead("/v1/explore?sort=volume&limit=25");
      assert.equal(large.total, 1);
      assert.equal(large.coverage.catalogPools, 12003);
      assert.equal(large.coverage.processedPools, 1);
      assert.equal(large.items.length, 1);
      assert.equal(large.items[0].id, word(1));
      assert.equal(large.items[0].stats.volumeWei, "250");
      const largeLaunches = await productRead("/v1/explore?limit=25");
      assert.equal(largeLaunches.total, 12003);
      assert.equal(largeLaunches.items.length, 25);
      assert.deepEqual((await productRead("/v1/status")).indexedPools, {
        total: "12003",
        withFactoryImage: "1",
        discoveryV1: "12003",
        discoveryV2: "0",
        discoveryV1V2Overlap: "0",
      });
      const tail = await productRead(
        "/v1/explore?sort=launch&offset=12000&limit=25",
      );
      assert.equal(tail.items.length, 3);
      assert.equal(tail.nextOffset, null);
      assert.equal(tail.items.at(-1).id, word(21978));
      const needle = await productRead("/v1/explore?q=FarawayNeedle_%");
      assert.equal(needle.total, 1);
      assert.equal(needle.items[0].id, word(22000));
      const watch = await productRead(
        `/v1/explore?view=watchlist&sort=launch&direction=asc&ids=${word(1)},${word(22000)}&limit=1&offset=1`,
      );
      assert.equal(watch.total, 2);
      assert.equal(watch.items[0].id, word(22000));
      const lookedUp = await productRead("/v1/search?q=FarawayNeedle_%");
      assert(
        lookedUp.entries.some(
          (e: any) => e.group === "Tokens" && e.address === address(22000),
        ),
      );
      assert.equal(lookedUp.coverage.pools, 12003);
      assert(searchPlan);
      const planText = JSON.stringify(searchPlan);
      if (process.env.DEBUG_SQL_PLAN) {
        const nodes: any[] = [];
        const walk = (v: any) => {
          if (v && typeof v === "object") {
            if (v["Node Type"])
              nodes.push({
                type: v["Node Type"],
                relation: v["Relation Name"],
                index: v["Index Name"],
                cte: v["CTE Name"],
                filter: v.Filter,
              });
            for (const child of Object.values(v)) walk(child);
          }
        };
        walk(searchPlan);
        process.stdout.write(JSON.stringify(nodes) + "\n");
      }
      assert(
        !planText.includes('"CTE Name":"catalog"'),
        "catalog CTE must remain eligible for index pushdown",
      );
      assert(
        planText.includes("indexed_pools_name_search") ||
          planText.includes("indexed_pools_symbol_search"),
        "selective catalog text query should use pg_trgm indexes",
      );

      const broadSearch = await productRead("/v1/search?q=Bulk&group=Tokens");
      assert.equal(broadSearch.total, 12000);
      assert.equal(broadSearch.entries.length, 8);
      const idSearch = await productRead(
        `/v1/search?q=${word(22000)}&group=Tokens`,
      );
      assert.equal(idSearch.entries.length, 1);
      assert.equal(idSearch.entries[0].address, word(22000));
      assert.equal(
        (await productRead(`/v1/pools/${word(22000)}`)).analytics,
        null,
      );
      assert.equal(
        (await productRead("/v1/leaderboard?minTrades=0")).items[0].realizedWei,
        "50",
      );
      assert.equal(
        (await productRead(`/v1/wallets/${address(90)}`)).wallet.realizedWei,
        "50",
      );
      const prolific = await productRead(`/v1/wallets/${address(500000)}`);
      assert.equal(prolific.launches.length, 500);
      assert.equal(prolific.launchesTruncated, true);
      assert(
        largestRead <= 501,
        `Unexpected full catalog read: ${largestRead} rows`,
      );
      await db.query("DELETE FROM indexed_pools WHERE launch_sender=$1", [
        address(500000),
      ]);
      await db.query(
        "UPDATE indexer_batches SET evidence='{}' WHERE stream_key=$1",
        ["pool:" + word(1)],
      );
      await assert.rejects(
        reader.read(parseRequest(`/v1/feed?pools=${word(1)}`)),
        /feed_boundary_unavailable/,
      );
      await assert.rejects(
        reader.read(parseRequest(`/v1/pools/${word(999)}`)),
        /pool_not_indexed/,
      );
      assert.deepEqual(await reader.read(parseRequest("/ready")), {
        ready: true,
      });
      await db.query("DELETE FROM indexer_batches WHERE stream_key=$1", [
        "pool:" + word(1),
      ]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM analytics_pool_snapshots",
          )
        ).rows[0].count,
        "0",
      );
      // Fresh model after a rewind no longer exposes the deleted publication.
      const after = (await readData(
        (sql, values) => db.query(sql, values),
        parseRequest("/v1/explore"),
      )) as any;
      assert.equal(after.coverage.processedPools, 0);
      assert.equal(after.total, 2);
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
