"use client";
import Link from "next/link";
import {
  poolHref,
  poolWindow,
  shortAddress,
  since,
  type ChainMarket,
} from "@pools/core";
import { TradeStream } from "./trade-stream";
import { FeaturePreview } from "./feature-preview";
import { useLive } from "./live-provider";
import { useQuery, useWatchlist } from "./state";
import { Change, Price, Sparkline, WatchButton } from "./ui";
import {
  Eth,
  Stat,
  Unavailable,
  WindowTabs,
  useWindow,
  explorer,
} from "./live-ui";
export function Overview() {
  const { snapshot: s } = useLive();
  const { params, set } = useQuery();
  const { ids } = useWatchlist();
  const { window, setWindow } = useWindow("24h");
  const tab = params.get("view") ?? "all",
    query = params.get("q") ?? "";
  const stats = new Map(s.markets.map((m) => [m.id, poolWindow(m, s, window)]));
  const pools = s.markets
    .filter(
      (m) =>
        (tab !== "watchlist" || ids.includes(m.id)) &&
        tab !== "crowd" &&
        `${m.name} ${m.symbol} ${m.token}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (tab !== "gainers" || (stats.get(m.id)!.change ?? 0) > 0),
    )
    .sort((a, b) =>
      tab === "gainers"
        ? (stats.get(b.id)!.change ?? 0) - (stats.get(a.id)!.change ?? 0)
        : tab === "new"
          ? b.launchedAt - a.launchedAt
          : Number(
              BigInt(stats.get(b.id)!.volumeWei) -
                BigInt(stats.get(a.id)!.volumeWei),
            ),
    );
  const volume = s.markets
    .reduce((n, m) => n + BigInt(stats.get(m.id)!.volumeWei), 0n)
    .toString();
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
                {m.symbol} · {since(m.launchedAt, s.toTimestamp)} ·{" "}
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
        <td>
          {stat.change === null ? (
            <Unavailable reason="No opening price observation" />
          ) : (
            <>
              <Change value={stat.change} />
              {stat.sinceLaunch && (
                <small className="cell-sub">Since first swap</small>
              )}
            </>
          )}
        </td>
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
            className="mono"
            href={`/creators/${m.launchSender.toLowerCase()}/`}
          >
            {shortAddress(m.launchSender)}
          </Link>
          <small className="cell-sub">Launch sender</small>
        </td>
        <td>
          <Sparkline points={m.series} positive={(stat.change ?? 0) >= 0} />
        </td>
      </tr>
    );
  }
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ROBINHOOD CHAIN / POOL ANALYTICS</div>
          <h1>
            Explore pools<span className="title-dot">.</span>
          </h1>
          <p>
            Real launches and swaps. A recent sample with explicit coverage.
          </p>
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          label={`Observed volume · ${window}`}
          note="Selected recent pools only"
        >
          <Eth wei={volume} />
        </Stat>
        <Stat label="Liquidity locked" note="Reserve collection pending">
          <Unavailable />
        </Stat>
        <Stat
          label="Launches covered"
          note={`${s.discoveredLaunches} discovered; newest ${s.markets.length} included`}
        >
          {s.markets.length}
        </Stat>
        <Stat
          label="Active traders"
          note="Needs receipt-level attribution across the sample"
        >
          <Unavailable />
        </Stat>
      </div>
      <section className="launch-rail" aria-label="Just launched">
        <strong>Just launched</strong>
        {s.markets.slice(0, 5).map((m) => (
          <Link key={m.id} href={poolHref(m)}>
            <b>{m.symbol}</b>
            <span>{since(m.launchedAt, s.toTimestamp)} at cutoff</span>
          </Link>
        ))}
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
                  onClick={() => set({ view: t })}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <WindowTabs
              value={window}
              onChange={setWindow}
              options={["1h", "24h", "7d", "30d"]}
            />
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
          <div className="filter-row">
            <label className="filter-input">
              <input
                name="pool-filter"
                aria-label="Filter pools"
                placeholder="Token name, symbol or address"
                value={query}
                onChange={(e) => set({ q: e.target.value || null })}
              />
            </label>
          </div>
          <p className="panel-footnote">
            Windows filter swaps within covered pools, not all chain launches.
            Discovery blocks {s.fromBlock.toLocaleString("en-US")} to{" "}
            {s.toBlock.toLocaleString("en-US")}. Each pool is collected from
            launch. Missing metrics are not zero.
          </p>
          <div className="table-scroll desktop-pools">
            <table className="data-table">
              <thead>
                <tr>
                  <th />
                  <th>Token</th>
                  <th>Spot price</th>
                  <th>{window} change</th>
                  <th>Volume</th>
                  <th>Liquidity</th>
                  <th>Holders</th>
                  <th>Creator context</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>{pools.map(row)}</tbody>
            </table>
          </div>
          <div className="mobile-pools">
            {pools.map((m) => (
              <div className="mobile-pool" key={m.id}>
                <div className="mobile-pool-top">
                  <Link href={poolHref(m)}>
                    <strong>{m.name}</strong>
                    <small className="cell-sub">
                      {m.symbol} · {stats.get(m.id)!.trades.length} swaps
                    </small>
                  </Link>
                  <WatchButton id={m.id} />
                </div>
                <div className="mobile-pool-stats">
                  <span>
                    Price{" "}
                    {m.priceWei ? <Price wei={m.priceWei} /> : <Unavailable />}
                  </span>
                  <span>
                    Volume <Eth wei={stats.get(m.id)!.volumeWei} />
                  </span>
                </div>
              </div>
            ))}
          </div>
          {!pools.length && (
            <div className="empty-state">
              <h3>
                {tab === "crowd"
                  ? "Crowd launches are not indexed yet"
                  : tab === "watchlist"
                    ? "No watched pools in current coverage"
                    : "No pools match"}
              </h3>
              <p>
                {tab === "watchlist"
                  ? "Stars are saved on this device. The recent launch sample can rotate."
                  : "Try another filter. Uncollected activity is not reported as zero."}
              </p>
            </div>
          )}
        </section>
        <aside className="market-sidebar">
          <TradeStream markets={s.markets} />
          <section className="panel">
            <div className="panel-heading">
              <h2>Latest observed trades</h2>
            </div>
            <div className="activity-list">
              {s.trades.slice(0, 8).map((t) => {
                const m = s.markets.find((m) => m.id === t.poolId)!;
                return (
                  <a
                    className="activity-item"
                    key={`${t.txHash}:${t.logIndex}`}
                    href={`${explorer}/tx/${t.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <strong>
                      {m.symbol}{" "}
                      <span
                        className={t.side === "buy" ? "positive" : "negative"}
                      >
                        {t.side}
                      </span>
                    </strong>
                    <div>
                      <Eth wei={t.ethWei} />
                      <small>
                        {since(t.timestamp, s.toTimestamp)} before cutoff ↗
                      </small>
                    </div>
                  </a>
                );
              })}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Top traders</h2>
            </div>
            <p className="panel-footnote">
              Run a pool audit to rank supported positions. Cross-pool rankings
              need broader inventory history.
            </p>
            <Link className="leader-link" href="/traders/">
              Open trader leaderboard ↗
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
