import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { CreatorsResponse } from "@pools/core";
import { applyTestMigrations } from "./test-migrations";
import { creatorsNote, ledgerCreatorsNote } from "./creators-read";
import { createReader } from "./reader";
import { parseRequest } from "./request";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const hex = (n: number) => n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
// The ledger's range: launched from S (the stream's pinned start), folded
// through the cursor C inside hour H; its launch lane registered one batch
// below the cursor (LB) and one past it (LATER). The deep publications are
// dated at the cursor's time.
const S = 23467030,
  C = S + 9000,
  LB = S + 8000,
  LATER = S + 9500,
  H = 500000,
  T = H * 3600 + 1800;
/** pool, sender, launch block, launch batch, deep publication (window volume
 * and through block; null: never published), ledger hours (hour, trades,
 * volume). Sender 201 is the creator the ledger changes: P1 is published and
 * covered (the ledger's figure wins over a publication no newer than its
 * cursor), P2 and P3 are ledger-only (P3 with no swap at all: a proven zero),
 * and P4 was registered past the cursor. Sender 202's P5 is covered but its
 * publication is newer than the cursor, so the publication keeps serving it
 * and its ledger hours must be ignored. Sender 203's P6 launched before the
 * ledger's start and was never published. */
const launches: {
  id: number;
  sender: number;
  block: number;
  batch: number;
  deep: { volume: bigint; through: number } | null;
  hours: [number, number, bigint][];
}[] = [
  {
    id: 1,
    sender: 201,
    block: S + 2000,
    batch: LB,
    deep: { volume: 10n, through: S + 5000 },
    hours: [
      [H - 1, 2, 30n],
      [H, 1, 5n],
    ],
  },
  {
    id: 2,
    sender: 201,
    block: S + 2100,
    batch: LB,
    deep: null,
    hours: [[H - 30, 4, 100n]],
  },
  { id: 3, sender: 201, block: S + 2200, batch: LB, deep: null, hours: [] },
  { id: 4, sender: 201, block: S + 9200, batch: LATER, deep: null, hours: [] },
  {
    id: 5,
    sender: 202,
    block: S + 3000,
    batch: LB,
    deep: { volume: 7n, through: LATER },
    hours: [[H - 2, 9, 999n]],
  },
  { id: 6, sender: 203, block: S - 500, batch: LB, deep: null, hours: [] },
];
const sqrt = 79228162514264337593543950336n; // 2^96: price 1

const strip = (response: CreatorsResponse) => {
  const { generatedAt: _g, ...coverage } = response.coverage;
  return { ...response, coverage };
};

test(
  "Postgres creators under MARKET_SOURCE=ledger measure every launch the ledger covers from its hours, state and positions, and the broad rule keeps the rest",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_ledger_creators_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    const readers = {
      broad: createReader(process.env.TEST_DATABASE_URL, schema),
      ledger: createReader(process.env.TEST_DATABASE_URL, schema, {
        marketSource: "ledger",
      }),
    };
    const read = (source: keyof typeof readers, parameters = "") =>
      readers[source].read(
        parseRequest("/v1/creators" + (parameters ? "?" + parameters : "")),
      ) as Promise<CreatorsResponse>;
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      await applyTestMigrations(db);
      await db.query(
        `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'launches:agg:v1','discovery',$1,$2,$3)`,
        [S, LATER, word(LATER)],
      );
      for (const [from, to] of [
        [S, LB],
        [LB + 1, LATER],
      ])
        await db.query(
          `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'launches:agg:v1',$1,$2,$3,'fixture','{}')`,
          [from, to, word(to)],
        );
      for (const launch of launches) {
        await db.query(
          `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch,decimals)
          VALUES(4663,$1,$2,$3,$4,$5,$6,$7,$8,'launches:agg:v1',$9,18)`,
          [
            word(launch.id),
            address(launch.id),
            `Launch ${launch.id}`,
            `L${launch.id}`,
            launch.block,
            word(100 + launch.id),
            address(launch.sender),
            launch.block - S + 1000,
            launch.batch,
          ],
        );
        if (!launch.deep) continue;
        // A renderable publication dated at the cursor's time, with one buy
        // whose attributed wallet is the sender for P5 and nobody for P1.
        const market = {
          id: word(launch.id),
          token: address(launch.id),
          name: `Launch ${launch.id}`,
          symbol: `L${launch.id}`,
          decimals: 18,
          supply: "1000",
          launchBlock: launch.block,
          launchedAt: launch.block - S + 1000,
          launchTx: word(100 + launch.id),
          launchSender: address(launch.sender),
          priceWei: "100",
          volumeWei: launch.deep.volume.toString(),
        };
        const generatedAt = "2026-09-15T00:00:00Z";
        await db.query(
          `INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,liquidity_wei,source_kind)
          VALUES(4663,$1,$2,$3,$4,$5,$6,NULL,'rpc_capture')`,
          [
            word(launch.id),
            launch.deep.through,
            word(launch.deep.through),
            T,
            generatedAt,
            {
              schemaVersion: 1,
              chainId: 4663,
              toBlock: launch.deep.through,
              blockHash: word(launch.deep.through),
              toTimestamp: T,
              markets: [market],
            },
          ],
        );
        await db.query(
          `INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market,liquidity_wei)
          VALUES(4663,$1,1,$2,$3,$4,$5,$6,$7,'rpc_capture',$8,NULL)`,
          [
            word(launch.id),
            launch.deep.through,
            word(launch.deep.through),
            launch.block,
            launch.block - S + 1000,
            T,
            generatedAt,
            market,
          ],
        );
        const wallet = launch.sender === 202 ? address(202) : null;
        if (wallet)
          await db.query(
            `INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags) VALUES(4663,$1,$2,false,'{unknown_basis}')`,
            [word(launch.id), wallet],
          );
        await db.query(
          `INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,wallet,execution,execution_supported)
          VALUES(4663,$1,$2,0,$3,$4,'buy',$5,1,$6,$7,false)`,
          [
            word(launch.id),
            word(1000 + launch.id),
            launch.deep.through - 1,
            T - 100,
            launch.deep.volume.toString(),
            wallet,
            wallet === null ? null : { flags: ["unknown_basis"] },
          ],
        );
      }

      // Before the ledger has folded anything, the switch changes no byte.
      const before = strip(await read("broad"));
      assert.deepEqual(strip(await read("ledger")), before);
      assert.equal(before.note, creatorsNote);
      assert.deepEqual(
        before.items.map((r) => [
          Number(BigInt(r.address)),
          r.launches,
          r.measured,
          r.traded,
          r.volumeWei,
          r.medianVolumeWei,
          r.bestLaunch && Number(BigInt(r.bestLaunch.id)),
          r.boughtOwnLaunch,
        ]),
        [
          [201, 4, 1, 1, "10", "10", 1, false],
          [202, 1, 1, 1, "7", "7", 5, true],
          [203, 1, 0, 0, null, null, null, null],
        ],
      );

      // The ledger's cursor, the pools' hours and states, and the positions
      // that hold its own-buy evidence: sender 201 bought P2, its own launch,
      // and wallet 202 bought P1, which is not its own.
      await db.query(
        `INSERT INTO agg_streams(chain_id,stream_key,start_block,mode) VALUES(4663,'ledger:agg:v1',$1,'tip')`,
        [S],
      );
      await db.query(
        `INSERT INTO agg_batches(chain_id,stream_key,to_block,from_block,from_parent_hash,block_hash,to_timestamp,archive_height,registry_pools,content_hash,query,pages,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,requests,bytes)
        VALUES(4663,'ledger:agg:v1',$1,$2,decode($3,'hex'),decode($4,'hex'),$5,$6,6,decode($7,'hex'),'{}','{}',0,0,6,0,0,0,1,1)`,
        [C, S, hex(S - 1), hex(C), T, C + 128, "e".repeat(64)],
      );
      await db.query(
        `UPDATE agg_streams SET cursor_block=$1,cursor_hash=decode($2,'hex'),cursor_timestamp=$3`,
        [C, hex(C), T],
      );
      for (const launch of launches) {
        const ref = `(SELECT pool_ref FROM indexed_pools WHERE pool_id='${word(launch.id)}')`;
        for (const [hour, trades, volume] of launch.hours)
          await db.query(
            `INSERT INTO agg_pool_hours(chain_id,pool_ref,hour,trades,buys,sells,unattributed,volume_wei,buyers,sellers,open_sqrt_price_x96,close_sqrt_price_x96,high_sqrt_price_x96,low_sqrt_price_x96,close_block,close_log_index)
            VALUES(4663,${ref},$1,$2,$2,0,0,$3,1,0,$4,$4,$4,$4,$5,0)`,
            [hour, trades, volume.toString(), sqrt.toString(), C - 1],
          );
        if (launch.hours.length)
          await db.query(
            `INSERT INTO agg_pool_state(chain_id,pool_ref,trades,volume_wei,holders,sqrt_price_x96,liquidity,tick,price_block,price_log_index,price_tx,price_timestamp,first_trade_timestamp,last_trade_timestamp)
            VALUES(4663,${ref},$1,$2,1,$3,1,0,$4,0,decode($5,'hex'),$6,$6,$6)`,
            [
              launch.hours.reduce((sum, h) => sum + h[1], 0),
              launch.hours.reduce((sum, h) => sum + h[2], 0n).toString(),
              sqrt.toString(),
              C - 1,
              hex(7000 + launch.id),
              launch.hours[0][0] * 3600 + 60,
            ],
          );
      }
      for (const wallet of [201, 202])
        await db.query(
          `INSERT INTO agg_wallets(address,first_block) VALUES(decode($1,'hex'),$2)`,
          [address(wallet).slice(2), S],
        );
      for (const [pool, wallet] of [
        [2, 201],
        [1, 202],
      ])
        await db.query(
          `INSERT INTO agg_positions(chain_id,pool_ref,wallet_ref,quantity_raw,cost_wei,invested_wei,proceeds_wei,disposed_cost_wei,realized_wei,inflow_raw,outflow_raw,outflow_cost_wei,buys,sells,wrapper_swaps,counterparty_swaps,cycle_opened_at,cycle_gain_wei,first_block,last_block,last_timestamp,supported,flags)
          VALUES(4663,(SELECT pool_ref FROM indexed_pools WHERE pool_id=$1),(SELECT wallet_ref FROM agg_wallets WHERE address=decode($2,'hex')),10,5,5,0,0,0,0,0,0,1,0,0,0,$3,0,$4,$4,$3,true,'{}')`,
          [word(pool), address(wallet).slice(2), T - 3600, C - 1],
        );

      // The broad source is unchanged by the fold; the ledger measures every
      // launch it covers. All: P1 reads its state (35 over 3 trades) over the
      // older publication's 10, P2 its 100 over 4, P3 a proven zero, P4 stays
      // unmeasured; sender 201's volumes are then [0, 35, 100] with the median
      // 35 and the best launch P2, and its own buy of P2 is attributed. P5's
      // newer publication keeps its 7 and its sender-routed own buy.
      assert.deepEqual(strip(await read("broad")), before);
      const all = await read("ledger");
      assert.equal(all.note, ledgerCreatorsNote);
      const rows = (response: CreatorsResponse) =>
        response.items.map((r) => [
          Number(BigInt(r.address)),
          r.launches,
          r.measured,
          r.traded,
          r.volumeWei,
          r.medianVolumeWei,
          r.bestLaunch && Number(BigInt(r.bestLaunch.id)),
          r.bestLaunch && r.bestLaunch.volumeWei,
          r.boughtOwnLaunch,
        ]);
      assert.deepEqual(rows(all), [
        [201, 4, 3, 2, "135", "35", 2, "100", true],
        [202, 1, 1, 1, "7", "7", 5, "7", true],
        [203, 1, 0, 0, null, null, null, null, null],
      ]);
      assert.equal(all.total, 3);
      // Every other field is what the broad source serves.
      const { items: _i, note: _n, ...rest } = strip(all);
      const { items: _bi, note: _bn, ...beforeRest } = before;
      assert.deepEqual(rest, beforeRest);
      // A window is the whole hours ending with the newest: P2's hour is
      // outside 24h, so it is measured at zero and not traded, and 201's
      // volumes are [0, 0, 35]; the own-buy evidence spans the whole history.
      assert.deepEqual(rows(await read("ledger", "window=24h")), [
        [201, 4, 3, 1, "35", "0", 1, "35", true],
        [202, 1, 1, 1, "7", "7", 5, "7", true],
        [203, 1, 0, 0, null, null, null, null, null],
      ]);
      assert.deepEqual(rows(await read("broad", "window=24h")), [
        [201, 4, 1, 1, "10", "10", 1, "10", false],
        [202, 1, 1, 1, "7", "7", 5, "7", true],
        [203, 1, 0, 0, null, null, null, null, null],
      ]);
      // A metric order lists measured creators only, on the ledger's figures.
      const byVolume = await read("ledger", "sort=volume");
      assert.deepEqual(
        byVolume.items.map((r) => [Number(BigInt(r.address)), r.volumeWei]),
        [
          [201, "135"],
          [202, "7"],
        ],
      );
      assert.equal(byVolume.total, 2);
      const byMedian = await read("ledger", "sort=median&direction=asc");
      assert.deepEqual(
        byMedian.items.map((r) => [
          Number(BigInt(r.address)),
          r.medianVolumeWei,
        ]),
        [
          [202, "7"],
          [201, "35"],
        ],
      );
      // The hour window is one whole hours cannot answer: a covered launch
      // is unmeasured under it, so only the newer publication measures.
      assert.deepEqual(rows(await read("ledger", "window=1h")), [
        [201, 4, 0, 0, null, null, null, null, null],
        [202, 1, 1, 1, "7", "7", 5, "7", true],
        [203, 1, 0, 0, null, null, null, null, null],
      ]);
    } finally {
      for (const reader of Object.values(readers)) await reader.close();
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
