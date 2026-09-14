import { foldTrades, realizedInWindow } from "./accounting";
import { shortAddress, sumWei } from "./format";
import type {
  AnalyticsReader,
  Creator,
  Identity,
  Manifest,
  Page,
  PoolDetail,
  PoolQuery,
  PoolRow,
  Position,
  SearchResult,
  Snapshot,
  Trade,
  WalletDetail,
  WalletRow,
  Window,
} from "./types";
const compare = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? 1 : BigInt(a) > BigInt(b) ? -1 : 0;
const paginate = <T>(items: T[], page = 1, pageSize = 20): Page<T> => {
  const size = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const current = Math.max(1, Math.floor(page));
  return {
    items: items.slice((current - 1) * size, current * size),
    total: items.length,
    page: current,
    pageSize: size,
  };
};

export class SnapshotReader implements AnalyticsReader {
  private readonly rows: PoolRow[];
  private readonly positions: Position[];
  private readonly trades: Trade[];
  constructor(private readonly snapshot: Snapshot) {
    if (snapshot.manifest.schemaVersion !== 1)
      throw new Error("Unsupported snapshot version");
    const keys = new Set<string>();
    this.trades = [...snapshot.trades].sort(
      (a, b) => a.block - b.block || a.logIndex - b.logIndex,
    );
    for (const t of this.trades) {
      const key = `${t.txHash}:${t.logIndex}`;
      if (keys.has(key))
        throw new Error("Duplicate event in published snapshot");
      if (!snapshot.pools.some((p) => p.id === t.poolId))
        throw new Error("Unknown pool in snapshot");
      if (!snapshot.identities.some((w) => w.address === t.trader))
        throw new Error("Unknown wallet in snapshot");
      keys.add(key);
    }
    const grouped = new Map<string, Trade[]>();
    for (const t of this.trades) {
      const key = `${t.trader}:${t.poolId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), t]);
    }
    this.positions = [...grouped.values()].map(foldTrades);
    this.rows = snapshot.pools.map((pool) => {
      const trades = this.trades.filter((t) => t.poolId === pool.id);
      const series = trades.map((t) => ({
        time: t.timestamp,
        wei: (
          (BigInt(t.ethWei) * 10n ** BigInt(pool.decimals)) /
          BigInt(t.tokenRaw)
        ).toString(),
      }));
      const priceWei = series.at(-1)?.wei ?? "0";
      const stats = (window: Window) => {
        const from = this.windowStart(window);
        const slice = trades.filter((t) => t.timestamp >= from);
        const start =
          [...series].reverse().find((p) => p.time <= from) ?? series[0];
        return {
          volumeWei: sumWei(slice.map((t) => t.ethWei)),
          trades: slice.length,
          traders: new Set(slice.map((t) => t.trader)).size,
          change:
            start && BigInt(start.wei) > 0n
              ? Number(
                  ((BigInt(priceWei) - BigInt(start.wei)) * 10000n) /
                    BigInt(start.wei),
                ) / 100
              : 0,
        };
      };
      return {
        ...pool,
        priceWei,
        fdvWei: (
          (BigInt(priceWei) * BigInt(pool.supply)) /
          10n ** BigInt(pool.decimals)
        ).toString(),
        stats: { "24h": stats("24h"), "7d": stats("7d") },
        series,
      };
    });
  }
  private windowStart(window: Window) {
    return this.snapshot.manifest.to - (window === "24h" ? 86400 : 7 * 86400);
  }
  private identity(address: string): Identity {
    return (
      this.snapshot.identities.find((i) => i.address === address) ?? {
        address: address as Identity["address"],
        label: shortAddress(address),
        color: "#b5a9dd",
      }
    );
  }
  private walletRow(
    identity: Identity,
    window: Window,
    poolId?: string,
  ): WalletRow {
    const from = this.windowStart(window);
    const positions = this.positions.filter(
      (p) => p.trader === identity.address && (!poolId || p.poolId === poolId),
    );
    const rankable = positions.filter(
      (p) => this.rows.find((row) => row.id === p.poolId)?.mode === "instant",
    );
    const trades = this.trades.filter(
      (t) =>
        t.trader === identity.address &&
        t.timestamp >= from &&
        (!poolId || t.poolId === poolId),
    );
    const eligibleTrades = trades.filter(
      (t) => this.rows.find((p) => p.id === t.poolId)?.mode === "instant",
    );
    const flags = [...new Set(rankable.flatMap((p) => p.flags))];
    const realized = rankable.reduce(
      (n, p) => n + (realizedInWindow(p, from) ?? 0n),
      0n,
    );
    const closed = rankable.filter(
      (p) =>
        p.quantity === "0" &&
        p.sells > 0 &&
        p.realizedWei !== null &&
        p.realizations.some((r) => r.timestamp >= from),
    );
    const wins = closed.filter((p) => BigInt(p.realizedWei!) > 0n).length;
    const losses = closed.filter((p) => BigInt(p.realizedWei!) < 0n).length;
    const invested = rankable.reduce((n, p) => n + BigInt(p.investedWei), 0n);
    return {
      ...identity,
      realizedWei: realized.toString(),
      volumeWei: sumWei(trades.map((t) => t.ethWei)),
      trades: eligibleTrades.length,
      winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
      wins,
      losses,
      eligible: eligibleTrades.length >= 10 && flags.length === 0,
      lastActive: trades.at(-1)?.timestamp ?? 0,
      poolCount: new Set(trades.map((t) => t.poolId)).size,
      flags,
      roi:
        window === "7d" && invested > 0n && flags.length === 0
          ? Number((realized * 10000n) / invested) / 100
          : null,
    };
  }
  async manifest(): Promise<Manifest> {
    return this.snapshot.manifest;
  }
  async pools(query: PoolQuery = {}): Promise<Page<PoolRow>> {
    const q = query.search?.toLowerCase() ?? "";
    const rows = this.rows.filter(
      (p) =>
        (!query.mode || p.mode === query.mode) &&
        `${p.name} ${p.symbol} ${p.token}`.toLowerCase().includes(q),
    );
    rows.sort((a, b) =>
      query.sort === "newest"
        ? b.createdAt - a.createdAt
        : query.sort === "liquidity"
          ? compare(a.liquidityWei, b.liquidityWei)
          : compare(
              a.stats[query.window ?? "7d"].volumeWei,
              b.stats[query.window ?? "7d"].volumeWei,
            ),
    );
    return paginate(rows, query.page, query.pageSize);
  }
  async pool(id: string): Promise<PoolDetail | null> {
    const pool = this.rows.find((p) => p.id.toLowerCase() === id.toLowerCase());
    if (!pool) return null;
    return {
      pool,
      trades: this.trades.filter((t) => t.poolId === pool.id).reverse(),
      traders: this.snapshot.identities
        .map((w) => this.walletRow(w, "7d", pool.id))
        .filter((w) => w.trades > 0)
        .sort((a, b) => compare(a.realizedWei, b.realizedWei)),
    };
  }
  async leaderboard(
    window: Window,
    page = 1,
    pageSize = 20,
  ): Promise<Page<WalletRow>> {
    return paginate(
      this.snapshot.identities
        .map((w) => this.walletRow(w, window))
        .filter((w) => w.eligible)
        .sort((a, b) => compare(a.realizedWei, b.realizedWei)),
      page,
      pageSize,
    );
  }
  async wallets() {
    return this.snapshot.identities;
  }
  async wallet(address: string): Promise<WalletDetail | null> {
    const identity = this.snapshot.identities.find(
      (w) => w.address.toLowerCase() === address.toLowerCase(),
    );
    if (!identity) return null;
    const positions = this.positions
      .filter((p) => p.trader === identity.address)
      .map((p) => {
        const pool = this.rows.find((row) => row.id === p.poolId)!;
        const value =
          (BigInt(p.quantity) * BigInt(pool.priceWei)) /
          10n ** BigInt(pool.decimals);
        return {
          ...p,
          pool,
          valueWei: value.toString(),
          unrealizedWei:
            p.realizedWei === null
              ? null
              : (value - BigInt(p.costWei)).toString(),
        };
      });
    let cumulative = 0n;
    const pnlSeries = [
      { time: this.snapshot.manifest.from, wei: "0" },
      ...positions
        .filter((p) => p.pool.mode === "instant")
        .flatMap((p) => p.realizations)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((r) => {
          cumulative += BigInt(r.wei);
          return { time: r.timestamp, wei: cumulative.toString() };
        }),
    ];
    return {
      wallet: identity,
      summary: {
        "24h": this.walletRow(identity, "24h"),
        "7d": this.walletRow(identity, "7d"),
      },
      positions,
      trades: this.trades
        .filter((t) => t.trader === identity.address)
        .reverse(),
      pnlSeries,
    };
  }
  async creators(): Promise<Creator[]> {
    return [...new Set(this.rows.map((p) => p.creator))]
      .map((address) => {
        const pools = this.rows.filter((p) => p.creator === address);
        return {
          identity: this.identity(address),
          pools,
          volumeWei: sumWei(pools.map((p) => p.stats["7d"].volumeWei)),
          liquidityWei: sumWei(pools.map((p) => p.liquidityWei)),
        };
      })
      .sort((a, b) => compare(a.volumeWei, b.volumeWei));
  }
  async searchIndex(): Promise<SearchResult[]> {
    return [
      ...this.rows.map((p) => ({
        type: "Token" as const,
        title: `${p.name} (${p.symbol})`,
        subtitle: p.token,
        href: `/pool/${p.id}/`,
        color: p.color,
      })),
      ...this.snapshot.identities.map((w) => ({
        type: "Wallet" as const,
        title: w.label,
        subtitle: w.address,
        href: `/wallet/${w.address}/`,
        color: w.color,
      })),
      ...this.trades.map((t) => ({
        type: "Transaction" as const,
        title: `${t.side === "buy" ? "Buy" : "Sell"} ${this.rows.find((p) => p.id === t.poolId)!.symbol}`,
        subtitle: t.txHash,
        href: `/pool/${t.poolId}/?tx=${t.txHash}#trades`,
        color: "#aaa3bd",
      })),
    ];
  }
  async search(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (await this.searchIndex())
      .filter((r) => `${r.title} ${r.subtitle}`.toLowerCase().includes(q))
      .slice(0, 20);
  }
  async recentTrades(limit = 10) {
    return [...this.trades].reverse().slice(0, Math.min(100, limit));
  }
}
