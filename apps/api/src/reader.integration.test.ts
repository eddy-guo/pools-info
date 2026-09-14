import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createReader } from "./reader";
import { parseRequest } from "./request";
import type { ChainSnapshot } from "@pools/core";
import { readData } from "./reader";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
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
      const migrationDir = new URL(
        "../../../packages/db/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(migrationDir))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await db.query(await readFile(new URL(name, migrationDir), "utf8"));
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
      const second = (await reader.read(
        parseRequest("/v1/pools?limit=1&cursor=" + first.nextCursor),
      )) as any;
      assert.equal(second.items[0].poolId, word(1));
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
      await assert.rejects(
        db.query("UPDATE analytics_pool_snapshots SET snapshot='{}'"),
        /check constraint/,
      );
      const explore = (await reader.read(
        parseRequest("/v1/explore?sort=volume&limit=1"),
      )) as any;
      assert.equal(explore.total, 2);
      assert.equal(explore.coverage.processedPools, 1);
      assert.equal(explore.items[0].stats.volumeWei, "250");
      const unprocessed = (await reader.read(
        parseRequest("/v1/explore?sort=volume&limit=1&offset=1"),
      )) as any;
      assert.equal(unprocessed.items[0].processed, false);
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
      const found = (await reader.read(
        parseRequest("/v1/search?q=Pepe"),
      )) as any;
      assert(found.entries.some((e: any) => e.address === address(1)));
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
