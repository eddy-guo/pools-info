import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createReader } from "./reader";
import { parseRequest } from "./request";
import type { LiveTradeFeedResponse } from "@pools/core";
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");

test(
  "Postgres recent feed: exact bounded rows, catalog union, source rewind and uninitialized isolation",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    const read = async (path: string) =>
      reader.read(parseRequest(path)) as Promise<any>;
    const feed = async (pool?: number): Promise<LiveTradeFeedResponse> =>
      read("/v1/live-trades" + (pool ? `?poolId=${word(pool)}` : ""));
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      const directory = new URL(
        "../../../packages/db/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await db.query(await readFile(new URL(name, directory), "utf8"));
      assert.equal((await feed()).coverage.state, "uninitialized");
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',1,99,$1)",
        [word(99)],
      );
      await db.query(
        "INSERT INTO indexer_batches VALUES(4663,'discovery:v1',1,99,$1,'test','{}')",
        [word(99)],
      );
      const poolArgs = (i: number) => [
        word(i),
        address(i),
        `Token${i}`,
        `T${i}`,
        word(10 + i),
        address(10 + i),
        now - 100,
      ];
      await db.query(
        "INSERT INTO indexed_pools VALUES(4663,$1,$2,$3,$4,99,$5,$6,$7,'discovery:v1',99)",
        poolArgs(1),
      );
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block) VALUES(4663,'discovery',100),(4663,'swaps',100)",
      );
      for (const [stream, from, to] of [
        ["discovery", 100, 199],
        ["swaps", 100, 198],
        ["swaps", 199, 199],
      ] as const) {
        await db.query(
          "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,$1,$2,$3,$4,$5,'test','{}')",
          [stream, from, to, word(to), now - 15],
        );
      }
      // The duplicated pool has the same verified identity and must appear once.
      for (const i of [1, 2])
        await db.query(
          "INSERT INTO recent_pools VALUES(4663,$1,$2,$3,$4,99,$5,$6,$7,'discovery',199)",
          poolArgs(i),
        );
      await db.query(
        "UPDATE recent_pools SET image_url='https://example.com/recent.png',description='Recent description',external_url='https://example.com/token'",
      );
      await db.query(
        "UPDATE recent_streams SET cursor_block=199,cursor_hash=$1,cursor_timestamp=$2,head_block=327,head_timestamp=$3,checked_at=now()",
        [word(199), now - 15, now],
      );
      const amount = "9007199254740993000000000000";
      for (let i = 0; i < 53; i++) {
        const block = i === 0 ? 198 : 199;
        await db.query(
          `INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
        VALUES(4663,$1,$2,$3,$4,$5,$1,$6,$7,$8,$9,$10,$10,$10,'buy')`,
          [
            block,
            word(i === 0 ? 1 : 2),
            address(i === 0 ? 1 : 2),
            word(1000 + i),
            i,
            word(block),
            now - 20,
            address(90),
            "-" + amount,
            amount,
          ],
        );
      }
      let result = await feed();
      assert.equal(result.coverage.state, "current");
      assert.equal(result.coverage.lagBlocks, 128);
      assert.equal(result.coverage.knownPools, 2);
      assert.equal(result.events.length, 50);
      assert.equal(result.truncated, true);
      assert.equal(result.events[0].ethWei, amount);
      assert.equal(result.events[0].id, word(1052) + ":52");
      assert.equal(result.events[0].transactionInitiator, address(90));
      assert.equal(result.events[0].launchTx, word(12));
      assert.equal((await feed(1)).events.length, 1);
      assert.equal((await feed(3)).events.length, 0);
      const catalog = await read("/v1/pools?limit=1");
      assert.equal(catalog.items[0].poolId, word(2));
      assert.equal(catalog.items[0].coverage.throughBlock, null);
      assert.equal(catalog.items[0].imageUrl, "https://example.com/recent.png");
      assert.equal(catalog.items[0].description, "Recent description");
      assert.deepEqual(catalog.items[0].metadataSources.imageUrl, {
        stream: "recent:discovery",
        batch: 199,
      });
      const next = await read("/v1/pools?limit=1&cursor=" + catalog.nextCursor);
      assert.equal(next.items[0].poolId, word(1));
      assert.equal(next.items[0].imageUrl, "https://example.com/recent.png");
      assert.equal(next.items[0].launch.sourceStream, "discovery:v1");
      assert.deepEqual(next.items[0].metadataSources.imageUrl, {
        stream: "recent:discovery",
        batch: 199,
      });
      assert.equal(next.nextCursor, null);
      await db.query(
        "UPDATE pool_launch_sources SET image_url='https://example.com/historical.png' WHERE pool_id=$1",
        [word(1)],
      );
      const overlapping = (await read(`/v1/pools/${word(1)}`)).pool;
      assert.equal(overlapping.imageUrl, "https://example.com/historical.png");
      assert.equal(overlapping.description, "Recent description");
      assert.deepEqual(overlapping.metadataSources.imageUrl, {
        stream: "discovery:v1",
        batch: 99,
      });
      assert.deepEqual(overlapping.metadataSources.description, {
        stream: "recent:discovery",
        batch: 199,
      });
      assert.equal((await read(`/v1/pools/${word(2)}`)).analytics, null);
      let explore = await read("/v1/explore");
      assert.equal(explore.coverage.catalogPools, 2);
      assert.equal(explore.coverage.processedPools, 0);
      const search = await read("/v1/search?q=Token2");
      assert.match(JSON.stringify(search), new RegExp(word(2)));
      // Rewind deletes batch-owned swaps. The next poll replaces all removed rows.
      await db.query("BEGIN");
      await db.query(
        "DELETE FROM recent_batches WHERE stream_key='swaps' AND to_block=199",
      );
      await db.query(
        "UPDATE recent_streams SET cursor_block=198,cursor_hash=$1 WHERE stream_key='swaps'",
        [word(198)],
      );
      await db.query("COMMIT");
      result = await feed();
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].poolId, word(1));
      assert.equal(result.coverage.throughHash, word(198));
      await db.query(
        "DELETE FROM recent_batches WHERE stream_key='discovery' AND to_block=199",
      );
      await db.query(
        "UPDATE recent_streams SET cursor_block=NULL,cursor_hash=NULL,cursor_timestamp=NULL WHERE stream_key='discovery'",
      );
      result = await feed();
      assert.equal(result.coverage.state, "uninitialized");
      assert.equal(result.events.length, 0);
      // Cached product model must not retain a launch removed by recent discovery.
      explore = await read("/v1/explore");
      assert.equal(explore.coverage.catalogPools, 1);
      const afterRewind = (await read(`/v1/pools/${word(1)}`)).pool;
      assert.equal(afterRewind.imageUrl, "https://example.com/historical.png");
      assert.equal(afterRewind.description, null);
      assert.equal(afterRewind.externalUrl, null);
      assert.equal(afterRewind.metadataSources.description, null);
      await assert.rejects(read(`/v1/pools/${word(2)}`), /pool_not_indexed/);
      // Identity disagreements across independent discovery sources fail closed.
      await db.query(
        "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'discovery',100,199,$1,$2,'test','{}')",
        [word(199), now],
      );
      await db.query(
        "INSERT INTO recent_pools VALUES(4663,$1,$2,$3,$4,99,$5,$6,$7,'discovery',199)",
        poolArgs(1),
      );
      await db.query("UPDATE recent_pools SET token=$1", [address(555)]);
      await assert.rejects(read("/v1/pools"), /catalog_identity_conflict/);
      await assert.rejects(feed(), /catalog_identity_conflict/);
      await assert.rejects(
        read("/v1/leaderboard"),
        /catalog_identity_conflict/,
      );
      await assert.rejects(
        read(`/v1/wallets/${address(90)}`),
        /catalog_identity_conflict/,
      );
      await assert.rejects(read("/ready"), /catalog_identity_conflict/);
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
