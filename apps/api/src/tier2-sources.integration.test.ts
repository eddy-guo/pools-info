import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import type { AnalyticsWalletResponse } from "@pools/core";
import { createReader } from "./reader";
import { createApi } from "./server";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const first = 22754669;
const pool = word(1),
  token = address(1),
  wallet = address(99);
const discoveryEnd = first + 99;
const discoveryContent = "a".repeat(64);

test(
  "Postgres HTTP: Tier 2 source reconciliation and broad suffix rewind",
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const schema = "api_test_tier2_sources_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    // Disable the HTTP response cache so every mutation tests a fresh database read.
    const api = createApi(reader, { cacheMs: 0 });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as { port: number }).port;
    const get = async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/wallets/${wallet}?window=All`,
      );
      return {
        status: response.status,
        data: (await response.json()) as AnalyticsWalletResponse & {
          error?: string;
        },
      };
    };
    const closed = async (reason: string) => {
      const response = await get();
      assert.equal(response.status, 503, reason);
      assert.match(
        response.data.error ?? "",
        /^tier2_(identity_conflict|evidence_invalid|source_invalid)$/,
        "the rejection must come from source validation",
      );
      assert.equal(
        "wallet" in response.data,
        false,
        "invalid evidence must not return financial fields",
      );
    };
    const mutation = async (
      sql: string,
      values: unknown[],
      restore: () => Promise<unknown>,
      reason: string,
    ) => {
      await db.query(sql, values);
      try {
        await closed(reason);
      } finally {
        await restore();
      }
    };
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      const dir = new URL("../../../packages/db/migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((name) => name.endsWith(".sql"))
        .sort())
        await db.query(await readFile(new URL(name, dir), "utf8"));
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash)
      VALUES(4663,'discovery:v2','discovery',$1,$2,$3)`,
        [first, discoveryEnd, word(discoveryEnd)],
      );
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
      VALUES(4663,'discovery:v2',$1,$2,$3,$4,'{}')`,
        [first, discoveryEnd, word(discoveryEnd), discoveryContent],
      );
      await db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
      VALUES(4663,$1,$2,'Source token','SRC',$3,$4,$5,1000,'discovery:v2',$6)`,
        [pool, token, first, word(98), wallet, discoveryEnd],
      );
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,registry_revision,registry_source_revision)
      VALUES(4663,'swaps:broad:v1','broad',$1,'robinhood-instant-v2','2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f')`,
        [first],
      );
      const identity = JSON.stringify({
        pool_id: pool,
        token,
        launch_block: String(first),
        launch_tx: word(98),
        launch_sender: wallet,
        launched_at: "1000",
        source_batch: String(discoveryEnd),
        source_hash: word(discoveryEnd),
        source_content_hash: discoveryContent,
      });
      for (const [index, side, eth, qty] of [
        [0, "buy", "100", "10"],
        [1, "sell", "150", "10"],
      ] as const) {
        const end = first + index,
          time = 1000 + index;
        await db.query(
          `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
        VALUES(4663,'swaps:broad:v1',$1,$1,$2,$3,'{}')`,
          [end, word(end), "b".repeat(64)],
        );
        await db.query(
          `INSERT INTO broad_batches(chain_id,stream_key,batch_end,from_block,parent_hash,timestamp,discovery_stream,discovery_batch,discovery_hash,discovery_content_hash,serializer_version,serialized_group,observed_swaps,unregistered_swaps,unsupported_swaps)
        VALUES(4663,'swaps:broad:v1',$1,$1,$2,$3,'discovery:v2',$4,$5,$6,1,'{}',1,0,0)`,
          [
            end,
            word(end - 1),
            time,
            discoveryEnd,
            word(discoveryEnd),
            discoveryContent,
          ],
        );
        await db.query(
          `INSERT INTO broad_registry_members VALUES(4663,'swaps:broad:v1',$1,$2,$3)`,
          [end, pool, identity],
        );
        await db.query(
          `INSERT INTO broad_swaps(chain_id,stream_key,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,manager_sender,amount0,amount1,sqrt_price_x96,liquidity,tick,fee,side,eth_wei,token_raw,supported,flags)
        VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,0,$1,$5,$6,$7,$7,$8,$9,79228162514264337593543950336,100,0,2500,$10,$11,$12,false,ARRAY['missing_transfer_history'])`,
          [
            end,
            pool,
            token,
            word(10 + index),
            word(end),
            time,
            wallet,
            side === "buy" ? "-" + eth : eth,
            side === "buy" ? qty : "-" + qty,
            side,
            eth,
            qty,
          ],
        );
      }
      await db.query(
        `UPDATE indexer_streams SET cursor_block=$1,cursor_hash=$2 WHERE stream_key='swaps:broad:v1'`,
        [first + 1, word(first + 1)],
      );
      for (const stream of ["discovery", "swaps"]) {
        await db.query(
          `INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,$1,$2,$3,$4,1001)`,
          [stream, first, first + 1, word(first + 1)],
        );
        await db.query(
          `INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,$1,$2,$3,$4,1001,'recent','{}')`,
          [stream, first, first + 1, word(first + 1)],
        );
      }
      await db.query(
        `INSERT INTO recent_swaps SELECT chain_id,'swaps',$1,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0::text,amount1::text,eth_wei::text,token_raw::text,side FROM broad_swaps`,
        [first + 1],
      );

      await t.test(
        "identical broad/recent copies are counted exactly once",
        async () => {
          const response = await get();
          assert.equal(response.status, 200);
          assert.equal(response.data.wallet.accountingTier, "tier2");
          assert.equal(response.data.wallet.tradeCount, 2);
          assert.equal(response.data.wallet.volumeWei, "250");
          assert.equal(response.data.wallet.realizedWei, "50");
          assert.equal(response.data.positions.length, 1);
          assert.equal(response.data.trades.length, 2);
          assert.equal(
            new Set(response.data.trades.map((row) => row.trade.id)).size,
            2,
          );
        },
      );
      await t.test("conflicting amounts fail closed", async () =>
        mutation(
          "UPDATE recent_swaps SET eth_wei='151',amount0='151' WHERE tx_hash=$1",
          [word(11)],
          () =>
            db.query(
              "UPDATE recent_swaps SET eth_wei='150',amount0='150' WHERE tx_hash=$1",
              [word(11)],
            ),
          "same tx/log with different ETH amounts",
        ),
      );
      await t.test("conflicting transaction initiators fail closed", async () =>
        mutation(
          "UPDATE recent_swaps SET transaction_sender=$1 WHERE tx_hash=$2",
          [address(100), word(11)],
          () =>
            db.query(
              "UPDATE recent_swaps SET transaction_sender=$1 WHERE tx_hash=$2",
              [wallet, word(11)],
            ),
          "same tx/log with different attribution identity",
        ),
      );
      await t.test(
        "a conflicting copy targeting an undiscovered pool fails closed",
        async () =>
          mutation(
            "UPDATE recent_swaps SET pool_id=$1 WHERE tx_hash=$2",
            [word(999), word(11)],
            () =>
              db.query("UPDATE recent_swaps SET pool_id=$1 WHERE tx_hash=$2", [
                pool,
                word(11),
              ]),
            "a same tx/log conflict must not disappear when its pool is absent from books",
          ),
      );
      await t.test("conflicting token identity fails closed", async () =>
        mutation(
          "UPDATE recent_swaps SET token=$1 WHERE tx_hash=$2",
          [address(999), word(11)],
          () =>
            db.query("UPDATE recent_swaps SET token=$1 WHERE tx_hash=$2", [
              token,
              word(11),
            ]),
          "same tx/log with different token identity",
        ),
      );
      await t.test(
        "a broad copy targeting an undiscovered pool fails closed",
        async () => {
          const target = word(999);
          await db.query(
            "INSERT INTO broad_registry_members VALUES(4663,'swaps:broad:v1',$1,$2,$3)",
            [first + 1, target, identity],
          );
          try {
            await mutation(
              "UPDATE broad_swaps SET pool_id=$1 WHERE tx_hash=$2",
              [target, word(11)],
              () =>
                db.query("UPDATE broad_swaps SET pool_id=$1 WHERE tx_hash=$2", [
                  pool,
                  word(11),
                ]),
              "the reverse source mutation cannot hide a same tx/log conflict",
            );
          } finally {
            await db.query(
              "DELETE FROM broad_registry_members WHERE pool_id=$1",
              [target],
            );
          }
        },
      );
      await t.test(
        "matching signed leading-zero amounts remain identical copies",
        async () => {
          await db.query(
            "UPDATE recent_swaps SET amount0='-0100',amount1='0010' WHERE tx_hash=$1",
            [word(10)],
          );
          await db.query(
            "UPDATE recent_swaps SET amount0='0150',amount1='-0010' WHERE tx_hash=$1",
            [word(11)],
          );
          try {
            const response = await get();
            assert.equal(response.status, 200);
            assert.equal(response.data.wallet.realizedWei, "50");
            assert.equal(response.data.wallet.tradeCount, 2);
            assert.equal(response.data.wallet.volumeWei, "250");
          } finally {
            await db.query(
              "UPDATE recent_swaps SET amount0='-100',amount1='10' WHERE tx_hash=$1",
              [word(10)],
            );
            await db.query(
              "UPDATE recent_swaps SET amount0='150',amount1='-10' WHERE tx_hash=$1",
              [word(11)],
            );
          }
        },
      );
      await t.test(
        "a conflicting copy targeting a deep-owned pool fails closed",
        async () => {
          const target = word(998);
          await db.query(
            `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
          VALUES(4663,$1,$2,'Deep target','DEEP',$3,$4,$5,1000,'discovery:v2',$6)`,
            [target, address(998), first, word(997), wallet, discoveryEnd],
          );
          await db.query(
            `INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind)
          VALUES(4663,$1,$2,$3,1001,$4,'rpc_capture')`,
            [
              target,
              first + 1,
              word(first + 1),
              JSON.stringify({
                schemaVersion: 1,
                chainId: 4663,
                toBlock: first + 1,
                blockHash: word(first + 1),
                toTimestamp: 1001,
                markets: [{ id: target }],
              }),
            ],
          );
          await db.query(
            `INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market)
            VALUES(4663,$1,1,$2,$3,$4,1000,1001,(SELECT generated_at FROM analytics_pool_snapshots WHERE pool_id=$1),'rpc_capture','{}')`,
            [target, first + 1, word(first + 1), first],
          );
          try {
            const baseline = await get();
            assert.equal(
              baseline.status,
              200,
              "the deep-owned fixture is a complete matching projection",
            );
            assert.equal(baseline.data.wallet.realizedWei, "50");
            await mutation(
              "UPDATE recent_swaps SET pool_id=$1 WHERE tx_hash=$2",
              [target, word(11)],
              () =>
                db.query(
                  "UPDATE recent_swaps SET pool_id=$1 WHERE tx_hash=$2",
                  [pool, word(11)],
                ),
              "deep ownership cannot hide a conflicting recent copy for a broad tx/log",
            );
          } finally {
            await db.query("DELETE FROM indexed_pools WHERE pool_id=$1", [
              target,
            ]);
          }
        },
      );
      await t.test(
        "discovery checkpoint content drift fails closed",
        async () =>
          mutation(
            "UPDATE indexer_batches SET content_hash=$1 WHERE stream_key='discovery:v2'",
            ["c".repeat(64)],
            () =>
              db.query(
                "UPDATE indexer_batches SET content_hash=$1 WHERE stream_key='discovery:v2'",
                [discoveryContent],
              ),
            "registry depends on the exact discovery checkpoint",
          ),
      );
      await t.test("registry launch identity drift fails closed", async () =>
        mutation(
          "UPDATE broad_registry_members SET identity=jsonb_set(identity,'{launch_sender}',to_jsonb($1::text))",
          [address(100)],
          () =>
            db.query("UPDATE broad_registry_members SET identity=$1", [
              identity,
            ]),
          "registry launch identity must match discovery",
        ),
      );
      await t.test(
        "invalid source tips contribute no stale financial values",
        async () => {
          await db.query(
            "UPDATE indexer_streams SET cursor_hash=$1 WHERE stream_key='swaps:broad:v1'",
            [word(999)],
          );
          await db.query(
            "UPDATE recent_streams SET cursor_hash=$1 WHERE stream_key='swaps'",
            [word(999)],
          );
          try {
            const response = await get();
            assert.equal(response.status, 200);
            assert.equal(response.data.wallet.realizedWei, null);
            assert.equal(response.data.wallet.tradeCount, 0);
            assert.equal(response.data.positions.length, 0);
            assert.equal(response.data.trades.length, 0);
          } finally {
            await db.query(
              "UPDATE indexer_streams SET cursor_hash=$1 WHERE stream_key='swaps:broad:v1'",
              [word(first + 1)],
            );
            await db.query(
              "UPDATE recent_streams SET cursor_hash=$1 WHERE stream_key='swaps'",
              [word(first + 1)],
            );
          }
        },
      );
      await t.test(
        "reorg removes prior realized PnL with the broad suffix",
        async () => {
          // Remove the independent recent source first. Its valid copy would otherwise survive this broad-only rewind.
          await db.query("DELETE FROM recent_streams WHERE stream_key='swaps'");
          assert.equal((await get()).data.wallet.realizedWei, "50");
          await db.query(
            "DELETE FROM indexer_batches WHERE stream_key='swaps:broad:v1' AND to_block=$1",
            [first + 1],
          );
          const tip = (
            await db.query(
              "SELECT cursor_block,cursor_hash FROM indexer_streams WHERE stream_key='swaps:broad:v1'",
            )
          ).rows[0];
          assert.equal(Number(tip.cursor_block), first);
          assert.equal(tip.cursor_hash, word(first));
          const response = await get();
          assert.equal(response.status, 200);
          assert.equal(
            response.data.wallet.realizedWei,
            "0",
            "removed sale cannot remain in realized PnL",
          );
          assert.equal(response.data.wallet.tradeCount, 1);
          assert.equal(response.data.wallet.volumeWei, "100");
          assert.equal(response.data.trades.length, 1);
          assert.ok(response.data.curve.every((point) => point.wei === "0"));
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
      await reader.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
