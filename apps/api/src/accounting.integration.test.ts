import assert from "node:assert/strict";
import { applyTestMigrations } from "./test-migrations";
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
      await applyTestMigrations(db);
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
        assert.deepEqual(actual.items, expected.items, `leaderboard ${window}`);
        assert.equal(actual.total, expected.total);
        for (const i of [1, 2, 3, 4, 5, 501]) {
          const wallet = address(100000 + i),
            expected = walletAnalytics(model, wallet, window),
            actual = await read(`/v1/wallets/${wallet}?window=${window}`);
          assert.deepEqual(
            actual.wallet,
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
              ...p,
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
        tail.items,
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
