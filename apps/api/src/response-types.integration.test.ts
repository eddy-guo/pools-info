import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createReader } from "./reader";
import { parseRequest } from "./request";
// The website proxies /api/product/pools/<id>/ through this exact module before
// it renders a pool page. Importing it, rather than restating its rules here,
// is what stops the two sides of the boundary drifting apart again.
import { validatePoolResponse } from "../../web/src/lib/pool-response";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const hex = (n: number) => "0x" + n.toString(16);

// Live chain magnitudes. These bigint columns are far too large for an integer
// column and far below 2^53, which is exactly where string drift stayed hidden.
const launchBlock = 64241574;
const launchedAt = 1789534827;
const cursorBlock = 64241600;
const cursorAt = 1789535400;
const swapBlock = 64241590;
const swapAt = 1789535000;
const transferBlock = 64241591;
const transferAt = 1789535100;
const pool = word(1);
const token = address(1);
const trader = address(90);
const recipient = address(91);
const poolStream = "pool:" + pool;

test(
  "Postgres: block heights and on-chain timestamps serialise as JSON numbers",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_types_" + randomBytes(8).toString("hex");
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
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash)
        VALUES(4663,'discovery:v1','discovery',$1,$2,$3)`,
        [launchBlock - 500, launchBlock, word(launchBlock)],
      );
      await db.query(
        "INSERT INTO indexer_batches VALUES(4663,'discovery:v1',$1,$2,$3,'checksum','{}')",
        [launchBlock - 500, launchBlock, word(launchBlock)],
      );
      await db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,
          launch_sender,launched_at,source_stream,source_batch)
        VALUES(4663,$1,$2,'Pepe','PEPE',$3,$4,$5,$6,'discovery:v1',$3)`,
        [pool, token, launchBlock, word(11), address(11), launchedAt],
      );
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash)
        VALUES(4663,$1,'pool',$2,$3,$4,$5)`,
        [poolStream, pool, launchBlock, cursorBlock, word(cursorBlock)],
      );
      await db.query(
        `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
        VALUES(4663,$1,$2,$3,$4,'checksum',$5)`,
        [
          poolStream,
          launchBlock,
          cursorBlock,
          word(cursorBlock),
          JSON.stringify({
            headers: [
              {
                number: hex(cursorBlock),
                hash: word(cursorBlock),
                timestamp: hex(cursorAt),
              },
            ],
          }),
        ],
      );
      await db.query(
        "INSERT INTO indexed_events VALUES(4663,$1,$2,$3,0,$4,$5,$6,'swap',$7,$8,$9,$10)",
        [
          poolStream,
          cursorBlock,
          word(700),
          swapBlock,
          word(swapBlock),
          swapAt,
          pool,
          token,
          trader,
          JSON.stringify({
            decoded: {
              amount0: "-1000000000000000000",
              amount1: "2500000000000000000000",
            },
          }),
        ],
      );
      await db.query(
        "INSERT INTO indexed_events VALUES(4663,$1,$2,$3,1,$4,$5,$6,'transfer',$7,$8,$9,$10)",
        [
          poolStream,
          cursorBlock,
          word(701),
          transferBlock,
          word(transferBlock),
          transferAt,
          pool,
          token,
          trader,
          JSON.stringify({ from: trader, to: recipient, value: "100" }),
        ],
      );

      // Read exactly what a client receives: the serialised HTTP body, not the
      // in-process objects, so a stringified bigint cannot slip past.
      const body = async (path: string) =>
        JSON.parse(JSON.stringify(await reader.read(parseRequest(path))));
      const number = (value: unknown, label: string) =>
        assert.equal(
          typeof value,
          "number",
          `${label} must serialise as a JSON number, got ${JSON.stringify(value)}`,
        );
      const text = (value: unknown, label: string) =>
        assert.equal(
          typeof value,
          "string",
          `${label} must stay an exact decimal string`,
        );
      const poolFields = (item: any, label: string) => {
        number(item.launch.block, `${label} launch.block`);
        number(item.launch.timestamp, `${label} launch.timestamp`);
        number(
          item.launch.sourceBatchThroughBlock,
          `${label} launch.sourceBatchThroughBlock`,
        );
        number(item.coverage.startBlock, `${label} coverage.startBlock`);
        number(item.coverage.throughBlock, `${label} coverage.throughBlock`);
      };
      const eventFields = (item: any, label: string) => {
        number(item.block, `${label} block`);
        number(item.timestamp, `${label} timestamp`);
        number(item.logIndex, `${label} logIndex`);
        number(item.coverage.startBlock, `${label} coverage.startBlock`);
        number(item.coverage.throughBlock, `${label} coverage.throughBlock`);
      };

      // The production defect: the pool page 404ed because this response failed
      // the website's validator on launch.block and launch.timestamp.
      const detail = await body(`/v1/pools/${pool}`);
      validatePoolResponse(detail, pool);
      poolFields(detail.pool, "pool detail");
      eventFields(detail.latestRecordedSwap, "latestRecordedSwap");
      assert.equal(detail.pool.launch.block, launchBlock);
      assert.equal(detail.pool.launch.timestamp, launchedAt);
      number(detail.market.coverage.cutoff.block, "market cutoff block");
      number(detail.market.coverage.cutoff.asOf, "market cutoff asOf");

      const catalog = await body("/v1/pools?limit=1");
      poolFields(catalog.items[0], "pools item");

      const trades = await body("/v1/trades?limit=1");
      eventFields(trades.items[0], "trades item");
      // Raw amounts are exact wei and token units; they must remain strings.
      text(trades.items[0].payload.decoded.amount0, "swap amount0");
      text(trades.items[0].payload.decoded.amount1, "swap amount1");

      const activity = await body(`/v1/wallets/${recipient}/activity`);
      eventFields(activity.items[0], "wallet activity item");
      text(activity.items[0].payload.value, "transfer value");

      const feed = await body(`/v1/feed?pools=${pool}`);
      number(feed.fromBlock, "feed fromBlock");
      number(feed.toBlock, "feed toBlock");
      number(feed.toTimestamp, "feed toTimestamp");
      number(feed.events[0].block, "feed event block");
      number(feed.events[0].timestamp, "feed event timestamp");
      number(feed.poolCoverage[0].startBlock, "feed coverage startBlock");
      number(feed.poolCoverage[0].throughBlock, "feed coverage throughBlock");
      text(feed.events[0].amount0, "feed event amount0");

      const status = await body("/v1/status");
      number(status.discovery[0].startBlock, "status startBlock");
      number(status.discovery[0].throughBlock, "status throughBlock");

      // A stream that has not committed a batch still reports a null cutoff
      // rather than a zero, which the website renders as unknown coverage.
      await db.query(
        "UPDATE indexer_streams SET cursor_block=NULL,cursor_hash=NULL WHERE stream_key=$1",
        [poolStream],
      );
      const uncovered = await body("/v1/pools?limit=1");
      assert.equal(uncovered.items[0].coverage.throughBlock, null);
      number(uncovered.items[0].launch.block, "uncovered launch.block");
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
