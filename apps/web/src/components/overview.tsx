"use client";
import Link from "next/link";
import { ProductExplore } from "./product-explore";
import { useSyncExternalStore } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Search,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import {
  poolHref,
  poolWindow,
  shortAddress,
  since,
  walletMetrics,
  walletHref,
  type ChainMarket,
} from "@pools/core";
import { TradeStream } from "./trade-stream";
import { FeaturePreview } from "./feature-preview";
import { useLive } from "./live-provider";
import { useQuery, useWatchlist } from "./state";
import { Avatar, Change, Price, Sparkline, WatchButton } from "./ui";
import { Eth, Stat, Unavailable, WindowTabs, useWindow } from "./live-ui";

const subscribeClock = (notify: () => void) => {
  const timer = window.setInterval(notify, 30000);
  return () => window.clearInterval(timer);
};
const clockSeconds = () => Math.floor(Date.now() / 1000);
const serverClock = () => null;
type Sort = "name" | "price" | "change" | "volume" | "age";
export function PreloadedOverview() {
  const { snapshot: s, audits } = useLive();
  const now = useSyncExternalStore<number | null>(
    subscribeClock,
    clockSeconds,
    serverClock,
  );
  const age = (market: ChainMarket) => (
    <time
      dateTime={new Date(market.launchedAt * 1000).toISOString()}
      data-launched-at={market.launchedAt}
      title={`Launched ${new Date(market.launchedAt * 1000).toISOString()}`}
    >
      {now === null || now < market.launchedAt
        ? new Date(market.launchedAt * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })
        : since(market.launchedAt, now)}
    </time>
  );
  const { params, set } = useQuery();
  const { ids } = useWatchlist();
  const { window, setWindow } = useWindow("24h");
  const tab = params.get("view") ?? "all",
    query = params.get("q") ?? "";
  const sort = (params.get("sort") ??
    (tab === "gainers" ? "change" : tab === "new" ? "age" : "volume")) as Sort;
  const ascending = params.get("dir") === "asc";
  const stats = new Map(s.markets.map((m) => [m.id, poolWindow(m, s, window)]));
  const pools = s.markets
    .filter(
      (m) =>
        (tab !== "watchlist" || ids.includes(m.id)) &&
        tab !== "crowd" &&
        `${m.name} ${m.symbol} ${m.token} ${m.id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()) &&
        (tab !== "gainers" || (stats.get(m.id)!.change ?? 0) > 0),
    )
    .sort((a, b) => {
      let comparison = 0;
      if (sort === "name") comparison = b.name.localeCompare(a.name);
      else if (sort === "age") comparison = b.launchedAt - a.launchedAt;
      else if (sort === "change")
        comparison =
          (stats.get(b.id)!.change ?? -Infinity) -
          (stats.get(a.id)!.change ?? -Infinity);
      else {
        const av = BigInt(
          sort === "price" ? (a.priceWei ?? "0") : stats.get(a.id)!.volumeWei,
        );
        const bv = BigInt(
          sort === "price" ? (b.priceWei ?? "0") : stats.get(b.id)!.volumeWei,
        );
        comparison = bv > av ? 1 : bv < av ? -1 : 0;
      }
      return (ascending ? -comparison : comparison) || a.id.localeCompare(b.id);
    });
  const volume = s.markets
    .reduce((n, m) => n + BigInt(stats.get(m.id)!.volumeWei), 0n)
    .toString();
  const launches = [...s.markets]
    .sort((a, b) => b.launchedAt - a.launchedAt)
    .slice(0, 6);
  const audit = Object.values(audits).find((a) =>
    a.wallets.some((w) => w.realizedWei !== null),
  );
  const leaders = audit
    ? audit.wallets
        .map((w) => walletMetrics(audit, w.address, "All")!)
        .filter((w) => w.complete && w.trades.length >= 10)
        .sort((a, b) =>
          BigInt(a.realizedWei!) > BigInt(b.realizedWei!)
            ? -1
            : BigInt(a.realizedWei!) < BigInt(b.realizedWei!)
              ? 1
              : a.row.address.localeCompare(b.row.address),
        )
        .slice(0, 5)
    : [];
  function heading(label: string, key: Sort) {
    return (
      <th
        aria-sort={
          sort === key ? (ascending ? "ascending" : "descending") : "none"
        }
      >
        <button
          className={sort === key ? "sort-active" : ""}
          onClick={() =>
            set({ sort: key, dir: sort === key && !ascending ? "asc" : "desc" })
          }
        >
          {label}
          {sort === key &&
            (ascending ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </button>
      </th>
    );
  }
  function change(m: ChainMarket) {
    const value = stats.get(m.id)!;
    return value.change === null ? (
      <Unavailable reason="No opening price observation" />
    ) : (
      <span
        title={
          value.sinceLaunch
            ? "Change since the first observed swap"
            : `${window} observed price change`
        }
      >
        <Change value={value.change} />
      </span>
    );
  }
  function row(m: ChainMarket) {
    const stat = stats.get(m.id)!;
    return (
      <tr key={m.id}>
        <td>
          <WatchButton id={m.id} />
        </td>
        <td>
          <Link className="token-cell" href={poolHref(m)}>
            <span className="chain-token">{m.symbol.slice(0, 2)}</span>
            <span>
              <strong>{m.name}</strong>
              <small className="cell-sub">
                <span className="mono">{m.symbol}</span> · {age(m)} ·{" "}
                {stat.trades.length} swaps
              </small>
            </span>
          </Link>
        </td>
        <td>
          {m.priceWei ? (
            <Price wei={m.priceWei} />
          ) : (
            <Unavailable reason="No observed swap price" />
          )}
        </td>
        <td>{change(m)}</td>
        <td>
          <Eth wei={stat.volumeWei} />
        </td>
        <td>
          <Unavailable reason="Reserve-based liquidity is not collected yet" />
        </td>
        <td>
          <Unavailable reason="Full token holder balances are not collected yet" />
        </td>
        <td>
          <Link
            className="mono creator-link"
            href={`/creators/${m.launchSender.toLowerCase()}/`}
            title="Launch transaction sender"
          >
            {shortAddress(m.launchSender)}
          </Link>
        </td>
        <td>
          <Sparkline points={m.series} positive={(stat.change ?? 0) >= 0} />
        </td>
        <td>
          <Link
            className="row-open"
            href={poolHref(m)}
            aria-label={`Open ${m.name}`}
          >
            <ArrowUpRight size={14} />
          </Link>
        </td>
      </tr>
    );
  }
  return (
    <div className="page explore-page">
      <div className="page-heading">
        <div>
          <h1>
            Pools<span className="title-dot">.</span>
          </h1>
          <p>Who&apos;s on the other side of the trade?</p>
        </div>
        <Link className="button" href="/traders/">
          Trader leaderboard <ArrowUpRight size={14} />
        </Link>
      </div>
      <div className="stats-grid">
        <Stat
          label={`Volume · ${window}`}
          note="Observed swaps across covered pools"
        >
          <Eth wei={volume} />
        </Stat>
        <Stat label="Liquidity locked" note="Reserve collection pending">
          <Unavailable />
        </Stat>
        <Stat
          label="Launches covered"
          note={`${s.discoveredLaunches} discovered · ${s.markets.length} with market data`}
        >
          {s.markets.length}
        </Stat>
        <Stat label="Active traders" note="Cross-pool attribution pending">
          <Unavailable />
        </Stat>
      </div>
      <section className="launch-section" aria-label="Just launched">
        <div className="section-caption">
          <span>
            <i />
            Just launched
          </span>
          <button onClick={() => set({ view: "new", sort: null, dir: null })}>
            All covered launches →
          </button>
        </div>
        <div className="launch-rail">
          {launches.map((m) => (
            <Link key={m.id} href={poolHref(m)} className="launch-card">
              <div className="launch-card-identity">
                <span className="chain-token small">
                  {m.symbol.slice(0, 2)}
                </span>
                <strong>{m.name}</strong>
                <small>{age(m)}</small>
              </div>
              <div className="launch-card-values">
                {m.priceWei ? <Price wei={m.priceWei} /> : <Unavailable />}
                {change(m)}
              </div>
            </Link>
          ))}
        </div>
      </section>
      <div className="workspace-grid">
        <section className="panel market-panel">
          <div className="table-toolbar">
            <div className="table-tabs" aria-label="Pool views">
              {["all", "gainers", "new", "crowd", "watchlist"].map((t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  aria-pressed={tab === t}
                  onClick={() => set({ view: t, sort: null, dir: null })}
                >
                  {t === "watchlist" && <Star size={12} />}
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="market-filter-actions">
              <label className="filter-input">
                <Search size={13} />
                <input
                  name="pool-filter"
                  aria-label="Filter pools"
                  placeholder="Filter"
                  value={query}
                  onChange={(e) => set({ q: e.target.value || null })}
                />
              </label>
              <WindowTabs
                value={window}
                onChange={setWindow}
                options={["1h", "24h", "7d", "30d"]}
              />
            </div>
          </div>
          {tab === "watchlist" && (
            <div className="watchlist-sync">
              <span>
                Saved in this browser <small>Account sync coming soon</small>
              </span>
              <FeaturePreview feature="watchlist">
                Sync watchlist
              </FeaturePreview>
            </div>
          )}
          <div className="table-scroll desktop-pools">
            <table className="data-table screener-table">
              <thead>
                <tr>
                  <th />
                  {heading("Token", "name")}
                  {heading("Price", "price")}
                  {heading(`${window} change`, "change")}
                  {heading("Volume", "volume")}
                  <th>Liquidity</th>
                  <th>Holders</th>
                  <th>Launch sender</th>
                  {heading("Trend / age", "age")}
                  <th />
                </tr>
              </thead>
              <tbody>{pools.map(row)}</tbody>
            </table>
          </div>
          <div className="mobile-pools">
            {pools.map((m) => (
              <div className="mobile-pool" key={m.id}>
                <div className="mobile-pool-top">
                  <Link className="token-cell" href={poolHref(m)}>
                    <span className="chain-token">{m.symbol.slice(0, 2)}</span>
                    <span>
                      <strong>{m.name}</strong>
                      <small className="cell-sub">
                        {m.symbol} · {age(m)} · {stats.get(m.id)!.trades.length}{" "}
                        swaps
                      </small>
                    </span>
                  </Link>
                  <WatchButton id={m.id} />
                </div>
                <div className="mobile-pool-stats">
                  <span>
                    Price
                    <strong>
                      {m.priceWei ? (
                        <Price wei={m.priceWei} />
                      ) : (
                        <Unavailable />
                      )}
                    </strong>
                  </span>
                  <span>
                    {window} change<strong>{change(m)}</strong>
                  </span>
                  <span>
                    Volume
                    <strong>
                      <Eth wei={stats.get(m.id)!.volumeWei} />
                    </strong>
                  </span>
                  <span>
                    Holders
                    <strong>
                      <Unavailable />
                    </strong>
                  </span>
                </div>
                <div className="mobile-pool-footer">
                  <Link href={`/creators/${m.launchSender.toLowerCase()}/`}>
                    Launch sender{" "}
                    <span className="mono">{shortAddress(m.launchSender)}</span>
                  </Link>
                  <Sparkline
                    points={m.series}
                    positive={(stats.get(m.id)!.change ?? 0) >= 0}
                  />
                </div>
              </div>
            ))}
          </div>
          {!pools.length && (
            <div className="empty-state">
              <span className="empty-symbol">
                <SlidersHorizontal size={23} />
              </span>
              <h3>
                {tab === "crowd"
                  ? "Crowd launches are not indexed yet"
                  : tab === "watchlist"
                    ? "Your watchlist starts here"
                    : "No pools match"}
              </h3>
              <p>
                {tab === "watchlist"
                  ? "Star a pool to keep it here. Saved on this device; the covered sample can rotate."
                  : "Try another view or filter. Uncollected activity is not reported as zero."}
              </p>
            </div>
          )}
          <div className="corpus-footer">
            <span>
              Showing <strong>{pools.length}</strong> of{" "}
              <strong>{s.markets.length}</strong> covered pools
            </span>
            <Link href="/methodology/">Coverage & methodology ↗</Link>
          </div>
          <details className="coverage-disclosure">
            <summary>About this sample</summary>
            <p>
              Discovery blocks {s.fromBlock.toLocaleString("en-US")} to{" "}
              {s.toBlock.toLocaleString("en-US")}. Windows filter observed
              swaps, with change measured from the first available price when a
              pool is newer than the window. Missing metrics are unavailable,
              not zero. Token age is current. Market metrics reflect the capture
              above.
            </p>
          </details>
        </section>
        <aside className="market-sidebar">
          <TradeStream markets={s.markets} />
          <section className="panel top-traders-rail">
            <div className="panel-heading">
              <h2>Top traders</h2>
              <span className="subtle-badge">
                {audit?.market.symbol ?? "PER POOL"}
              </span>
            </div>
            {leaders.length && audit ? (
              <div className="rail-leaders">
                {leaders.map((w, i) => (
                  <Link
                    key={w.row.address}
                    href={walletHref(w.row.address, audit.market)}
                  >
                    <span className="rail-rank">{i + 1}</span>
                    <Avatar address={w.row.address} small />
                    <span>
                      <strong className="mono">
                        {shortAddress(w.row.address)}
                      </strong>
                      <small>{w.trades.length} swaps · this pool</small>
                    </span>
                    <Eth wei={w.realizedWei} signed />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rail-empty">
                <span className="eyebrow">ATTRIBUTION FIRST</span>
                <h3>Follow the traders.</h3>
                <p>
                  Qualifying positions appear after a pool audit. Rankings
                  require verified cost basis and at least 10 swaps.
                </p>
              </div>
            )}
            <Link className="leader-link" href="/traders/">
              Full leaderboard <ArrowUpRight size={13} />
            </Link>
          </section>
          <div className="scope-note">
            <span className="network-indicator" />
            <p>
              Focused on Pools launches on Robinhood. Explore the activity, then
              inspect who&apos;s behind it.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function Overview() {
  return <ProductExplore />;
}
