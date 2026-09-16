// The dump replay (design report sections 4.2 to 4.4, phase 1 acceptance):
// the restored production dump `pools_prod_shape` is read, never written.
// Runs only where that database is reachable (the local Postgres 18 test
// server on port 5418, or POOLS_PROD_SHAPE_URL); anywhere else, including CI,
// it skips with the reason printed. TEST_DATABASE_URL is not used.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  applyLedgerEvents,
  createLedgerState,
  planLedgerBatch,
  positionKey,
  type LedgerEvent,
  type LedgerSwap,
  type LedgerTransfer,
} from "@pools/core";
import { ledgerRules } from "./ledger";

const dumpUrl =
  process.env.POOLS_PROD_SHAPE_URL ??
  "postgresql://pools_test:pools_test@127.0.0.1:5418/pools_prod_shape";
const expected = {
  supportedPositions: 27970,
  realizedSales: 12025,
  supportedExecutions: 70346,
  deepEvents: { swap: 127080, transfer: 154533 },
};
/** Wei to ETH with five decimals, rounded half away from zero like the report. */
const eth = (wei: bigint) => {
  const unit = 10n ** 13n;
  const rounded =
    wei >= 0n ? (wei + unit / 2n) / unit : -((-wei + unit / 2n) / unit);
  return (Number(rounded) / 1e5).toFixed(5);
};

async function openDump(): Promise<{ db: pg.Client } | { skip: string }> {
  const db = new pg.Client({
    connectionString: dumpUrl,
    connectionTimeoutMillis: 3000,
    statement_timeout: 600000,
    application_name: "pools-ledger-replay",
  });
  try {
    await db.connect();
  } catch (error) {
    return {
      skip: `restored dump not reachable at ${dumpUrl.replace(/:[^:@/]+@/, ":***@")}: ${(error as Error).message}`,
    };
  }
  await db.query("SET default_transaction_read_only = on");
  const counts = await db
    .query(
      "SELECT (SELECT count(*)::int FROM analytics_accounting_positions WHERE supported) AS positions,(SELECT count(*)::int FROM analytics_accounting_trades WHERE realized_wei IS NOT NULL) AS sales",
    )
    .catch(() => null);
  if (
    !counts ||
    counts.rows[0].positions !== expected.supportedPositions ||
    counts.rows[0].sales !== expected.realizedSales
  ) {
    await db.end();
    return {
      skip: `database at ${dumpUrl} is not the restored production dump (${JSON.stringify(counts?.rows[0] ?? null)})`,
    };
  }
  return { db };
}

test("the incremental position reproduces every supported production position and every per-sale realized value", async (t) => {
  const opened = await openDump();
  if ("skip" in opened) return t.skip(opened.skip);
  const { db } = opened;
  t.after(() => db.end());
  const executions = await db.query(
    `SELECT pool_id,wallet,transaction_hash,log_index,block_number::text AS block,timestamp::text AS timestamp,side,eth_wei::text AS eth_wei,token_raw::text AS token_raw,
       realized_wei::text AS realized_wei,disposed_cost_wei::text AS disposed_cost_wei,closed_gain_wei::text AS closed_gain_wei,closed_hold_seconds::text AS closed_hold_seconds
     FROM analytics_accounting_trades WHERE chain_id=4663 AND execution_supported AND wallet IS NOT NULL ORDER BY block_number,log_index`,
  );
  assert.equal(executions.rowCount, expected.supportedExecutions);
  const events: LedgerEvent[] = executions.rows.map((r) => ({
    kind: "swap",
    txHash: r.transaction_hash,
    logIndex: r.log_index,
    block: Number(r.block),
    blockHash: "0x" + "0".repeat(64),
    timestamp: Number(r.timestamp),
    poolId: r.pool_id,
    wallet: r.wallet,
    attribution: "initiator",
    wrapper: false,
    side: r.side,
    ethWei: BigInt(r.eth_wei),
    tokenRaw: BigInt(r.token_raw),
    sqrtPriceX96: 1n,
    liquidity: 1n,
    tick: 0,
    initiator: r.wallet,
  }));
  const state = createLedgerState();
  const { sales } = applyLedgerEvents(state, events);
  const stored = await db.query(
    "SELECT pool_id,wallet,quantity_raw::text AS quantity_raw,cost_wei::text AS cost_wei,invested_wei::text AS invested_wei,proceeds_wei::text AS proceeds_wei,realized_wei::text AS realized_wei,buys,sells FROM analytics_accounting_positions WHERE chain_id=4663 AND supported",
  );
  let matched = 0;
  const mismatched: string[] = [];
  for (const row of stored.rows) {
    const p = state.positions.get(positionKey(row.pool_id, row.wallet));
    const same =
      p !== undefined &&
      p.supported &&
      p.quantity.toString() === row.quantity_raw &&
      p.cost.toString() === row.cost_wei &&
      p.invested.toString() === row.invested_wei &&
      p.proceeds.toString() === row.proceeds_wei &&
      p.realized.toString() === row.realized_wei &&
      p.buys === row.buys &&
      p.sells === row.sells;
    if (same) matched++;
    else mismatched.push(`${row.pool_id}:${row.wallet}`);
  }
  assert.deepEqual(
    {
      oldSupported: stored.rowCount,
      matched,
      mismatched: mismatched.slice(0, 5),
    },
    {
      oldSupported: expected.supportedPositions,
      matched: expected.supportedPositions,
      mismatched: [],
    },
  );
  // Per sale: realized, disposed cost and the cycle closure the old
  // projection recorded on the sale that returned the inventory to zero.
  const bySale = new Map(sales.map((s) => [`${s.txHash}:${s.logIndex}`, s]));
  let equal = 0;
  let closures = 0;
  const wrong: string[] = [];
  for (const r of executions.rows) {
    if (r.realized_wei === null) continue;
    const s = bySale.get(`${r.transaction_hash}:${r.log_index}`);
    const ok =
      s !== undefined &&
      s.supported &&
      s.realized.toString() === r.realized_wei &&
      s.disposedCost.toString() === r.disposed_cost_wei &&
      (s.closedGain === null ? null : s.closedGain.toString()) ===
        r.closed_gain_wei &&
      (s.closedHoldSeconds === null ? null : String(s.closedHoldSeconds)) ===
        r.closed_hold_seconds;
    if (ok) equal++;
    else wrong.push(`${r.transaction_hash}:${r.log_index}`);
    if (r.closed_gain_wei !== null) closures++;
  }
  assert.deepEqual(
    { storedSales: equal + wrong.length, equal, wrong: wrong.slice(0, 5) },
    {
      storedSales: expected.realizedSales,
      equal: expected.realizedSales,
      wrong: [],
    },
  );
  console.log(
    JSON.stringify({
      check: "refold_old_supported",
      oldSupported: stored.rowCount,
      matched,
      storedSales: equal,
      closuresChecked: closures,
    }),
  );
});

test("the attribution rule over the deep tier's raw evidence reproduces the report's three wallets", async (t) => {
  const opened = await openDump();
  if ("skip" in opened) return t.skip(opened.skip);
  const { db } = opened;
  t.after(() => db.end());
  const counts = await db.query(
    "SELECT kind,count(*)::int AS n FROM indexed_events WHERE chain_id=4663 GROUP BY kind ORDER BY kind",
  );
  assert.deepEqual(
    Object.fromEntries(counts.rows.map((r) => [r.kind, r.n])),
    expected.deepEvents,
  );
  const pools = await db.query(
    "SELECT p.pool_id,p.token FROM indexed_pools p WHERE p.chain_id=4663 AND EXISTS (SELECT 1 FROM indexed_events e WHERE e.chain_id=4663 AND e.pool_id=p.pool_id) ORDER BY p.pool_id",
  );
  // The dump holds no transaction `to`. The route label uses the old
  // execution's judgement where one exists (unsupported_route covered
  // tx.to and the swap's sender), else the swap's sender.
  const routes = await db.query(
    "SELECT transaction_hash,log_index,execution->'flags' AS flags FROM analytics_accounting_trades WHERE chain_id=4663 AND execution IS NOT NULL",
  );
  const flagged = new Set(
    routes.rows
      .filter((r) => (r.flags as string[]).includes("unsupported_route"))
      .map((r) => `${r.transaction_hash}:${r.log_index}`),
  );
  const state = createLedgerState();
  // Seven deep-tier swap logs were stored undecoded (amounts of one sign, not
  // a trade: `unsupportedReason`); a collector skips them as the deep tier did.
  const stats = {
    pools: 0,
    swaps: 0,
    undecodable: 0,
    transfers: 0,
    initiator: 0,
    counterparty: 0,
    unattributed: 0,
    multiSameToken: 0,
    inflowEvents: 0,
    outflowEvents: 0,
  };
  for (const pool of pools.rows) {
    const rows = await db.query(
      `SELECT kind,tx_hash,log_index,block_number::text AS block,block_hash,timestamp::text AS timestamp,transaction_sender,
         payload->'decoded'->>'side' AS side,payload->'decoded'->>'ethWei' AS eth_wei,payload->'decoded'->>'tokenRaw' AS token_raw,
         payload->'decoded'->>'sqrtPriceX96' AS sqrt_price,payload->'decoded'->>'liquidity' AS liquidity,payload->'decoded'->>'tick' AS tick,payload->'decoded'->>'sender' AS sender,
         payload->>'from' AS "from",payload->>'to' AS "to",payload->>'value' AS value
       FROM indexed_events WHERE chain_id=4663 AND pool_id=$1 ORDER BY block_number,log_index`,
      [pool.pool_id],
    );
    const swaps: LedgerSwap[] = [],
      transfers: LedgerTransfer[] = [];
    for (const r of rows.rows) {
      if (r.kind === "swap") {
        if (r.side === null) {
          stats.undecodable++;
          continue;
        }
        const id = `${r.tx_hash}:${r.log_index}`;
        const known = routes.rowCount ? flagged.has(id) : false;
        swaps.push({
          txHash: r.tx_hash,
          logIndex: r.log_index,
          block: Number(r.block),
          blockHash: r.block_hash,
          timestamp: Number(r.timestamp),
          poolId: pool.pool_id,
          token: pool.token,
          initiator: r.transaction_sender,
          txTo:
            known || r.sender.toLowerCase() !== ledgerRules.router
              ? null
              : ledgerRules.router,
          side: r.side,
          ethWei: r.eth_wei,
          tokenRaw: r.token_raw,
          sqrtPriceX96: r.sqrt_price,
          liquidity: r.liquidity,
          tick: Number(r.tick),
        });
      } else
        transfers.push({
          txHash: r.tx_hash,
          logIndex: r.log_index,
          block: Number(r.block),
          blockHash: r.block_hash,
          timestamp: Number(r.timestamp),
          token: pool.token,
          from: r.from,
          to: r.to,
          value: r.value,
        });
    }
    const events = planLedgerBatch(
      {
        swaps,
        transfers,
        registry: [{ poolId: pool.pool_id, token: pool.token }],
      },
      ledgerRules,
    );
    const byTx = new Map<string, number>();
    for (const s of swaps) byTx.set(s.txHash, (byTx.get(s.txHash) ?? 0) + 1);
    stats.multiSameToken += swaps.filter((s) => byTx.get(s.txHash)! > 1).length;
    stats.pools++;
    stats.swaps += swaps.length;
    stats.transfers += transfers.length;
    for (const e of events) {
      if (e.kind === "swap") stats[e.attribution]++;
      else if (e.kind === "unattributed_swap") stats.unattributed++;
      else if (e.kind === "inflow") stats.inflowEvents++;
      else stats.outflowEvents++;
    }
    applyLedgerEvents(state, events);
  }
  const positions = [...state.positions.values()];
  const summary = {
    ...stats,
    positions: positions.length,
    supported: positions.filter((p) => p.supported).length,
    excluded: positions.filter((p) => !p.supported).length,
    withInflow: positions.filter((p) => p.inflow > 0n).length,
    withInflowSupported: positions.filter((p) => p.inflow > 0n && p.supported)
      .length,
    excludedFlags: Object.fromEntries(
      [
        ...new Set(
          positions
            .filter((p) => !p.supported)
            .map((p) =>
              p.flags
                .filter(
                  (f) =>
                    f !== "zero_cost_inflow" &&
                    f !== "wrapper_route" &&
                    f !== "counterparty_route",
                )
                .join(","),
            ),
        ),
      ]
        .sort()
        .map((k) => [
          k,
          positions.filter(
            (p) =>
              !p.supported &&
              p.flags
                .filter(
                  (f) =>
                    f !== "zero_cost_inflow" &&
                    f !== "wrapper_route" &&
                    f !== "counterparty_route",
                )
                .join(",") === k,
          ).length,
        ]),
    ),
  };
  console.log(JSON.stringify({ check: "new_rule_stats", ...summary }));
  assert.equal(summary.swaps + summary.undecodable, expected.deepEvents.swap);
  assert.equal(summary.undecodable, 7);
  assert.equal(summary.transfers, expected.deepEvents.transfer);
  assert.equal(summary.multiSameToken, 123);
  assert.ok(
    summary.initiator + summary.counterparty >= 0.99 * summary.swaps,
    "at least 99 percent of swaps attribute",
  );
  // Report section 4.4: the three wallets, per pool, in ETH to five decimals.
  const wallets = {
    "0x42a68318a6d78644870d3a37ec9e708e3ea904f5": {
      "0x0fdcfde9483b3525a99275430fada91c1743fe4d8c9a83ddcc2104ea9280208f":
        "0.28197",
      "0xfc9cedda3fa98a78ca13c055aeaeef8eb3816129779f8bc5960a0dd9ca404961":
        "0.14300",
      "0xd6d5dfefccdfd6e45a62d1980faa3441ef32fa15ee110897990df12494752ff3":
        "0.50792",
      "0xe38aea5b2ba31e5a4d641f43a0b6a42ae3f20c19d7a9ceb533bc01ec8272c0f6":
        "0.11368",
      total: "1.04657",
    },
    "0x4c5617f7a2246eacb2c8c4b30e7f5413cc176699": {
      "0x0fdcfde9483b3525a99275430fada91c1743fe4d8c9a83ddcc2104ea9280208f":
        "0.18844",
      "0xd6d5dfefccdfd6e45a62d1980faa3441ef32fa15ee110897990df12494752ff3":
        "0.41977",
      "0xe150c01f38a9441a8d997ce687db4d831ffbd7c5ae731eaa77ea2fcaa889628e":
        "0.00790",
      "0xe38aea5b2ba31e5a4d641f43a0b6a42ae3f20c19d7a9ceb533bc01ec8272c0f6":
        "0.11070",
      "0xfc9cedda3fa98a78ca13c055aeaeef8eb3816129779f8bc5960a0dd9ca404961":
        "0.08689",
      total: "0.81370",
    },
    "0x2bdac9f3b06f5b507e4157a08938f8b98eb73c0d": {
      "0x0fdcfde9483b3525a99275430fada91c1743fe4d8c9a83ddcc2104ea9280208f":
        "-0.00131",
      "0xd6d5dfefccdfd6e45a62d1980faa3441ef32fa15ee110897990df12494752ff3":
        "0.62255",
      "0xfc9cedda3fa98a78ca13c055aeaeef8eb3816129779f8bc5960a0dd9ca404961":
        "0.01283",
      "0xe38aea5b2ba31e5a4d641f43a0b6a42ae3f20c19d7a9ceb533bc01ec8272c0f6":
        "0.16633",
      total: "0.80040",
    },
  };
  const old = await db.query(
    "SELECT wallet,pool_id,realized_wei::text AS realized_wei,supported,flags FROM analytics_accounting_positions WHERE chain_id=4663 AND wallet = ANY($1::text[]) ORDER BY wallet,pool_id",
    [Object.keys(wallets)],
  );
  const report: Record<string, Record<string, string>> = {};
  for (const [wallet, pools] of Object.entries(wallets)) {
    const mine = positions.filter((p) => p.wallet === wallet && p.supported);
    let total = 0n;
    report[wallet] = {};
    for (const p of mine) total += p.realized;
    for (const poolId of Object.keys(pools)) {
      if (poolId === "total") continue;
      const p = mine.find((p) => p.poolId === poolId);
      const before = old.rows.find(
        (r) => r.wallet === wallet && r.pool_id === poolId,
      );
      report[wallet][poolId] = p ? eth(p.realized) : "excluded";
      console.log(
        JSON.stringify({
          check: "wallet",
          wallet,
          pool: poolId,
          old:
            before?.realized_wei === null
              ? `excluded ${before.flags}`
              : before
                ? eth(BigInt(before.realized_wei))
                : "absent",
          new: report[wallet][poolId],
          flags: p?.flags ?? null,
        }),
      );
    }
    report[wallet].total = eth(total);
    assert.equal(
      mine.length,
      Object.keys(pools).length - 1,
      `${wallet} supported positions`,
    );
  }
  assert.deepEqual(report, wallets);
});
