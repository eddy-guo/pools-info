import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { CreatorsResponse } from "@pools/core";
import { applyTestMigrations } from "./test-migrations";
import { createReader } from "./reader";
import { parseRequest } from "./request";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
// Above 2^53: the sum and the median must stay exact integers end to end.
const high = 900719925474099300001n;
/** Sender, deep window volume (null: never published), trade timestamp and
 * the trade's attributed wallet (null: unattributed). Sender 104 bought its
 * own launch 7; sender 105's launch was bought by someone else, and sender
 * 101's launch 3 was sold, not bought, by its sender. */
const launches: [number, number, bigint | null, number, number | null][] = [
  [1, 101, null, 0, null],
  [2, 101, 10n, 100000, null],
  [3, 101, high, 190000, 101],
  [4, 102, 0n, 0, null],
  [5, 102, 21n, 190000, null],
  [7, 104, 1n, 190000, 104],
  [8, 104, 2n, 190000, null],
  [9, 104, 3n, 190000, null],
  [10, 104, 4n, 190000, null],
  [11, 104, 4n, 190000, null],
  [12, 105, 5n, 190000, 106],
];

test(
  "Postgres creators group the whole catalog by launch sender with exact measured-only figures and stable pages",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_creators_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    const read = (parameters = "") =>
      reader.read(
        parseRequest("/v1/creators" + (parameters ? "?" + parameters : "")),
      ) as Promise<CreatorsResponse>;
    const senders = (response: CreatorsResponse) =>
      response.items.map((row) => Number(BigInt(row.address)));
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
      for (const [i, sender, volume, at, wallet] of launches) {
        await db.query(
          "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,$3,$4,$5,$6,$7,1000,'discovery:v1',10000)",
          [
            word(i),
            address(i),
            `Launch ${i}`,
            `L${i}`,
            100 + i,
            word(100 + i),
            address(sender),
          ],
        );
        if (volume === null) continue;
        const market = {
          id: word(i),
          token: address(i),
          name: `Launch ${i}`,
          symbol: `L${i}`,
          decimals: 0,
          supply: "1000",
          launchBlock: 100 + i,
          launchedAt: 1000,
          launchTx: word(100 + i),
          launchSender: address(sender),
          priceWei: "100",
          volumeWei: volume.toString(),
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
          "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,liquidity_wei,source_kind) VALUES(4663,$1,10000,$2,200000,$3,$4,NULL,'rpc_capture')",
          [word(i), word(10000), generatedAt, snapshot],
        );
        await db.query(
          "INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market,liquidity_wei) VALUES(4663,$1,1,10000,$2,100,1000,200000,$3,'rpc_capture',$4,NULL)",
          [word(i), word(10000), generatedAt, market],
        );
        if (volume === 0n) continue;
        if (wallet !== null)
          await db.query(
            "INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags) VALUES(4663,$1,$2,false,'{unknown_basis}')",
            [word(i), address(wallet)],
          );
        await db.query(
          "INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,wallet,execution,execution_supported) VALUES(4663,$1,$2,0,9000,$3,$4,$5,1,$6,$7,false)",
          [
            word(i),
            word(1000 + i),
            at,
            i === 3 ? "sell" : "buy",
            volume.toString(),
            wallet === null ? null : address(wallet),
            wallet === null ? null : { flags: ["unknown_basis"] },
          ],
        );
      }
      // A recent-only launch belongs to the blended catalog: it counts as a
      // launch for its sender and nowhere else.
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block) VALUES(4663,'discovery',100)",
      );
      await db.query(
        "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'discovery',100,199,$1,1000,'checksum','{}')",
        [word(199)],
      );
      await db.query(
        "INSERT INTO recent_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch) VALUES(4663,$1,$2,'Recent','R',150,$3,$4,1000,199)",
        [word(6), address(6), word(106), address(103)],
      );

      // Launch order lists every creator: launches, then volume, then address.
      const all = await read();
      assert.equal(all.total, 5);
      assert.equal(all.window, "All");
      assert.equal(all.sort, "launches");
      assert.equal(all.direction, "desc");
      assert.equal(all.attribution, "launch_transaction_initiator");
      assert.deepEqual(all.measuredFigures, [
        "measured",
        "traded",
        "volumeWei",
        "medianVolumeWei",
        "bestLaunch",
        "boughtOwnLaunch",
      ]);
      assert.match(all.note, /^launches counts every discovered launch/);
      assert.equal(all.broadMarketCutoff, null);
      assert.equal(all.coverage.catalogPools, 12);
      assert.equal(all.coverage.processedPools, 10);
      assert.deepEqual(senders(all), [104, 101, 102, 105, 103]);
      assert.equal(all.nextOffset, null);
      const [d, a, b, e, c] = all.items;
      // Sender 101: an unmeasured launch counts once, in launches; the sum
      // and the floor median of {10, high} stay exact above 2^53; its own
      // sell is not a bought launch.
      assert.deepEqual(a, {
        address: address(101),
        launches: 3,
        measured: 2,
        traded: 2,
        volumeWei: (high + 10n).toString(),
        medianVolumeWei: ((high + 10n) / 2n).toString(),
        boughtOwnLaunch: false,
        bestLaunch: {
          id: word(3),
          token: address(3),
          name: "Launch 3",
          symbol: "L3",
          launchBlock: 103,
          launchTx: word(103),
          launchSender: address(101),
          launchedAt: 1000,
          volumeWei: high.toString(),
        },
      });
      // Sender 102: a measured launch with no trades is measured (volume 0),
      // not traded; an even count takes the floor of the two middle values.
      assert.deepEqual(
        { ...b, bestLaunch: b.bestLaunch?.id },
        {
          address: address(102),
          launches: 2,
          measured: 2,
          traded: 1,
          volumeWei: "21",
          medianVolumeWei: "10",
          bestLaunch: word(5),
          boughtOwnLaunch: false,
        },
      );
      // Sender 103: the recent-only launch alone, so no measured figure.
      assert.deepEqual(c, {
        address: address(103),
        launches: 1,
        measured: 0,
        traded: 0,
        volumeWei: null,
        medianVolumeWei: null,
        bestLaunch: null,
        boughtOwnLaunch: null,
      });
      // Sender 104: odd count median; the best launch tie goes to the lowest
      // id; its own buy of launch 7 is sender-routed evidence.
      assert.deepEqual(
        { ...d, bestLaunch: [d.bestLaunch?.id, d.bestLaunch?.volumeWei] },
        {
          address: address(104),
          launches: 5,
          measured: 5,
          traded: 5,
          volumeWei: "14",
          medianVolumeWei: "3",
          bestLaunch: [word(10), "4"],
          boughtOwnLaunch: true,
        },
      );
      assert.equal(e.launches, 1);
      assert.equal(e.volumeWei, "5");
      // Someone else's buy of sender 105's launch is not the sender's.
      assert.equal(e.boughtOwnLaunch, false);
      // The launches tie between 105 and 103 breaks on volume, in both directions.
      assert.deepEqual(
        senders(await read("direction=asc")),
        [105, 103, 102, 101, 104],
      );
      // Metric orders list only creators with a measured launch.
      const expected = {
        "sort=volume": [101, 102, 104, 105],
        "sort=volume&direction=asc": [105, 104, 102, 101],
        "sort=median": [101, 102, 105, 104],
        "sort=median&direction=asc": [104, 105, 102, 101],
      };
      for (const [query, order] of Object.entries(expected)) {
        const full = await read(query);
        assert.equal(full.total, 4, query);
        assert.deepEqual(senders(full), order, query);
        assert.ok(full.items.every((row) => row.measured > 0));
      }
      // Every order pages one row at a time to the same list, with a constant
      // total and a nextOffset chain that ends in null.
      for (const query of ["", "direction=asc", ...Object.keys(expected)]) {
        const full = await read(query);
        const collected: number[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page = await read(
            `${query}${query ? "&" : ""}limit=1&offset=${offset}`,
          );
          assert.equal(page.total, full.total);
          assert.equal(page.items.length, 1);
          assert.equal(
            page.nextOffset,
            offset + 1 < full.total ? offset + 1 : null,
          );
          collected.push(...senders(page));
          offset = page.nextOffset;
        }
        assert.deepEqual(collected, senders(full), query);
      }
      // A page past the end keeps the population's total.
      const beyond = await read("sort=volume&offset=999999");
      assert.equal(beyond.total, 4);
      assert.deepEqual(beyond.items, []);
      assert.equal(beyond.nextOffset, null);
      // A window moves volumes, never which launches are measured: sender
      // 101's launch 2 traded before the 24h window, so it stays measured at
      // volume 0 and drops out of traded.
      const day = await read("window=24h&sort=volume");
      assert.equal(day.window, "24h");
      assert.equal(day.total, 4);
      assert.deepEqual(
        { ...day.items[0], bestLaunch: day.items[0].bestLaunch?.id },
        {
          address: address(101),
          launches: 3,
          measured: 2,
          traded: 1,
          volumeWei: high.toString(),
          medianVolumeWei: (high / 2n).toString(),
          bestLaunch: word(3),
          boughtOwnLaunch: false,
        },
      );
      // The flag reads the whole covered history, not the window: sender
      // 104's own buy predates a 1h window and still counts.
      const hour = await read("window=1h&sort=launches&limit=1");
      assert.equal(hour.items[0].address, address(104));
      assert.equal(hour.items[0].traded, 0);
      assert.equal(hour.items[0].boughtOwnLaunch, true);
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
