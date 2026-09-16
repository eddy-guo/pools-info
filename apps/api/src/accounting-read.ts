import {
  windows,
  type AnalyticsCoverage,
  type AnalyticsLeaderboardOptions,
  type AnalyticsLeaderboardResponse,
  type AnalyticsWalletSummary,
  type AnalyticsWalletResponse,
  type LiveWindow,
} from "@pools/core";
import {
  assertCatalogIdentity,
  catalogCte,
  type ReadQuery,
} from "./catalog-read";
import { catalogPool, catalogSummary } from "./explore-read";
import { RequestError } from "./request";
import { readTier2, type Tier2Result } from "./tier2-read";

export async function accountingCoverage(
  query: ReadQuery,
): Promise<AnalyticsCoverage> {
  await assertCatalogIdentity(query);
  const pending =
    await query(`SELECT 1 FROM analytics_pool_snapshots s LEFT JOIN analytics_accounting_pools a USING(chain_id,pool_id)
    WHERE s.chain_id=4663 AND (a.pool_id IS NULL OR a.through_block<>s.through_block OR a.through_hash<>s.through_hash OR a.generated_at<>s.generated_at) LIMIT 1`);
  if (pending.rows.length)
    throw new RequestError(503, "analytics_projection_pending");
  const catalog = await catalogSummary(query);
  const r = (
    await query(
      `SELECT count(*)::text AS count,coalesce(max(asof_timestamp),0)::text AS asof,min(asof_timestamp)::text AS oldest,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM analytics_accounting_positions p WHERE p.chain_id=a.chain_id AND p.pool_id=a.pool_id AND p.supported))::text AS realized
        FROM analytics_accounting_pools a WHERE chain_id=4663`,
    )
  ).rows[0];
  return {
    catalogPools: catalog.count,
    processedPools: Number(r.count),
    asOf: Number(r.asof),
    oldestAsOf: r.oldest === null ? null : Number(r.oldest),
    generatedAt: new Date().toISOString(),
    complete: false,
    registryExhaustive: false,
    pnlScope: "supported_pool_positions_only",
    tier2Pools: 0,
    tier3Pools: Number(r.count),
    realizedPools: Number(r.realized),
  };
}
function combinedCoverage(
  coverage: AnalyticsCoverage,
  tier2: Tier2Result,
): AnalyticsCoverage {
  return {
    ...coverage,
    asOf: tier2.asOf,
    pnlScope: "observed_initiator_and_verified_positions",
    tier2Pools: tier2.pools,
    tier3Pools: coverage.processedPools,
    realizedPools: (coverage.realizedPools ?? 0) + tier2.realizedPools,
  };
}
function composeWallet(
  deep: AnalyticsWalletSummary,
  observed?: AnalyticsWalletSummary,
  deepCost = 0n,
  observedCost = 0n,
): AnalyticsWalletSummary {
  const tier3 = deep.supportedPositionCount + deep.excludedPositionCount,
    tier2 = observed?.tier2PositionCount ?? 0;
  if (!observed) return deep;
  const realized =
    deep.realizedWei === null && observed.realizedWei === null
      ? null
      : (
          BigInt(deep.realizedWei ?? "0") + BigInt(observed.realizedWei ?? "0")
        ).toString();
  const cost = deepCost + observedCost,
    wins = deep.wins + observed.wins,
    losses = deep.losses + observed.losses;
  const best =
    [deep.bestWei, observed.bestWei]
      .filter((v): v is string => v !== null)
      .sort((a, b) =>
        BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0,
      )[0] ?? null;
  return {
    ...deep,
    accountingTier: tier3 ? "mixed" : "tier2",
    attribution: tier3 ? "mixed" : "transaction_initiator_only",
    flags: [...new Set([...(deep.flags ?? []), ...(observed.flags ?? [])])],
    tier2PositionCount: tier2,
    tier3PositionCount: tier3,
    realizedPositionCount:
      deep.supportedPositionCount + (observed.realizedPositionCount ?? 0),
    rankingTradeCount:
      deep.supportedTradeCount + (observed.rankingTradeCount ?? 0),
    realizedWei: realized,
    netWei: (
      BigInt(deep.netWei ?? "0") + BigInt(observed.netWei ?? "0")
    ).toString(),
    unrealizedWei: deep.unrealizedWei,
    verifiedUnrealizedWei: deep.unrealizedWei,
    unrealizedScope:
      deep.unrealizedWei === null ? "unavailable" : "verified_positions_only",
    volumeWei: (BigInt(deep.volumeWei) + BigInt(observed.volumeWei)).toString(),
    roi:
      realized !== null && cost > 0n
        ? Number((BigInt(realized) * 1000000n) / cost) / 10000
        : null,
    wins,
    losses,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    tradeCount: deep.tradeCount + observed.tradeCount,
    excludedPositionCount:
      deep.excludedPositionCount + observed.excludedPositionCount,
    bestWei: best,
    last: Math.max(deep.last ?? 0, observed.last ?? 0) || null,
    asOf: Math.max(deep.asOf ?? 0, observed.asOf ?? 0) || null,
    oldestAsOf: Math.min(
      deep.oldestAsOf ?? Infinity,
      observed.oldestAsOf ?? Infinity,
    ),
    completeWindow:
      (!deep.tradeCount || deep.completeWindow) && observed.completeWindow,
  };
}
async function combinedSummaries(
  query: ReadQuery,
  coverage: AnalyticsCoverage,
  tier2: Tier2Result,
  window: LiveWindow,
) {
  const rows = (
    await query(`${accountingCte} SELECT * FROM summaries`, [
      windowFrom(coverage, window),
      coverage.asOf,
    ])
  ).rows;
  const wallets = new Map<string, AnalyticsWalletSummary>();
  for (const r of rows)
    wallets.set(
      r.wallet,
      composeWallet(
        walletSummary(r, r.wallet),
        tier2.summaries.get(r.wallet),
        BigInt(r.disposed_cost ?? "0"),
        tier2.costs.get(r.wallet),
      ),
    );
  for (const [address, s] of tier2.summaries)
    if (!wallets.has(address))
      wallets.set(
        address,
        composeWallet(
          walletSummary(undefined, address),
          s,
          0n,
          tier2.costs.get(address),
        ),
      );
  return wallets;
}
function rankWallets(
  wallets: Map<string, AnalyticsWalletSummary>,
  metric: "realized" | "net",
  minTrades: number,
) {
  const eligible = [...wallets.values()].filter(
    (s) =>
      (s.realizedPositionCount ?? 0) > 0 &&
      (s.rankingTradeCount ?? 0) >= minTrades &&
      (metric === "net" ? s.netWei : s.realizedWei) !== null,
  );
  eligible.sort((a, b) => {
    const x = BigInt((metric === "net" ? a.netWei : a.realizedWei)!),
      y = BigInt((metric === "net" ? b.netWei : b.realizedWei)!);
    return x > y ? -1 : x < y ? 1 : a.address.localeCompare(b.address);
  });
  eligible.forEach((s, i) => (s.rank = i + 1));
  return eligible;
}
async function combinedLeaderboard(
  query: ReadQuery,
  original: AnalyticsCoverage,
  tier2: Tier2Result,
  options: Required<AnalyticsLeaderboardOptions>,
): Promise<AnalyticsLeaderboardResponse> {
  const coverage = combinedCoverage(original, tier2),
    wallets = await combinedSummaries(query, coverage, tier2, options.window),
    ranked = rankWallets(wallets, options.metric, options.minTrades);
  return {
    coverage,
    window: options.window,
    metric: options.metric,
    minTrades: options.minTrades,
    items: ranked.slice(options.offset, options.offset + options.limit),
    total: ranked.length,
    nextOffset:
      options.offset + options.limit < ranked.length
        ? options.offset + options.limit
        : null,
  };
}
export async function readWallet(
  query: ReadQuery,
  address: string,
  window: LiveWindow,
): Promise<AnalyticsWalletResponse> {
  const original = await accountingCoverage(query),
    tier2 = await readTier2(query, original, window, address);
  if (!tier2.pools) return readVerifiedWallet(query, address, window, original);
  const coverage = combinedCoverage(original, tier2),
    deep = await readVerifiedWallet(query, address, window, coverage),
    wallets = await combinedSummaries(query, coverage, tier2, window);
  rankWallets(wallets, "realized", 10);
  const wallet = wallets.get(address) ?? composeWallet(deep.wallet);
  const positions = [
    ...deep.positions.map((p) => ({
      ...p,
      accountingTier: "tier3" as const,
      attribution: "transfer_verified" as const,
    })),
    ...tier2.positions,
  ].sort((a, b) => a.poolId.localeCompare(b.poolId));
  const trades = [...deep.trades, ...tier2.trades].sort(
    (a, b) =>
      b.trade.block - a.trade.block || b.trade.logIndex - a.trade.logIndex,
  );
  const gains = [...tier2.gains];
  // Convert the verified cumulative samples back to increments before merging
  // with the initiator series. Both series disclose their sampling limits.
  let previous = 0n;
  for (const p of deep.curve) {
    const current = BigInt(p.wei);
    gains.push({ time: p.time, wei: (current - previous).toString() });
    previous = current;
  }
  gains.sort((a, b) => a.time - b.time);
  let cumulative = 0n;
  const curve = gains.map((p) => ({
    time: p.time,
    wei: (cumulative += BigInt(p.wei)).toString(),
  }));
  const sampled = curve.length > 498,
    step = Math.max(1, Math.ceil(curve.length / 498));
  const points = curve.filter(
    (_, i) => i % step === 0 || i === curve.length - 1,
  );
  if (wallet.realizedWei !== null) {
    points.unshift({
      time:
        windowFrom(coverage, window) === -1
          ? Math.min(
              tier2.startTimestamp ?? coverage.asOf,
              ...deep.curve.map((p) => p.time),
            )
          : Math.max(0, windowFrom(coverage, window)),
      wei: "0",
    });
    points.push({ time: coverage.asOf, wei: wallet.realizedWei });
  }
  return {
    ...deep,
    coverage,
    wallet,
    positions: positions.slice(0, 500),
    positionsTruncated: deep.positionsTruncated || positions.length > 500,
    trades: trades.slice(0, 500),
    tradesTruncated: deep.tradesTruncated || trades.length > 500,
    curve: points,
    curveSampled: deep.curveSampled || sampled || tier2.curveSampled,
  };
}
export const windowFrom = (coverage: AnalyticsCoverage, window: LiveWindow) =>
  window === "All" ? -1 : coverage.asOf - windows[window];
// $1=window start, $2=global publication cutoff. Basis was persisted per sale
// while folding all earlier trades. Filtering sales never resets inventory.
export const accountingCte = `WITH flows AS (
  SELECT pool_id,wallet,count(*)::integer AS trade_count,sum(eth_wei) AS volume,
    sum(CASE WHEN side='sell' THEN eth_wei ELSE -eth_wei END) FILTER(WHERE execution_supported) AS net,
    coalesce(sum(realized_wei),0) AS realized,coalesce(sum(disposed_cost_wei),0) AS disposed_cost,
    count(*) FILTER(WHERE closed_gain_wei>0)::integer AS wins,count(*) FILTER(WHERE closed_gain_wei<0)::integer AS losses,
    coalesce(sum(closed_hold_seconds),0) AS hold_seconds,count(closed_hold_seconds)::integer AS closures,
    max(realized_wei) AS best,max(timestamp) AS last
  FROM analytics_accounting_trades WHERE chain_id=4663 AND wallet IS NOT NULL AND timestamp >= $1 GROUP BY pool_id,wallet
), positions AS (
  SELECT p.*,a.market,a.from_timestamp,a.asof_timestamp,a.through_block,
    coalesce(f.trade_count,0) AS trade_count,coalesce(f.volume,0) AS volume,coalesce(f.net,0) AS net,
    coalesce(f.realized,0) AS window_realized,coalesce(f.disposed_cost,0) AS disposed_cost,
    coalesce(f.wins,0) AS wins,coalesce(f.losses,0) AS losses,coalesce(f.hold_seconds,0) AS hold_seconds,coalesce(f.closures,0) AS closures,f.best,f.last,
    p.supported AND a.asof_timestamp >= $2 AND
      (CASE WHEN $1=-1 THEN a.from_block <= (a.market->>'launchBlock')::bigint ELSE a.from_timestamp <= $1 OR (a.market->>'launchedAt')::bigint >= $1 END) AS complete_window
  FROM analytics_accounting_positions p JOIN analytics_accounting_pools a USING(chain_id,pool_id)
  LEFT JOIN flows f USING(pool_id,wallet) WHERE p.chain_id=4663
), summaries AS (
  SELECT wallet,count(*) FILTER(WHERE supported)::integer AS supported_count,count(*) FILTER(WHERE NOT supported)::integer AS excluded_count,
    sum(window_realized) FILTER(WHERE supported) AS realized,sum(net) FILTER(WHERE supported) AS net,sum(volume) AS volume,
    CASE WHEN bool_or(supported AND unrealized_wei IS NULL) THEN NULL ELSE sum(unrealized_wei) FILTER(WHERE supported) END AS unrealized,
    sum(disposed_cost) FILTER(WHERE supported) AS disposed_cost,
    coalesce(sum(wins) FILTER(WHERE supported),0) AS wins,coalesce(sum(losses) FILTER(WHERE supported),0) AS losses,
    sum(trade_count) AS trade_count,coalesce(sum(trade_count) FILTER(WHERE supported),0) AS supported_trades,
    sum(hold_seconds) FILTER(WHERE supported) AS hold_seconds,sum(closures) FILTER(WHERE supported) AS closures,
    max(best) FILTER(WHERE supported) AS best,max(last) AS last,max(asof_timestamp) AS asof,min(asof_timestamp) AS oldest,
    bool_and(complete_window) AS complete_window,jsonb_agg(flags) AS position_flags FROM positions GROUP BY wallet
)`;
const int = (v: unknown) => Number(v ?? 0);
const amount = (v: unknown) =>
  v === null || v === undefined ? null : String(v);
export function walletSummary(
  r: Record<string, any> | undefined,
  address: string,
): AnalyticsWalletSummary {
  const realized = amount(r?.realized),
    cost = amount(r?.disposed_cost),
    wins = int(r?.wins),
    losses = int(r?.losses);
  return {
    accountingTier: r ? "tier3" : "unavailable",
    attribution: r ? "transfer_verified" : "unavailable",
    flags: [...new Set<string>((r?.position_flags ?? []).flat())],
    tier2PositionCount: 0,
    tier3PositionCount: int(r?.supported_count) + int(r?.excluded_count),
    realizedPositionCount: int(r?.supported_count),
    rankingTradeCount: int(r?.supported_trades),
    verifiedUnrealizedWei: amount(r?.unrealized),
    unrealizedScope:
      amount(r?.unrealized) === null
        ? "unavailable"
        : "verified_positions_only",
    address,
    rank: r?.rank ? int(r.rank) : null,
    realizedWei: realized,
    netWei: amount(r?.net),
    unrealizedWei: amount(r?.unrealized),
    volumeWei: amount(r?.volume) ?? "0",
    roi:
      realized !== null && cost !== null && BigInt(cost) > 0n
        ? Number((BigInt(realized) * 1000000n) / BigInt(cost)) / 10000
        : null,
    wins,
    losses,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    tradeCount: int(r?.trade_count),
    supportedTradeCount: int(r?.supported_trades),
    supportedPositionCount: int(r?.supported_count),
    excludedPositionCount: int(r?.excluded_count),
    bestWei: amount(r?.best),
    avgHold: int(r?.closures) ? int(r?.hold_seconds) / int(r?.closures) : null,
    last: r?.last == null ? null : int(r.last),
    asOf: r?.asof == null ? null : int(r.asof),
    oldestAsOf: r?.oldest == null ? null : int(r.oldest),
    completeWindow: r?.complete_window ?? false,
  };
}
export async function readLeaderboard(
  query: ReadQuery,
  options: AnalyticsLeaderboardOptions,
): Promise<AnalyticsLeaderboardResponse> {
  const coverage = await accountingCoverage(query),
    window = options.window ?? "7d",
    metric = options.metric ?? "realized",
    minTrades = options.minTrades ?? 10,
    offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  const tier2 = await readTier2(query, coverage, window);
  if (tier2.pools)
    return combinedLeaderboard(query, coverage, tier2, {
      ...options,
      window,
      metric,
      minTrades,
      offset,
      limit,
    });
  const values = [windowFrom(coverage, window), coverage.asOf, minTrades];
  const filtered = `${accountingCte} SELECT *,row_number() OVER(ORDER BY ${metric === "net" ? "net" : "realized"} DESC,wallet) AS rank FROM summaries WHERE supported_count>0 AND supported_trades >= $3`;
  const count = (
    await query(
      `SELECT count(*)::text AS count FROM (${filtered}) ranked`,
      values,
    )
  ).rows[0];
  const rows = (
    await query(
      `SELECT * FROM (${filtered}) ranked ORDER BY rank LIMIT $4 OFFSET $5`,
      [...values, limit, offset],
    )
  ).rows;
  const total = Number(count.count);
  return {
    coverage,
    window,
    metric,
    minTrades,
    items: rows.map((r) => walletSummary(r, r.wallet)),
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
async function readVerifiedWallet(
  query: ReadQuery,
  address: string,
  window: LiveWindow,
  suppliedCoverage?: AnalyticsCoverage,
): Promise<AnalyticsWalletResponse> {
  const coverage = suppliedCoverage ?? (await accountingCoverage(query)),
    from = windowFrom(coverage, window),
    values = [from, coverage.asOf, address];
  const r = (
    await query(
      `${accountingCte}, ranks AS (SELECT wallet,row_number() OVER(ORDER BY realized DESC,wallet) AS rank FROM summaries WHERE supported_count>0 AND supported_trades>=10)
    SELECT s.*,r.rank FROM summaries s LEFT JOIN ranks r USING(wallet) WHERE s.wallet=$3`,
      values,
    )
  ).rows[0];
  const positions = (
    await query(
      `${accountingCte} SELECT * FROM positions WHERE wallet=$3 ORDER BY pool_id LIMIT 501`,
      values,
    )
  ).rows;
  const trades = (
    await query(
      `SELECT t.execution,p.market->>'symbol' AS symbol,t.pool_id FROM analytics_accounting_trades t JOIN analytics_accounting_pools p USING(chain_id,pool_id)
    WHERE t.chain_id=4663 AND t.wallet=$1 AND t.timestamp >= $2 ORDER BY t.block_number DESC,t.log_index DESC,t.pool_id LIMIT 501`,
      [address, from],
    )
  ).rows;
  const curveRows = (
    await query(
      `WITH gains AS (
    SELECT timestamp,transaction_hash,log_index,pool_id,sum(realized_wei) OVER(ORDER BY timestamp,pool_id,block_number,log_index ROWS UNBOUNDED PRECEDING) AS cumulative,
      row_number() OVER(ORDER BY timestamp,pool_id,block_number,log_index) AS n,count(*) OVER() AS total
    FROM analytics_accounting_trades WHERE chain_id=4663 AND wallet=$1 AND timestamp >= $2 AND realized_wei IS NOT NULL
  ) SELECT timestamp,cumulative,total FROM gains WHERE mod(n-1,greatest(1,ceil(total/498.0)::bigint))=0 OR n=total ORDER BY n`,
      [address, from],
    )
  ).rows;
  const curve = curveRows.map((p) => ({
    time: int(p.timestamp),
    wei: String(p.cumulative),
  }));
  const start = (
    await query(
      `SELECT min(a.from_timestamp)::text AS start FROM analytics_accounting_positions p JOIN analytics_accounting_pools a USING(chain_id,pool_id) WHERE p.chain_id=4663 AND p.wallet=$1`,
      [address],
    )
  ).rows[0].start;
  const wallet = walletSummary(r, address);
  if (wallet.supportedPositionCount) {
    curve.unshift({
      time:
        from === -1
          ? Math.min(coverage.asOf, Number(start))
          : Math.max(0, from),
      wei: "0",
    });
    curve.push({ time: coverage.asOf, wei: wallet.realizedWei! });
  }
  const launches = (
    await query(
      `${catalogCte} SELECT * FROM catalog WHERE launch_sender=$1 ORDER BY launch_block DESC,pool_id LIMIT 501`,
      [address],
    )
  ).rows;
  return {
    coverage,
    window,
    wallet,
    positions: positions.slice(0, 500).map((p) => ({
      accountingTier: "tier3",
      attribution: "transfer_verified",
      poolId: p.pool_id,
      token: p.market.token,
      symbol: p.market.symbol,
      decimals: p.market.decimals,
      launchTx: p.market.launchTx,
      asOf: int(p.asof_timestamp),
      throughBlock: int(p.through_block),
      supported: p.supported,
      flags: p.flags,
      realizedWei: p.supported ? String(p.window_realized) : null,
      netWei: p.supported ? String(p.net) : null,
      unrealizedWei: amount(p.unrealized_wei),
      volumeWei: String(p.volume),
      position: p.supported
        ? {
            poolId: p.pool_id,
            trader: address as `0x${string}`,
            quantity: String(p.quantity_raw),
            costWei: String(p.cost_wei),
            realizedWei: String(p.realized_wei),
            investedWei: String(p.invested_wei),
            proceedsWei: String(p.proceeds_wei),
            buys: p.buys,
            sells: p.sells,
            flags: [],
            realizations: [],
          }
        : null,
    })),
    trades: trades
      .slice(0, 500)
      .map((t) => ({ ...t.execution, symbol: t.symbol, poolId: t.pool_id })),
    tradesTruncated: trades.length > 500,
    positionsTruncated: positions.length > 500,
    positionRealizationsIncluded: false,
    curveSampled: Number(curveRows[0]?.total ?? 0) > curveRows.length,
    curve,
    launches: launches.slice(0, 500).map(catalogPool),
    launchesTruncated: launches.length > 500,
  };
}
