import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { applyTestMigrations } from "./test-migrations";
import test from "node:test";
import pg from "pg";
import type { AnalyticsExploreResponse } from "@pools/core";
import { createReader } from "./reader";
import { parseRequest } from "./request";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");

test(
  "Postgres explore keeps unmeasured launches by default and filters unavailable sorted metrics before pagination",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_explore_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    const read = (parameters = "") =>
      reader.read(
        parseRequest("/v1/explore" + (parameters ? "?" + parameters : "")),
      ) as Promise<AnalyticsExploreResponse>;
    const ids = (response: AnalyticsExploreResponse) =>
      response.items.map((pool) => Number(BigInt(pool.id)));
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      await applyTestMigrations(db);
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',100,10000,$1)",
        [word(10000)],
      );
      await db.query(
        "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v1',100,10000,$1,'fixture','{}')",
        [word(10000)],
      );
      const high = 900719925474099300001n;
      const volumes = new Map([
        [2, 0n],
        [3, high],
        [4, high - 1n],
        [5, 0n],
      ]);
      for (let i = 1; i <= 5; i++) {
        const launchBlock = i === 1 ? 9999 : 100 + i;
        const name = i <= 3 ? `Match ${i}` : `Other ${i}`;
        await db.query(
          "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,$3,$4,$5,$6,$7,1000,'discovery:v1',10000)",
          [
            word(i),
            address(i),
            name,
            `T${i}`,
            launchBlock,
            word(100 + i),
            address(99),
          ],
        );
        if (i === 1) continue;
        const liquidity =
          i === 5 ? null : i === 2 ? "0" : volumes.get(i)!.toString();
        const market = {
          id: word(i),
          token: address(i),
          name,
          symbol: `T${i}`,
          decimals: 0,
          supply: "1000",
          launchBlock,
          launchedAt: 1000,
          launchTx: word(100 + i),
          launchSender: address(99),
          priceWei: i === 5 ? null : "100",
          volumeWei: volumes.get(i)!.toString(),
        };
        const snapshot = {
          schemaVersion: 1,
          chainId: 4663,
          toBlock: 10000,
          blockHash: word(10000),
          toTimestamp: 200000,
          markets: [market],
        };
        const generatedAt = "2026-09-15T00:00:00Z";
        await db.query(
          "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,liquidity_wei,source_kind) VALUES(4663,$1,10000,$2,200000,$3,$4,$5,'rpc_capture')",
          [word(i), word(10000), generatedAt, snapshot, liquidity],
        );
        await db.query(
          "INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market,liquidity_wei) VALUES(4663,$1,1,10000,$2,100,1000,200000,$3,'rpc_capture',$4,$5)",
          [word(i), word(10000), generatedAt, market, liquidity],
        );
        if (volumes.get(i)! > 0n)
          await db.query(
            "INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,execution_supported) VALUES(4663,$1,$2,0,9000,190000,'buy',$3,1,false)",
            [word(i), word(1000 + i), volumes.get(i)!.toString()],
          );
        if (i !== 5) {
          const latest = i === 3 ? "150" : i === 4 ? "50" : "100";
          for (const [ordinal, timestamp, price] of [
            [0, 1000, "100"],
            [1, 190000, latest],
          ] as const)
            await db.query(
              "INSERT INTO analytics_accounting_prices(chain_id,pool_id,ordinal,timestamp,price_wei) VALUES(4663,$1,$2,$3,$4)",
              [word(i), ordinal, timestamp, price],
            );
        }
      }
      const launches = await read();
      assert.equal(launches.total, 5);
      assert.deepEqual(ids(launches), [1, 5, 4, 3, 2]);
      assert.equal(launches.items[0].processed, false);
      assert.equal(launches.items[0].stats.volumeWei, null);
      assert.equal((await read("view=new&sort=liquidity")).total, 5);

      for (const direction of ["asc", "desc"]) {
        const volume = await read(`sort=volume&direction=${direction}`);
        assert.equal(volume.total, 4);
        assert.deepEqual(
          ids(volume),
          direction === "asc" ? [2, 5, 4, 3] : [3, 4, 2, 5],
        );
        assert.ok(volume.items.every((pool) => pool.stats.volumeWei !== null));
        assert.equal(
          volume.items.find((pool) => pool.id === word(3))!.stats.volumeWei,
          high.toString(),
        );
        assert.equal(
          volume.items.find((pool) => pool.id === word(2))!.stats.volumeWei,
          "0",
        );
        const liquidity = await read(`sort=liquidity&direction=${direction}`);
        assert.equal(liquidity.total, 3);
        assert.deepEqual(
          ids(liquidity),
          direction === "asc" ? [2, 4, 3] : [3, 4, 2],
        );
        assert.ok(
          liquidity.items.every((pool) => pool.stats.liquidityWei !== null),
        );
        assert.equal(
          liquidity.items.find((pool) => pool.id === word(2))!.stats
            .liquidityWei,
          "0",
        );
        assert.equal(
          liquidity.items.find((pool) => pool.id === word(3))!.stats
            .liquidityWei,
          high.toString(),
        );
        const change = await read(`sort=change&direction=${direction}`);
        assert.equal(change.total, 3);
        assert.deepEqual(
          ids(change),
          direction === "asc" ? [4, 2, 3] : [3, 2, 4],
        );
        assert.equal(
          change.items.find((pool) => pool.id === word(2))!.stats.change,
          0,
        );
        for (const sort of ["volume", "liquidity", "change"]) {
          const expected = await read(`sort=${sort}&direction=${direction}`);
          const collected: number[] = [];
          let offset: number | null = 0;
          while (offset !== null) {
            const page = await read(
              `sort=${sort}&direction=${direction}&limit=1&offset=${offset}`,
            );
            assert.equal(page.total, expected.total);
            collected.push(...ids(page));
            offset = page.nextOffset;
          }
          assert.deepEqual(collected, ids(expected));
          assert.equal(new Set(collected).size, expected.total);
        }
      }
      assert.equal((await read("q=match")).total, 3);
      const search = await read("q=match&sort=volume&limit=1");
      assert.equal(search.total, 2);
      assert.deepEqual(ids(search), [3]);
      assert.equal(search.nextOffset, 1);
      assert.deepEqual(
        ids(await read("q=match&sort=volume&limit=1&offset=1")),
        [2],
      );
      for (const sort of ["volume", "liquidity", "change"]) {
        const empty = await read(`sort=${sort}&q=match%201&limit=1`);
        assert.equal(empty.total, 0);
        assert.deepEqual(empty.items, []);
        assert.equal(empty.nextOffset, null);
      }
      const watchlist = `view=watchlist&ids=${[word(1), word(2), word(4)].join(",")}`;
      assert.equal((await read(watchlist)).total, 3);
      for (const sort of ["volume", "liquidity", "change"]) {
        assert.equal((await read(`${watchlist}&sort=${sort}`)).total, 2);
        const intersection = await read(
          `${watchlist}&sort=${sort}&q=match&limit=1`,
        );
        assert.equal(intersection.total, 1);
        assert.deepEqual(ids(intersection), [2]);
        assert.equal(intersection.nextOffset, null);
      }
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
