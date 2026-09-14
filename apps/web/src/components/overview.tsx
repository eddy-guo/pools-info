"use client";
import Link from "next/link";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Flame,
  Layers,
  Search,
  SlidersHorizontal,
  Star,
  Trophy,
  Zap,
} from "lucide-react";
import {
  shortAddress,
  since,
  sumWei,
  type PoolRow,
  type Trade,
  type WalletRow,
  type Window,
} from "@pools/core";
import {
  Avatar,
  Change,
  EmptyState,
  ModeBadge,
  Money,
  Pagination,
  PeriodTabs,
  Price,
  Sparkline,
  TokenIcon,
  WatchButton,
} from "./ui";
import { useManifest, useQuery, useWatchlist } from "./state";

export function Overview({
  pools,
  recent,
  leaders,
}: {
  pools: PoolRow[];
  recent: Trade[];
  leaders: WalletRow[];
}) {
  const { params, set } = useQuery();
  const { ids } = useWatchlist();
  const manifest = useManifest();
  const window: Window = params.get("window") === "24h" ? "24h" : "7d";
  const tab = params.get("view") ?? "all";
  const search = params.get("q") ?? "";
  const mode = params.get("mode") ?? "all";
  const sort = params.get("sort") ?? "volume";
  const filtered = pools.filter(
    (p) =>
      (tab !== "watchlist" || ids.includes(p.id)) &&
      (mode === "all" || p.mode === mode) &&
      `${p.name} ${p.symbol} ${p.token}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  filtered.sort((a, b) => {
    if (tab === "new" || sort === "newest") return b.createdAt - a.createdAt;
    if (tab === "gainers" || sort === "change")
      return b.stats[window].change - a.stats[window].change;
    const av = BigInt(
        sort === "liquidity" ? a.liquidityWei : a.stats[window].volumeWei,
      ),
      bv = BigInt(
        sort === "liquidity" ? b.liquidityWei : b.stats[window].volumeWei,
      );
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  const pageSize = 10;
  const page = Math.max(
    1,
    Math.min(
      Math.ceil(filtered.length / pageSize) || 1,
      Number(params.get("page")) || 1,
    ),
  );
  const leader = leaders[0];
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ROBINHOOD CHAIN / POOL ANALYTICS</div>
          <h1>
            Explore pools<span className="title-dot">.</span>
          </h1>
          <p>Follow the markets. Understand the traders behind them.</p>
        </div>
        <div className="heading-note">
          <Layers size={15} />
          <span>
            7-day demo dataset
            <br />
            <small>Sep 7 - Sep 14, 2026</small>
          </span>
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat">
          <span>
            Total volume{" "}
            <span className="subtle-badge">{window.toUpperCase()}</span>
          </span>
          <strong>
            <Money wei={sumWei(pools.map((p) => p.stats[window].volumeWei))} />
          </strong>
          <small>Across all tracked pools</small>
        </div>
        <div className="stat">
          <span>Liquidity</span>
          <strong>
            <Money wei={sumWei(pools.map((p) => p.liquidityWei))} />
          </strong>
          <small>Simulated pool reserves</small>
        </div>
        <div className="stat">
          <span>Pools tracked</span>
          <strong>
            {pools.length}
            <span className="stat-side">11 instant · 1 crowd</span>
          </strong>
          <small>Every launch in this snapshot</small>
        </div>
        <div className="stat">
          <span>Active traders</span>
          <strong>
            {leaders.length}
            <span className="stat-side">
              <span className="positive">
                {pools
                  .reduce((n, p) => n + p.stats[window].trades, 0)
                  .toLocaleString("en-US")}
              </span>{" "}
              trades
            </span>
          </strong>
          <small>Across the selected window</small>
        </div>
      </div>
      <div className="workspace-grid">
        <section className="panel market-panel">
          <div className="table-toolbar">
            <div className="table-tabs" aria-label="Pool views">
              {[
                { id: "all", label: "All pools", icon: Layers },
                { id: "gainers", label: "Top gainers", icon: Flame },
                { id: "new", label: "Newest", icon: Zap },
                { id: "watchlist", label: "Watchlist", icon: Star },
              ].map((t) => (
                <button
                  key={t.id}
                  className={tab === t.id ? "active" : ""}
                  onClick={() =>
                    set({ view: t.id === "all" ? null : t.id, page: null })
                  }
                >
                  <t.icon size={14} />
                  {t.label}
                  {t.id === "watchlist" && ids.length > 0 && (
                    <span className="count">{ids.length}</span>
                  )}
                </button>
              ))}
            </div>
            <PeriodTabs
              value={window}
              onChange={(w) => set({ window: w, page: null })}
            />
          </div>
          <div className="filter-row">
            <label className="filter-input">
              <Search size={15} />
              <input
                name="pool-filter"
                value={search}
                aria-label="Filter pools"
                placeholder="Filter by token or address"
                onChange={(e) => set({ q: e.target.value || null, page: null })}
              />
              {search && (
                <button
                  onClick={() => set({ q: null, page: null })}
                  aria-label="Clear pool filter"
                >
                  ×
                </button>
              )}
            </label>
            <label className="filter-select">
              <SlidersHorizontal size={14} />
              <select
                name="launch-mode"
                aria-label="Launch type"
                value={mode}
                onChange={(e) =>
                  set({
                    mode: e.target.value === "all" ? null : e.target.value,
                    page: null,
                  })
                }
              >
                <option value="all">All launches</option>
                <option value="instant">Instant</option>
                <option value="crowd">Crowd</option>
              </select>
            </label>
          </div>
          <div className="table-scroll desktop-pools">
            <table className="data-table pool-table">
              <thead>
                <tr>
                  <th className="star-cell" />
                  <th>Token</th>
                  <th>Price</th>
                  <th>
                    <button
                      onClick={() =>
                        set({ sort: "change", view: "all", page: null })
                      }
                    >
                      {window} change{" "}
                      {sort === "change" && <ArrowDown size={12} />}
                    </button>
                  </th>
                  <th>
                    <button
                      onClick={() =>
                        set({ sort: "volume", view: "all", page: null })
                      }
                    >
                      Volume {sort === "volume" && <ArrowDown size={12} />}
                    </button>
                  </th>
                  <th>
                    <button
                      onClick={() =>
                        set({ sort: "liquidity", view: "all", page: null })
                      }
                    >
                      Liquidity{" "}
                      {sort === "liquidity" && <ArrowDown size={12} />}
                    </button>
                  </th>
                  <th className="trend-cell">Trend</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice((page - 1) * pageSize, page * pageSize)
                  .map((pool) => (
                    <tr key={pool.id}>
                      <td className="star-cell">
                        <WatchButton id={pool.id} />
                      </td>
                      <td>
                        <Link className="token-cell" href={`/pool/${pool.id}/`}>
                          <TokenIcon pool={pool} />
                          <span>
                            <strong>{pool.name}</strong>
                            <span className="token-meta">
                              {pool.symbol}
                              <span>·</span>
                              {since(pool.createdAt, manifest.to)}
                              {pool.mode === "crowd" && (
                                <ModeBadge mode={pool.mode} />
                              )}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td>
                        <Price wei={pool.priceWei} />
                      </td>
                      <td>
                        <Change value={pool.stats[window].change} />
                      </td>
                      <td>
                        <Money wei={pool.stats[window].volumeWei} />
                        <small className="cell-sub">
                          {pool.stats[window].trades} trades
                        </small>
                      </td>
                      <td>
                        <Money wei={pool.liquidityWei} />
                      </td>
                      <td className="trend-cell">
                        <Sparkline
                          points={pool.series.filter(
                            (p) =>
                              p.time >=
                              manifest.to - (window === "24h" ? 86400 : 604800),
                          )}
                          positive={pool.stats[window].change >= 0}
                        />
                      </td>
                      <td>
                        <Link
                          className="row-open"
                          href={`/pool/${pool.id}/`}
                          aria-label={`View ${pool.name}`}
                        >
                          <ChevronRight size={16} />
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-pools">
            {filtered.slice((page - 1) * pageSize, page * pageSize).map((p) => (
              <div className="mobile-pool" key={p.id}>
                <div className="mobile-pool-top">
                  <Link className="token-cell" href={`/pool/${p.id}/`}>
                    <TokenIcon pool={p} />
                    <span>
                      <strong>{p.name}</strong>
                      <small className="cell-sub">
                        {p.symbol} · {p.mode}
                      </small>
                    </span>
                  </Link>
                  <div className="align-right">
                    <Price wei={p.priceWei} />
                    <div>
                      <Change value={p.stats[window].change} />
                    </div>
                  </div>
                  <WatchButton id={p.id} />
                </div>
                <div className="mobile-pool-stats">
                  <span>
                    Volume <Money wei={p.stats[window].volumeWei} />
                  </span>
                  <span>
                    Liquidity <Money wei={p.liquidityWei} />
                  </span>
                </div>
              </div>
            ))}
          </div>
          {!filtered.length && (
            <EmptyState
              title={
                tab === "watchlist" && !ids.length
                  ? "Your watchlist starts here"
                  : "No pools match"
              }
              description={
                tab === "watchlist" && !ids.length
                  ? "Star a pool to keep it here. Your watchlist is saved on this device."
                  : "Try another token, address, or launch type."
              }
              action={
                <button
                  className="button"
                  onClick={() =>
                    set({ q: null, mode: null, view: null, page: null })
                  }
                >
                  Explore all pools <ArrowRight size={14} />
                </button>
              }
            />
          )}
          <Pagination
            total={filtered.length}
            page={page}
            pageSize={pageSize}
            onChange={(p) => set({ page: String(p) })}
          />
        </section>
        <aside className="market-sidebar">
          <section className="panel activity-panel">
            <div className="panel-heading">
              <h2>Market activity</h2>
              <span className="subtle-badge">SNAPSHOT</span>
            </div>
            <div className="activity-list">
              {recent.slice(0, 6).map((t) => {
                const pool = pools.find((p) => p.id === t.poolId)!;
                return (
                  <Link
                    key={t.id}
                    className="activity-item"
                    href={`/pool/${pool.id}/?tx=${t.txHash}#trades`}
                  >
                    <TokenIcon pool={pool} size="small" />
                    <div>
                      <strong>
                        {pool.symbol}{" "}
                        <span
                          className={t.side === "buy" ? "positive" : "negative"}
                        >
                          {t.side === "buy" ? (
                            <ArrowDownLeft size={12} />
                          ) : (
                            <ArrowUpRight size={12} />
                          )}
                          {t.side}
                        </span>
                      </strong>
                      <small className="mono">{shortAddress(t.trader)}</small>
                    </div>
                    <div className="align-right">
                      <Money wei={t.ethWei} />
                      <small>
                        {since(t.timestamp, manifest.to)} pre-cutoff
                      </small>
                    </div>
                  </Link>
                );
              })}
            </div>
            <div className="panel-footnote">
              Activity is simulated, not a live feed.
            </div>
          </section>
          {leader && (
            <section className="leader-card">
              <div className="leader-card-top">
                <span className="eyebrow">LEADING TRADER</span>
                <Trophy size={17} />
              </div>
              <Link
                className="leader-identity"
                href={`/wallet/${leader.address}/`}
              >
                <Avatar address={leader.address} color={leader.color} />
                <span>
                  <strong>{leader.label}</strong>
                  <small className="mono">{shortAddress(leader.address)}</small>
                </span>
                <span className="rank-medal">#1</span>
              </Link>
              <div className="leader-profit">
                <Money wei={leader.realizedWei} signed />
                <small>7D realized PnL · demo</small>
              </div>
              <Link className="leader-link" href="/traders/">
                Explore the leaderboard <ArrowRight size={15} />
              </Link>
            </section>
          )}
          <div className="method-note">
            <span className="note-icon">i</span>
            <div>
              <h3>Know what you’re looking at</h3>
              <p>
                Realized PnL, transparent exclusions, and no hidden zero-cost
                entries.
              </p>
              <Link href="/methodology/">
                Read our methodology <ArrowUpRight size={13} />
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
