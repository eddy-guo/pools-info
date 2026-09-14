import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createReader } from "./reader";
import { parseRequest } from "./request";

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
      await db.query(
        await readFile(
          new URL(
            "../../../packages/db/migrations/001_indexer.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
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
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
