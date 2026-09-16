import {
  poolWindow,
  walletMetrics,
  windows,
  type LiveWindow,
} from "./live-analytics";
import {
  createLocalSearchProvider,
  type SearchGroup,
  type SearchResponse,
} from "./search";
import type { ChainSnapshot, ChainTrade, PoolAudit } from "./chain-types";
import type { CatalogPool } from "./catalog";
import type {
  AnalyticsPublication,
  AnalyticsCoverage,
  AnalyticsPoolStats,
  AnalyticsPoolDetail,
  AnalyticsExploreOptions,
  AnalyticsExploreResponse,
  AnalyticsLeaderboardOptions,
  AnalyticsLeaderboardResponse,
  AnalyticsWalletResponse,
  AnalyticsWalletSummary,
} from "./analytics-types";

export interface AnalyticsModel {
  catalog: CatalogPool[];
  publications: Map<string, AnalyticsPublication>;
  coverage: AnalyticsCoverage;
  walletAudits: Map<string, PoolAudit[]>;
  walletResults: Map<LiveWindow, Map<string, AnalyticsWalletResponse>>;
}
const normalize = (s: string) => s.toLowerCase();
const sum = (values: string[]) => values.reduce((n, s) => n + BigInt(s), 0n);
const eventKey = (t: ChainTrade) => `${normalize(t.txHash)}:${t.logIndex}`;
const tradeContent = (t: ChainTrade) =>
  JSON.stringify([
    normalize(t.poolId),
    normalize(t.txHash),
    t.logIndex,
    t.block,
    t.timestamp,
    t.side,
    t.ethWei,
    t.tokenRaw,
  ]);
function cleanPublication(
  publication: AnalyticsPublication,
): AnalyticsPublication {
  const snapshot = publication.snapshot,
    market = snapshot.markets[0];
  if (!market) throw Error("Missing analytics market");
  const trades = new Map<string, ChainTrade>();
  for (const t of snapshot.trades) {
    const key = eventKey(t),
      prior = trades.get(key);
    if (prior && tradeContent(prior) !== tradeContent(t))
      throw Error("Conflicting analytics trade");
    if (!prior)
      trades.set(key, {
        ...t,
        poolId: normalize(t.poolId),
        txHash: normalize(t.txHash),
      });
  }
  let accounting = market.accounting;
  if (accounting) {
    const executions = new Map<string, PoolAudit["executions"][number]>();
    for (const e of accounting.executions ?? []) {
      const key = eventKey(e.trade),
        prior = executions.get(key);
      const normalized = {
        ...e,
        flags: [...new Set(e.flags)].sort(),
        matchedTransfer: e.matchedTransfer?.toLowerCase() ?? null,
        trade: {
          ...e.trade,
          id: key,
          txHash: normalize(e.trade.txHash) as `0x${string}`,
          trader: normalize(e.trade.trader) as `0x${string}`,
          poolId: normalize(e.trade.poolId) as `0x${string}`,
        },
      };
      if (prior && JSON.stringify(prior) !== JSON.stringify(normalized))
        throw Error("Conflicting analytics execution");
      if (!prior) executions.set(key, normalized);
    }
    accounting = { ...accounting, executions: [...executions.values()] };
  }
  return {
    ...publication,
    snapshot: {
      ...snapshot,
      trades: [...trades.values()],
      markets: [{ ...market, accounting }],
    },
  };
}

/** One latest publication per pool. Aggregations cover the entire supplied
 * catalog before filtering/pagination; callers must never silently truncate it. */
export function buildAnalyticsModel(
  catalog: CatalogPool[],
  publications: AnalyticsPublication[],
  generatedAt = new Date().toISOString(),
): AnalyticsModel {
  const entries = new Map(
    catalog.map((p) => [
      normalize(p.id),
      {
        ...p,
        id: normalize(p.id),
        token: normalize(p.token),
        launchSender: normalize(p.launchSender),
      },
    ]),
  );
  const saved = new Map<string, AnalyticsPublication>();
  for (const raw of publications) {
    const publication = cleanPublication(raw);
    const s = publication.snapshot;
    if (
      s.schemaVersion !== 1 ||
      s.chainId !== 4663 ||
      s.markets.length !== 1 ||
      s.fromBlock > s.toBlock ||
      !Number.isSafeInteger(s.toTimestamp)
    )
      throw Error("Invalid analytics publication");
    const market = s.markets[0],
      id = normalize(market.id);
    if (!entries.has(id)) continue; // Publication alone never establishes membership.
    if (normalize(entries.get(id)!.token) !== normalize(market.token))
      throw Error("Analytics token identity mismatch");
    if (
      s.trades.some(
        (t) =>
          normalize(t.poolId) !== id ||
          t.block < s.fromBlock ||
          t.block > s.toBlock ||
          t.timestamp < s.fromTimestamp ||
          t.timestamp > s.toTimestamp,
      )
    )
      throw Error("Trade outside analytics publication");
    const prior = saved.get(id);
    if (
      !prior ||
      s.toBlock > prior.snapshot.toBlock ||
      (s.toBlock === prior.snapshot.toBlock &&
        publication.generatedAt > prior.generatedAt)
    )
      saved.set(id, publication);
  }
  const cutoffs = [...saved.values()].map((p) => p.snapshot.toTimestamp);
  const eventPools = new Map<string, string>();
  for (const publication of saved.values())
    for (const t of publication.snapshot.trades) {
      const prior = eventPools.get(eventKey(t));
      if (prior && prior !== t.poolId)
        throw Error("Conflicting cross-pool analytics event");
      eventPools.set(eventKey(t), t.poolId);
    }
  const walletAudits = new Map<string, PoolAudit[]>();
  for (const publication of saved.values()) {
    const audit = auditFor(publication);
    if (!audit) continue;
    const executions = new Map<string, PoolAudit["executions"]>();
    for (const e of audit.executions) {
      const rows = executions.get(e.trade.trader) ?? [];
      rows.push(e);
      executions.set(e.trade.trader, rows);
    }
    const seen = new Set<string>();
    for (const wallet of audit.wallets) {
      if (seen.has(wallet.address)) throw Error("Duplicate analytics wallet");
      seen.add(wallet.address);
      const entries = walletAudits.get(wallet.address) ?? [];
      entries.push({
        ...audit,
        wallets: [wallet],
        executions: executions.get(wallet.address) ?? [],
      });
      walletAudits.set(wallet.address, entries);
    }
  }
  return {
    catalog: [...entries.values()],
    publications: saved,
    walletAudits,
    walletResults: new Map(),
    coverage: {
      catalogPools: entries.size,
      processedPools: saved.size,
      asOf: Math.max(0, ...cutoffs),
      oldestAsOf: cutoffs.length ? Math.min(...cutoffs) : null,
      generatedAt,
      complete: false,
      registryExhaustive: false,
      pnlScope: "supported_pool_positions_only",
    },
  };
}

function auditFor(publication: AnalyticsPublication): PoolAudit | null {
  const s = publication.snapshot,
    market = s.markets[0],
    accounting = market.accounting;
  if (!accounting) return null;
  return {
    poolId: normalize(market.id),
    toBlock: s.toBlock,
    toTimestamp: s.toTimestamp,
    generatedAt: publication.generatedAt,
    market: { ...market, id: normalize(market.id) },
    wallets: accounting.wallets.map((w) => ({
      ...w,
      address: normalize(w.address),
    })),
    executions: (accounting.executions ?? []).map((e) => ({
      ...e,
      trade: {
        ...e.trade,
        poolId: normalize(e.trade.poolId) as `0x${string}`,
        trader: normalize(e.trade.trader) as `0x${string}`,
      },
    })),
    unattributedSwaps: accounting.unattributedSwaps,
    transfersChecked: accounting.transfersChecked,
  };
}
function stats(
  publication: AnalyticsPublication,
  window: LiveWindow,
  asOf: number,
): AnalyticsPoolStats {
  const snapshot = publication.snapshot,
    market = snapshot.markets[0];
  const selected = poolWindow(
    market,
    { ...snapshot, toTimestamp: asOf },
    window,
  );
  return {
    priceWei: market.priceWei,
    volumeWei: selected.volumeWei,
    change: selected.change,
    trades: selected.trades.length,
    liquidityWei: publication.liquidityWei,
    holders: publication.holders?.complete
      ? publication.holders.positiveHoldersExcludingInfrastructure
      : null,
    completeWindow:
      snapshot.toTimestamp >= asOf &&
      (window === "All"
        ? snapshot.fromBlock <= market.launchBlock
        : snapshot.fromTimestamp <= asOf - windows[window] ||
          market.launchedAt >= asOf - windows[window]),
  };
}
export function poolAnalytics(
  model: AnalyticsModel,
  poolId: string,
  window: LiveWindow = "24h",
): AnalyticsPoolDetail | null {
  const saved = model.publications.get(normalize(poolId));
  return saved
    ? {
        ...saved,
        audit: auditFor(saved),
        stats: stats(saved, window, model.coverage.asOf),
        coverage: model.coverage,
      }
    : null;
}
export function exploreAnalytics(
  model: AnalyticsModel,
  options: AnalyticsExploreOptions = {},
): AnalyticsExploreResponse {
  const window = options.window ?? "24h",
    direction = options.direction ?? "desc",
    view = options.view ?? "all";
  const ids = new Set((options.ids ?? []).map(normalize)),
    q = (options.q ?? "").trim().toLowerCase();
  let rows = model.catalog
    .map((p) => {
      const saved = model.publications.get(p.id);
      return {
        ...p,
        marketCoverage: saved
          ? {
              source: "deep_publication" as const,
              startBlock: saved.snapshot.fromBlock,
              cutoff: {
                block: saved.snapshot.toBlock,
                hash: saved.snapshot.blockHash,
                asOf: saved.snapshot.toTimestamp,
              },
              windowStart:
                window === "All"
                  ? p.launchedAt
                  : model.coverage.asOf - windows[window],
              indexedAt: saved.generatedAt,
              unitsConflict: false,
              unitBasis: {
                block: saved.snapshot.toBlock,
                hash: saved.snapshot.blockHash,
                asOf: saved.snapshot.toTimestamp,
                decimals: saved.snapshot.markets[0].decimals,
                source: "verified_deep_snapshot" as const,
              },
              rawPrice: null,
              priceBaseline: null,
            }
          : null,
        processed: !!saved,
        market: saved
          ? {
              ...saved.snapshot.markets[0],
              accounting: undefined,
              series: saved.snapshot.markets[0].series.filter(
                (_, i, points) =>
                  i % Math.max(1, Math.ceil(points.length / 160)) === 0 ||
                  i === points.length - 1,
              ),
            }
          : null,
        stats: saved
          ? stats(saved, window, model.coverage.asOf)
          : {
              priceWei: null,
              volumeWei: null,
              liquidityWei: null,
              change: null,
              trades: null,
              holders: null,
              completeWindow: false,
            },
        asOf: saved?.snapshot.toTimestamp ?? null,
        throughBlock: saved?.snapshot.toBlock ?? null,
        generatedAt: saved?.generatedAt ?? null,
        sourceKind: saved?.sourceKind ?? null,
      };
    })
    .filter(
      (p) =>
        (!q ||
          [p.name, p.symbol, p.token, p.id, p.launchSender].some((s) =>
            s.toLowerCase().includes(q),
          )) &&
        (view !== "watchlist" || ids.has(p.id)) &&
        (view !== "gainers" ||
          (p.stats.change !== null && p.stats.change > 0)) &&
        view !== "crowd",
    );
  const sort = view === "new" ? "launch" : (options.sort ?? "launch");
  if (sort !== "launch") {
    const metric = {
      volume: "volumeWei",
      trades: "trades",
      liquidity: "liquidityWei",
      change: "change",
    }[sort] as "volumeWei" | "trades" | "liquidityWei" | "change";
    rows = rows.filter((pool) => pool.stats[metric] !== null);
  }
  rows = rows.sort((a, b) => {
    const x =
      sort === "launch"
        ? a.launchBlock
        : sort === "change"
          ? a.stats.change
          : sort === "trades"
            ? a.stats.trades
            : sort === "volume"
              ? a.stats.volumeWei
              : a.stats.liquidityWei;
    const y =
      sort === "launch"
        ? b.launchBlock
        : sort === "change"
          ? b.stats.change
          : sort === "trades"
            ? b.stats.trades
            : sort === "volume"
              ? b.stats.volumeWei
              : b.stats.liquidityWei;
    if (x === null) return y === null ? a.id.localeCompare(b.id) : 1;
    if (y === null) return -1;
    const bx = typeof x === "string" ? BigInt(x) : x,
      by = typeof y === "string" ? BigInt(y) : y;
    return (
      (bx > by ? 1 : bx < by ? -1 : 0) * (direction === "asc" ? 1 : -1) ||
      a.id.localeCompare(b.id)
    );
  });
  const offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  return {
    coverage: model.coverage,
    window,
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    ...(view === "crowd"
      ? {
          message:
            "Crowd launches are not included in the verified deployment registry yet.",
        }
      : {}),
  };
}

function walletResult(
  model: AnalyticsModel,
  address: string,
  window: LiveWindow,
): AnalyticsWalletResponse {
  address = normalize(address);
  const memo =
    model.walletResults.get(window) ??
    new Map<string, AnalyticsWalletResponse>();
  model.walletResults.set(window, memo);
  const existing = memo.get(address);
  if (existing) return existing;
  const asOf = model.coverage.asOf,
    from = asOf - windows[window];
  const positions: AnalyticsWalletResponse["positions"] = [],
    trades: AnalyticsWalletResponse["trades"] = [];
  const realized: string[] = [],
    nets: string[] = [],
    unrealized: string[] = [],
    volumes: string[] = [],
    gains: { time: number; wei: string }[] = [];
  let disposedCost = 0n,
    wins = 0,
    losses = 0,
    supportedTrades = 0,
    supportedCount = 0,
    excludedCount = 0,
    missingMark = false,
    holdSeconds = 0,
    closures = 0,
    best: bigint | null = null,
    last: number | null = null;
  for (const audit of model.walletAudits.get(address) ?? []) {
    const m = walletMetrics({ ...audit, toTimestamp: asOf }, address, window)!;
    const supported =
      m.complete &&
      m.row.balanceMatches &&
      m.position?.realizedWei === m.row.realizedWei;
    const flags = [
      ...m.row.flags,
      ...(!m.row.balanceMatches ? ["balance_mismatch"] : []),
      ...(m.position && m.position.realizedWei !== m.row.realizedWei
        ? ["accounting_mismatch"]
        : []),
    ];
    if (!supported && !flags.length) flags.push("unsupported_accounting");
    positions.push({
      poolId: audit.poolId,
      token: audit.market.token,
      symbol: audit.market.symbol,
      decimals: audit.market.decimals,
      launchTx: audit.market.launchTx,
      asOf: audit.toTimestamp,
      throughBlock: audit.toBlock,
      supported,
      flags: [...new Set(flags)],
      realizedWei: supported ? m.realizedWei : null,
      unrealizedWei: supported ? m.unrealizedWei : null,
      netWei: supported ? m.netWei : null,
      volumeWei: m.volumeWei,
      position: supported ? m.position : null,
    });
    trades.push(
      ...m.trades.map((e) => ({
        ...e,
        symbol: audit.market.symbol,
        poolId: audit.poolId,
      })),
    );
    volumes.push(m.volumeWei);
    if (m.last !== null) last = Math.max(last ?? m.last, m.last);
    if (!supported) {
      excludedCount++;
      continue;
    }
    supportedCount++;
    supportedTrades += m.trades.length;
    realized.push(m.realizedWei!);
    nets.push(m.netWei!);
    if (m.unrealizedWei === null) missingMark = true;
    else unrealized.push(m.unrealizedWei);
    wins += m.wins;
    losses += m.losses;
    const proceeds = m.trades
      .filter((e) => e.trade.side === "sell" && !e.flags.length)
      .reduce((n, e) => n + BigInt(e.trade.ethWei), 0n);
    disposedCost += proceeds - BigInt(m.realizedWei!);
    for (const r of m.position!.realizations)
      if (r.timestamp >= from) {
        gains.push({ time: r.timestamp, wei: r.wei });
        const value = BigInt(r.wei);
        if (best === null || value > best) best = value;
      }
    let quantity = 0n,
      opened = 0;
    for (const e of audit.executions
      .filter((e) => e.trade.trader === address && !e.flags.length)
      .sort(
        (a, b) =>
          a.trade.block - b.trade.block || a.trade.logIndex - b.trade.logIndex,
      )) {
      const t = e.trade;
      if (t.side === "buy") {
        if (quantity === 0n) opened = t.timestamp;
        quantity += BigInt(t.tokenRaw);
      } else {
        quantity -= BigInt(t.tokenRaw);
        if (quantity === 0n && t.timestamp >= from) {
          holdSeconds += t.timestamp - opened;
          closures++;
        }
      }
    }
  }
  const realizedTotal = supportedCount ? sum(realized) : null;
  const summary: AnalyticsWalletSummary = {
    address,
    rank: null,
    realizedWei: realizedTotal?.toString() ?? null,
    unrealizedWei:
      supportedCount && !missingMark ? sum(unrealized).toString() : null,
    netWei: supportedCount ? sum(nets).toString() : null,
    volumeWei: sum(volumes).toString(),
    roi:
      realizedTotal !== null && disposedCost > 0n
        ? Number((realizedTotal * 1000000n) / disposedCost) / 10000
        : null,
    wins,
    losses,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    tradeCount: trades.length,
    supportedTradeCount: supportedTrades,
    supportedPositionCount: supportedCount,
    excludedPositionCount: excludedCount,
    bestWei: best?.toString() ?? null,
    avgHold: closures ? holdSeconds / closures : null,
    last,
    asOf: positions.length ? Math.max(...positions.map((p) => p.asOf)) : null,
    oldestAsOf: positions.length
      ? Math.min(...positions.map((p) => p.asOf))
      : null,
    completeWindow:
      positions.length > 0 &&
      positions.every(
        (p) =>
          p.supported &&
          stats(model.publications.get(p.poolId)!, window, asOf).completeWindow,
      ),
  };
  let cumulative = 0n;
  const curve = gains
    .sort((a, b) => a.time - b.time)
    .map((r) => ({
      time: r.time,
      wei: (cumulative += BigInt(r.wei)).toString(),
    }));
  if (supportedCount) {
    curve.unshift({
      time: Number.isFinite(from)
        ? Math.max(0, from)
        : Math.min(
            asOf,
            ...positions.map(
              (p) => model.publications.get(p.poolId)!.snapshot.fromTimestamp,
            ),
          ),
      wei: "0",
    });
    curve.push({ time: asOf, wei: cumulative.toString() });
  }
  trades.sort(
    (a, b) =>
      b.trade.block - a.trade.block ||
      b.trade.logIndex - a.trade.logIndex ||
      a.poolId.localeCompare(b.poolId),
  );
  const result: AnalyticsWalletResponse = {
    coverage: model.coverage,
    wallet: summary,
    positions,
    trades: trades.slice(0, 500),
    tradesTruncated: trades.length > 500,
    curve,
    launches: model.catalog.filter((p) => p.launchSender === address),
    window,
  };
  // Unknown address lookups do not create an unbounded visitor cache.
  if (model.walletAudits.has(address)) memo.set(address, result);
  return result;
}
function ranked(
  model: AnalyticsModel,
  window: LiveWindow,
  minTrades: number,
  metric: "realized" | "net",
) {
  const addresses = model.walletAudits.keys();
  return [...addresses]
    .map((a) => walletResult(model, a, window).wallet)
    .filter(
      (w) => w.supportedPositionCount > 0 && w.supportedTradeCount >= minTrades,
    )
    .sort((a, b) => {
      const x = BigInt((metric === "realized" ? a.realizedWei : a.netWei)!),
        y = BigInt((metric === "realized" ? b.realizedWei : b.netWei)!);
      return x > y ? -1 : x < y ? 1 : a.address.localeCompare(b.address);
    })
    .map((w, i) => ({ ...w, rank: i + 1 }));
}
export function leaderboardAnalytics(
  model: AnalyticsModel,
  options: AnalyticsLeaderboardOptions = {},
): AnalyticsLeaderboardResponse {
  const window = options.window ?? "All",
    minTrades = options.minTrades ?? 10,
    metric = options.metric ?? "realized",
    offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  const rows = ranked(model, window, minTrades, metric);
  return {
    coverage: model.coverage,
    window,
    minTrades,
    metric,
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  };
}
export function walletAnalytics(
  model: AnalyticsModel,
  address: string,
  window: LiveWindow = "All",
): AnalyticsWalletResponse {
  const result = walletResult(model, address, window);
  const rank =
    ranked(model, window, 10, "realized").find(
      (w) => w.address === normalize(address),
    )?.rank ?? null;
  return { ...result, wallet: { ...result.wallet, rank } };
}
export async function searchAnalytics(
  model: AnalyticsModel,
  q: string,
  group?: SearchGroup,
): Promise<SearchResponse> {
  const all = [...model.publications.values()],
    first = all[0]?.snapshot;
  const snapshot: ChainSnapshot = {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: model.coverage.generatedAt,
    fromBlock: Math.min(
      first?.fromBlock ?? 0,
      ...all.map((p) => p.snapshot.fromBlock),
    ),
    toBlock: Math.max(0, ...all.map((p) => p.snapshot.toBlock)),
    fromTimestamp: 0,
    toTimestamp: model.coverage.asOf,
    blockHash: first?.blockHash ?? `0x${"0".repeat(64)}`,
    discoveredLaunches: model.catalog.length,
    markets: all.map((p) => p.snapshot.markets[0]),
    trades: all.flatMap((p) => p.snapshot.trades),
    requests: 0,
    durationMs: 0,
    reconciliation: null,
  };
  const audits = Object.fromEntries(
    all
      .map((p) => auditFor(p))
      .filter((a): a is PoolAudit => a !== null)
      .map((a) => [a.poolId, a]),
  );
  const result = await createLocalSearchProvider(snapshot, audits, {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: model.coverage.generatedAt,
    toBlock: snapshot.toBlock,
    blockHash: snapshot.blockHash,
    ranges: [],
    pools: model.catalog,
  }).search(q, { group, signal: new AbortController().signal });
  return {
    ...result,
    entries: result.entries.map((entry) =>
      entry.group === "Wallets" && /^0x[0-9a-f]{40}$/i.test(entry.address)
        ? {
            ...entry,
            href: `/wallet/${entry.address.toLowerCase()}/?window=All`,
          }
        : entry,
    ),
    coverage: {
      ...result.coverage,
      scope: all.some((p) => p.sourceKind !== "preloaded")
        ? "indexed"
        : "sample",
    },
    message:
      "Search covers stored Pools launches and published activity; unknown addresses remain public lookups.",
  };
}
