import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  buildAnalyticsModel,
  foldTrades,
  leaderboardAnalytics,
  walletAnalytics,
  exploreAnalytics,
  type AnalyticsPublication,
  type ChainSnapshot,
} from "@pools/core";
import { readData, createReader } from "./reader";
import { parseRequest } from "./request";
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
// Compare every existing financial/status field against the unchanged verified
// core model. Only the explicitly additive attribution contract is removed.
function withoutAttributionMetadata(row: Record<string, any>) {
  const legacy = { ...row };
  for (const key of [
    "accountingTier",
    "attribution",
    "tier2PositionCount",
    "tier3PositionCount",
    "realizedPositionCount",
    "rankingTradeCount",
    "verifiedUnrealizedWei",
    "unrealizedScope",
    "flags",
  ])
    delete legacy[key];
  return legacy;
}
function publication(i: number): AnalyticsPublication {
  const id = word(i),
    wallet = address(100000 + i),
    asof = i === 5 ? 9000 : 10000;
  const definitions: {
    side: "buy" | "sell";
    eth: string;
    qty: string;
    time: number;
    flags: string[];
  }[] = [
    {
      side: "buy",
      eth: i === 1 ? "900719925474099300001" : "100",
      qty: "100",
      time: 1000,
      flags: [],
    },
    {
      side: "sell",
      eth: i === 1 ? "900719925474099300003" : i === 2 ? "100" : "150",
      qty: i === 1 ? "50" : "100",
      time: 7000,
      flags: [],
    },
  ];
  if (i === 4)
    definitions.push({
      side: "buy",
      eth: "1000",
      qty: "100",
      time: 7100,
      flags: ["unmatched_transfer"],
    });
  const executions = definitions.map((d, n) => ({
    trade: {
      id: word(i * 10 + n) + ":" + n,
      poolId: id,
      trader: wallet,
      txHash: word(i * 10 + n),
      logIndex: n,
      block: 101 + n,
      timestamp: d.time,
      side: d.side,
      ethWei: d.eth,
      tokenRaw: d.qty,
    },
    flags: d.flags,
    matchedTransfer: null,
  }));
  const folded = foldTrades(
    executions.filter((e) => !e.flags.length).map((e) => e.trade) as any,
  );
  const volume = definitions.reduce((n, d) => n + BigInt(d.eth), 0n).toString();
  const market = {
    id,
    token: address(i),
    name: `Pool ${i}`,
    symbol: `T${i}`,
    decimals: 0,
    supply: "100000",
    launchBlock: 100,
    launchedAt: 1000,
    launchTx: word(i + 10000),
    launchSender: address(900000 + i),
    positionRecipient: address(999),
    strategy: address(998),
    creatorFees: false,
    fee: 100,
    priceWei: "2",
    volumeWei: volume,
    swaps: definitions.length,
    buys: definitions.filter((d) => d.side === "buy").length,
    sells: 1,
    series: [
      { time: 1000, wei: "1" },
      { time: asof, wei: "2" },
    ],
    accounting: {
      wallets: [
        {
          address: wallet,
          swaps: definitions.length,
          buys: 1,
          sells: 1,
          volumeWei: volume,
          realizedWei: i === 3 ? null : folded.realizedWei,
          inventoryRaw: folded.quantity,
          balanceRaw: folded.quantity,
          balanceMatches: true,
          eligible: false,
          flags: i === 3 ? ["unknown_basis"] : [],
          evidenceTx: word(i * 10 + 1),
        },
      ],
      executions,
      unattributedSwaps: 0,
      transfersChecked: 2,
    },
  };
  if (i === 6 || i === 7) {
    const opening = 10n ** 40n,
      latest = i === 6 ? 2n * opening - 1n : 1n;
    market.series = [
      { time: 1000, wei: opening.toString() },
      { time: asof, wei: latest.toString() },
    ];
    market.priceWei = latest.toString();
  }
  return {
    snapshot: {
      schemaVersion: 1,
      chainId: 4663,
      generatedAt: "2026-09-15T00:00:00.000Z",
      fromBlock: 100,
      toBlock: 199,
      fromTimestamp: 1000,
      toTimestamp: asof,
      blockHash: word(999),
      discoveredLaunches: 1,
      requests: 0,
      durationMs: 0,
      reconciliation: null,
      markets: [market],
      trades: executions.map((e) => ({
        poolId: id,
        txHash: e.trade.txHash,
        logIndex: e.trade.logIndex,
        block: e.trade.block,
        timestamp: e.trade.timestamp,
        side: e.trade.side,
        ethWei: e.trade.ethWei,
        tokenRaw: e.trade.tokenRaw,
      })),
    } as ChainSnapshot,
    holders: null,
    liquidityWei: null,
    sourceKind: "rpc_capture",
    generatedAt: "2026-09-15T00:00:00.000Z",
  };
}
test(
  "Postgres SQL accounting matches core across 501 publications, carried basis, flags, stale cutoffs and ties",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = "api_test_" + randomBytes(8).toString("hex"),
      db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
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
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block) VALUES(4663,'discovery:v1','discovery',100)",
      );
      await db.query(
        "INSERT INTO indexer_batches VALUES(4663,'discovery:v1',100,199,$1,'test','{}')",
        [word(999)],
      );
      const { replaceAccountingRows } = await import(
        new URL("../../indexer/src/accounting-projection.ts", import.meta.url)
          .href
      );
      const publications = Array.from({ length: 501 }, (_, i) =>
        publication(i + 1),
      );
      for (const p of publications) {
        const m = p.snapshot.markets[0];
        await db.query(
          "INSERT INTO indexed_pools VALUES(4663,$1,$2,$3,$4,100,$5,$6,1000,'discovery:v1',199)",
          [m.id, m.token, m.name, m.symbol, m.launchTx, m.launchSender],
        );
        await db.query(
          "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,source_kind,evidence) VALUES(4663,$1,199,$2,$3,$4,$5,'rpc_capture','{}')",
          [
            m.id,
            p.snapshot.blockHash,
            p.snapshot.toTimestamp,
            p.generatedAt,
            JSON.stringify(p.snapshot),
          ],
        );
        await db.query("BEGIN");
        await replaceAccountingRows(db, p);
        await db.query("COMMIT");
      }
      const model = buildAnalyticsModel(
        publications.map((p) => {
          const m = p.snapshot.markets[0];
          return {
            id: m.id,
            token: m.token,
            name: m.name,
            symbol: m.symbol,
            launchBlock: m.launchBlock,
            launchTx: m.launchTx,
            launchSender: m.launchSender,
            launchedAt: m.launchedAt,
          };
        }),
        publications,
      );
      let largest = 0;
      const query = async (sql: string, values?: unknown[]) => {
        const r = await db.query(sql, values);
        largest = Math.max(largest, r.rows.length);
        return r;
      };
      const read = (path: string) =>
        readData(query, parseRequest(path)) as Promise<any>;
      for (const window of ["All", "1h", "6h", "24h", "7d", "30d"] as const) {
        const expected = leaderboardAnalytics(model, {
          window,
          minTrades: 0,
          limit: 100,
        });
        const actual = await read(
          `/v1/leaderboard?window=${window}&minTrades=0&limit=100`,
        );
        assert.deepEqual(
          actual.items.map(withoutAttributionMetadata),
          expected.items,
          `leaderboard ${window}`,
        );
        assert.ok(
          actual.items.every(
            (item: any) =>
              item.accountingTier === "tier3" &&
              item.tier2PositionCount === 0 &&
              item.rankingTradeCount === item.supportedTradeCount &&
              item.verifiedUnrealizedWei === item.unrealizedWei,
          ),
        );
        assert.equal(actual.total, expected.total);
        for (const i of [1, 2, 3, 4, 5, 501]) {
          const wallet = address(100000 + i),
            expected = walletAnalytics(model, wallet, window),
            actual = await read(`/v1/wallets/${wallet}?window=${window}`);
          assert.deepEqual(
            withoutAttributionMetadata(actual.wallet),
            expected.wallet,
            `wallet ${i}/${window}`,
          );
          assert.deepEqual(actual.trades, expected.trades);
          assert.deepEqual(
            actual.curve,
            expected.curve,
            `curve ${i}/${window}`,
          );
          assert.deepEqual(
            actual.positions.map((p: any) => ({
              ...Object.fromEntries(
                Object.entries(p).filter(
                  ([key]) => key !== "accountingTier" && key !== "attribution",
                ),
              ),
              flags: [...p.flags].sort(),
              position: p.position ? { ...p.position, realizations: [] } : null,
            })),
            expected.positions.map((p) => ({
              ...p,
              flags: [...p.flags].sort(),
              position: p.position ? { ...p.position, realizations: [] } : null,
            })),
          );
        }
        const expectedExplore = exploreAnalytics(model, {
            window,
            limit: 100,
            sort: "volume",
          }),
          actualExplore = await read(
            `/v1/explore?window=${window}&limit=100&sort=volume`,
          );
        for (let n = 0; n < expectedExplore.items.length; n++)
          assert.deepEqual(
            JSON.parse(JSON.stringify(actualExplore.items[n])),
            JSON.parse(JSON.stringify(expectedExplore.items[n])),
            `explore ${window}/${n}`,
          );
      }
      const tail = await read(
        "/v1/leaderboard?minTrades=0&offset=499&limit=100",
      );
      assert.deepEqual(
        tail.items.map(withoutAttributionMetadata),
        leaderboardAnalytics(model, { minTrades: 0, offset: 499, limit: 100 })
          .items,
      );
      // Real service reader runs queries with the production three-second timeout.
      assert.equal(
        (
          (await reader.read(
            parseRequest("/v1/leaderboard?minTrades=0"),
          )) as any
        ).coverage.processedPools,
        501,
      );
      assert.equal(
        (await read(`/v1/pools/${word(501)}`)).analytics.coverage
          .processedPools,
        501,
      );
      assert.equal(
        (await read(`/v1/search?q=${address(100501)}&group=Wallets`)).entries[0]
          .href,
        `/wallet/${address(100501)}/?window=All`,
      );
      assert(largest <= 501, `unbounded result: ${largest}`);
      // A verified pool owns its whole book. Recent initiators from that same
      // pool must never duplicate its beneficiary PnL, even for another wallet.
      await db.query(
        "INSERT INTO recent_streams(chain_id,stream_key,start_block,cursor_block,cursor_hash,cursor_timestamp) VALUES(4663,'discovery',100,199,$1,10000),(4663,'swaps',100,199,$1,10000)",
        [word(999)],
      );
      for (const stream of ["discovery", "swaps"])
        await db.query(
          "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,$1,100,199,$2,10000,'mixed-fixture','{}')",
          [stream, word(999)],
        );
      await db.query(
        "INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch) VALUES(4663,$1,$2,'Observed','OBS',100,$3,$4,1000,'discovery:v1',199)",
        [word(502), address(502), word(10502), address(900502)],
      );
      for (const [pool, wallet] of [
        [502, 100001],
        [1, 999999],
      ])
        await db.query(
          `INSERT INTO recent_swaps(chain_id,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,amount0,amount1,eth_wei,token_raw,side)
          SELECT 4663,199,$1,$2,'0x'||lpad(to_hex($3::integer+i),64,'0'),i,110+i,'0x'||lpad(to_hex(110+i),64,'0'),
            CASE WHEN i%2=0 THEN 1000+i ELSE 7000+i END,$4,
            CASE WHEN i%2=0 THEN '-100' ELSE '150' END,CASE WHEN i%2=0 THEN '100' ELSE '-100' END,
            CASE WHEN i%2=0 THEN '100' ELSE '150' END,'100',CASE WHEN i%2=0 THEN 'buy' ELSE 'sell' END
          FROM generate_series(0,9) i`,
          [word(pool), address(pool), pool * 10000, address(wallet)],
        );
      const serviceRead = (path: string) =>
        reader.read(parseRequest(path)) as Promise<any>;
      const mixed = await serviceRead(
        `/v1/wallets/${address(100001)}?window=1h`,
      );
      const verified = walletAnalytics(model, address(100001), "1h");
      assert.equal(mixed.wallet.accountingTier, "mixed");
      assert.equal(mixed.wallet.attribution, "mixed");
      assert.equal(
        mixed.wallet.realizedWei,
        (BigInt(verified.wallet.realizedWei!) + 250n).toString(),
      );
      assert.equal(mixed.wallet.tier2PositionCount, 1);
      assert.equal(mixed.wallet.tier3PositionCount, 1);
      assert.equal(mixed.wallet.supportedPositionCount, 1);
      assert.equal(
        mixed.wallet.netWei,
        (BigInt(verified.wallet.netWei!) + 750n).toString(),
      );
      assert.equal(
        mixed.wallet.volumeWei,
        (BigInt(verified.wallet.volumeWei) + 750n).toString(),
      );
      assert.ok(mixed.wallet.flags.includes("initiator_attribution"));
      assert.equal(mixed.curve.at(-1).wei, mixed.wallet.realizedWei);
      assert.equal(mixed.positions.filter((p: any) => p.supported).length, 1);
      const modeled = mixed.positions.find((p: any) => p.poolId === word(502));
      assert.equal(modeled.supported, false);
      assert.ok(modeled.flags.includes("missing_transfer_history"));
      assert.equal(modeled.realizedWei, "250");
      const duplicatedInitiator = await serviceRead(
        `/v1/wallets/${address(999999)}?window=All`,
      );
      assert.equal(duplicatedInitiator.wallet.realizedWei, null);
      assert.equal(duplicatedInitiator.positions.length, 0);
      const mixedBoard = await serviceRead(
        "/v1/leaderboard?window=1h&minTrades=0&limit=100",
      );
      const mixedRow = mixedBoard.items.find(
        (w: any) => w.address === address(100001),
      );
      assert.equal(mixedRow.realizedWei, mixed.wallet.realizedWei);
      assert.equal(mixedRow.accountingTier, "mixed");
      await db.query("DELETE FROM recent_batches WHERE stream_key='swaps'");
      const rewound = await serviceRead(
        `/v1/wallets/${address(100001)}?window=1h`,
      );
      assert.deepEqual(
        withoutAttributionMetadata(rewound.wallet),
        verified.wallet,
      );
      await db.query(
        "DELETE FROM analytics_accounting_pools WHERE pool_id=$1",
        [word(501)],
      );
      await assert.rejects(
        read("/v1/leaderboard"),
        /analytics_projection_pending/,
      );
    } finally {
      await reader.close();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
