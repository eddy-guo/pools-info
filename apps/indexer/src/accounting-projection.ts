import {
  buildAnalyticsModel,
  walletMetrics,
  type AnalyticsPublication,
  type ChainTrade,
  type ObservedExecution,
} from "@pools/core";
import type { Client } from "@pools/db";

export type StoredPublication = AnalyticsPublication & {
  sourceKind: "indexed" | "rpc_capture";
};
interface ProjectedPosition {
  wallet: string;
  supported: boolean;
  flags: string[];
  quantity_raw: string | null;
  cost_wei: string | null;
  invested_wei: string | null;
  proceeds_wei: string | null;
  realized_wei: string | null;
  unrealized_wei: string | null;
  buys: number | null;
  sells: number | null;
}
interface ProjectedTrade {
  transaction_hash: string;
  log_index: number;
  block_number: number;
  timestamp: number;
  side: "buy" | "sell";
  eth_wei: string;
  token_raw: string;
  wallet: string | null;
  execution: ObservedExecution | null;
  execution_supported: boolean;
  realized_wei: string | null;
  disposed_cost_wei: string | null;
  closed_gain_wei: string | null;
  closed_hold_seconds: number | null;
}
const key = (t: ChainTrade) => `${t.txHash.toLowerCase()}:${t.logIndex}`;

/** Reuse the product's canonical deduplication and core integer accounting.
 * No cost basis is inferred from current balances or recomputed per window. */
export function projectAccountingRows(input: StoredPublication) {
  const model = buildAnalyticsModel(
    [input.snapshot.markets[0]],
    [input],
    input.generatedAt,
  );
  const publication = [...model.publications.values()][0];
  if (!publication) throw Error("analytics_accounting_missing_publication");
  const snapshot = publication.snapshot;
  const market = snapshot.markets[0];
  const trades = new Map<string, ProjectedTrade>();
  for (const t of snapshot.trades) {
    if (BigInt(t.ethWei) <= 0n || BigInt(t.tokenRaw) <= 0n)
      throw Error("analytics_accounting_invalid_amount");
    trades.set(key(t), {
      transaction_hash: t.txHash.toLowerCase(),
      log_index: t.logIndex,
      block_number: t.block,
      timestamp: t.timestamp,
      side: t.side,
      eth_wei: t.ethWei,
      token_raw: t.tokenRaw,
      wallet: null,
      execution: null,
      execution_supported: false,
      realized_wei: null,
      disposed_cost_wei: null,
      closed_gain_wei: null,
      closed_hold_seconds: null,
    });
  }
  const positions: ProjectedPosition[] = [];
  for (const [wallet, audits] of model.walletAudits) {
    const audit = audits[0];
    const metrics = walletMetrics(audit, wallet, "All")!;
    const position = metrics.position;
    const supported =
      metrics.complete &&
      metrics.row.balanceMatches &&
      position?.realizedWei === metrics.row.realizedWei;
    const flags = new Set([
      ...metrics.row.flags,
      ...(!metrics.row.balanceMatches ? ["balance_mismatch"] : []),
      ...(position && position.realizedWei !== metrics.row.realizedWei
        ? ["accounting_mismatch"]
        : []),
    ]);
    if (!supported && !flags.size) flags.add("unsupported_accounting");
    positions.push({
      wallet,
      supported,
      flags: [...flags].sort(),
      quantity_raw: supported ? position!.quantity : null,
      cost_wei: supported ? position!.costWei : null,
      invested_wei: supported ? position!.investedWei : null,
      proceeds_wei: supported ? position!.proceedsWei : null,
      realized_wei: supported ? metrics.realizedWei : null,
      unrealized_wei: supported ? metrics.unrealizedWei : null,
      buys: supported ? position!.buys : null,
      sells: supported ? position!.sells : null,
    });
    let quantity = 0n;
    let opened = 0;
    let cycleGain = 0n;
    let realizationIndex = 0;
    for (const execution of metrics.trades) {
      const t = execution.trade;
      const row = trades.get(key(t));
      if (
        !row ||
        row.wallet !== null ||
        row.block_number !== t.block ||
        row.timestamp !== t.timestamp ||
        row.side !== t.side ||
        row.eth_wei !== t.ethWei ||
        row.token_raw !== t.tokenRaw ||
        t.poolId !== market.id
      )
        throw Error("analytics_accounting_execution_mismatch");
      row.wallet = wallet;
      row.execution = execution;
      row.execution_supported = execution.flags.length === 0;
      if (!supported || !row.execution_supported) continue;
      if (t.side === "buy") {
        if (quantity === 0n) {
          opened = t.timestamp;
          cycleGain = 0n;
        }
        quantity += BigInt(t.tokenRaw);
      } else {
        // Gains are assigned to the same ordered sales used by foldTrades.
        // This preserves integer-rounding carry and partial-disposal basis.
        const realization = position!.realizations[realizationIndex++];
        if (!realization || realization.timestamp !== t.timestamp)
          throw Error("analytics_accounting_realization_mismatch");
        row.realized_wei = realization.wei;
        row.disposed_cost_wei = (
          BigInt(t.ethWei) - BigInt(realization.wei)
        ).toString();
        quantity -= BigInt(t.tokenRaw);
        cycleGain += BigInt(realization.wei);
        if (quantity === 0n) {
          row.closed_gain_wei = cycleGain.toString();
          row.closed_hold_seconds = t.timestamp - opened;
        }
      }
    }
    if (
      supported &&
      (realizationIndex !== position!.realizations.length ||
        quantity.toString() !== position!.quantity)
    )
      throw Error("analytics_accounting_inventory_mismatch");
  }
  // An execution not attached to an audited wallet must not silently disappear.
  if (
    [...trades.values()].filter((t) => t.execution !== null).length !==
    (market.accounting?.executions?.length ?? 0)
  )
    throw Error("analytics_accounting_unmatched_execution");
  const { accounting: _accounting, series, ...metadata } = market;
  return {
    snapshot,
    publication,
    market: metadata,
    positions,
    trades: [...trades.values()],
    prices: series.map((p, ordinal) => ({
      ordinal,
      timestamp: p.time,
      price_wei: p.wei,
    })),
  };
}

/** Must be called inside the transaction holding the parent snapshot row lock.
 * Delete/reinsert is atomic to readers and cascades stale positions and sales. */
export async function replaceAccountingRows(
  db: Client,
  input: StoredPublication,
) {
  const projected = projectAccountingRows(input);
  const s = projected.snapshot;
  const poolId = s.markets[0].id;
  await db.query(
    "DELETE FROM analytics_accounting_pools WHERE chain_id=4663 AND pool_id=$1",
    [poolId],
  );
  const written = await db.query(
    `INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market,holders_count,liquidity_wei)
     SELECT chain_id,pool_id,1,through_block,through_hash,$5,$6,asof_timestamp,generated_at,source_kind,$7,$8,$9
     FROM analytics_pool_snapshots WHERE chain_id=4663 AND pool_id=$1 AND through_block=$2 AND through_hash=$3 AND generated_at=$4::timestamptz`,
    [
      poolId,
      s.toBlock,
      s.blockHash,
      input.generatedAt,
      s.fromBlock,
      s.fromTimestamp,
      JSON.stringify(projected.market),
      input.holders?.complete
        ? input.holders.positiveHoldersExcludingInfrastructure
        : null,
      input.liquidityWei,
    ],
  );
  if (written.rowCount !== 1)
    throw Error("analytics_accounting_publication_changed");
  for (let offset = 0; offset < projected.positions.length; offset += 1000)
    await db.query(
      `INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags,quantity_raw,cost_wei,invested_wei,proceeds_wei,realized_wei,unrealized_wei,buys,sells)
       SELECT 4663,$1,wallet,supported,flags,quantity_raw,cost_wei,invested_wei,proceeds_wei,realized_wei,unrealized_wei,buys,sells
       FROM jsonb_to_recordset($2::jsonb) AS r(wallet text,supported boolean,flags text[],quantity_raw numeric,cost_wei numeric,invested_wei numeric,proceeds_wei numeric,realized_wei numeric,unrealized_wei numeric,buys integer,sells integer)`,
      [
        poolId,
        JSON.stringify(projected.positions.slice(offset, offset + 1000)),
      ],
    );
  for (let offset = 0; offset < projected.trades.length; offset += 1000)
    await db.query(
      `INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,wallet,execution,execution_supported,realized_wei,disposed_cost_wei,closed_gain_wei,closed_hold_seconds)
       SELECT 4663,$1,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,wallet,execution,execution_supported,realized_wei,disposed_cost_wei,closed_gain_wei,closed_hold_seconds
       FROM jsonb_to_recordset($2::jsonb) AS r(transaction_hash text,log_index integer,block_number bigint,timestamp bigint,side text,eth_wei numeric,token_raw numeric,wallet text,execution jsonb,execution_supported boolean,realized_wei numeric,disposed_cost_wei numeric,closed_gain_wei numeric,closed_hold_seconds bigint)`,
      [poolId, JSON.stringify(projected.trades.slice(offset, offset + 1000))],
    );
  for (let offset = 0; offset < projected.prices.length; offset += 1000)
    await db.query(
      `INSERT INTO analytics_accounting_prices(chain_id,pool_id,ordinal,timestamp,price_wei)
       SELECT 4663,$1,ordinal,timestamp,price_wei FROM jsonb_to_recordset($2::jsonb) AS r(ordinal integer,timestamp bigint,price_wei numeric)`,
      [poolId, JSON.stringify(projected.prices.slice(offset, offset + 1000))],
    );
  return {
    positions: projected.positions.length,
    trades: projected.trades.length,
  };
}

/** Rebuild saved evidence only, one locked pool per transaction. No RPC calls.
 * A bounded batch can be resumed; canonical publication identity is the cursor. */
export async function backfillAccountingRows(db: Client, limit = 25) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error("analytics_accounting_invalid_backfill_limit");
  let processed = 0;
  for (; processed < limit; processed++) {
    await db.query("BEGIN");
    try {
      const row = (
        await db.query(
          `SELECT s.snapshot,s.holders,s.liquidity_wei,s.source_kind,s.generated_at::text AS generated_at
           FROM analytics_pool_snapshots s
           LEFT JOIN analytics_accounting_pools p USING(chain_id,pool_id)
           WHERE s.chain_id=4663 AND (p.pool_id IS NULL OR p.projection_version<>1 OR p.through_block<>s.through_block OR p.through_hash<>s.through_hash OR p.generated_at<>s.generated_at)
           ORDER BY s.pool_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) {
        await db.query("COMMIT");
        break;
      }
      await replaceAccountingRows(db, {
        snapshot: row.snapshot,
        holders: row.holders,
        liquidityWei: row.liquidity_wei,
        sourceKind: row.source_kind,
        // pg Date truncates database microseconds. Keep the exact SQL timestamp
        // when checking the locked publication identity during an upgrade.
        generatedAt: row.generated_at,
      });
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
  return processed;
}
