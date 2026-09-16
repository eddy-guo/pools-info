"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { TradeStream } from "./trade-stream";
import {
  poolHref,
  shortAddress,
  since,
  type AnalyticsLeaderboardResponse,
  type AnalyticsExploreResponse,
  type AnalyticsExploreOptions,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import {
  MAX_WATCHLIST_QUERY_POOLS,
  parseSharedWatchlist,
} from "@/lib/watchlist";
import { useQuery, useWatchlist } from "./state";
import { WatchlistControls } from "./watchlist-controls";
import { Change, Price, Sparkline, WatchButton } from "./ui";
import { PoolImage } from "./pool-image";
import { Eth, Stat, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { ProductCoverage, ProductPagination } from "./product-common";
const subscribeClock = (notify: () => void) => {
  const id = setInterval(notify, 30000);
  return () => clearInterval(id);
};
const currentSeconds = () => Math.floor(Date.now() / 1000);
const serverSeconds = () => null;
export function ProductExplore() {
  const now = useSyncExternalStore<number | null>(
    subscribeClock,
    currentSeconds,
    serverSeconds,
  );
  const launches = useProduct<AnalyticsExploreResponse>(
    "explore?sort=launch&direction=desc&limit=6&window=24h",
  );
  const leaders = useProduct<AnalyticsLeaderboardResponse>(
    "leaderboard?limit=5&window=24h&minTrades=10",
  );
  const { params, set } = useQuery(),
    { ids, add } = useWatchlist(),
    { window, setWindow } = useWindow("24h");
  const view = (params.get("view") ??
      (params.has("watchlist")
        ? "watchlist"
        : "all")) as AnalyticsExploreOptions["view"],
    offset = Math.max(0, Number(params.get("offset") ?? 0)),
    q = params.get("q") ?? "";
  const sort = params.get("sort") ?? "launch",
    direction = params.get("dir") ?? "desc";
  const query = new URLSearchParams({
    window,
    view: view ?? "all",
    offset: String(offset),
    limit: "25",
    q,
    sort,
    direction,
  });
  const shared = view === "watchlist" ? parseSharedWatchlist(params) : null;
  const watched = shared?.ids ?? ids;
  if (view === "watchlist")
    query.set("ids", watched.slice(0, MAX_WATCHLIST_QUERY_POOLS).join(","));
  const { data, loading, stale, error, refresh } =
    useProduct<AnalyticsExploreResponse>(`explore?${query}`);
  return (
    <div className="page explore-page">
      <div className="page-heading">
        <div>
          <h1>
            Pools<span className="title-dot">.</span>
          </h1>
          <p>
            Explore every discovered Pools launch. Market data covers the
            evidence subset.
          </p>
        </div>
        <Link className="button" href="/traders/">
          Trader leaderboard ↗
        </Link>
      </div>
      <ProductCoverage coverage={data?.coverage} delivery={data?.delivery} />
      <div className="stats-grid">
        <Stat
          pending={!data}
          label="Pools discovered"
          note="All discovered launches"
        >
          {data?.coverage.catalogPools}
        </Stat>
        <Stat
          pending={!data}
          label="Market evidence"
          note="Pools with saved market data"
        >
          {data?.coverage.processedPools}
        </Stat>
        <Stat
          pending={!data}
          label="Matching pools"
          note="Across the entire saved catalog"
        >
          {data?.total}
        </Stat>
        <Stat
          pending={!data}
          label="Market data"
          note="Leaderboard uses the evidence subset"
        >
          {data?.coverage.catalogPools
            ? `${Math.round((data.coverage.processedPools / data.coverage.catalogPools) * 100)}% covered`
            : "Pending"}
        </Stat>
      </div>
      <section className="launch-section" aria-label="Just launched">
        <div className="section-caption">
          <span>
            <i />
            Just launched
          </span>
          <button
            onClick={() => set({ view: "new", sort: "launch", offset: null })}
          >
            All discovered launches →
          </button>
        </div>
        <div className="launch-rail">
          {Array.from(
            { length: 6 },
            (_, index) => launches.data?.items[index],
          ).map((p, index) => (
            <Link
              className="launch-card"
              key={index}
              href={p ? poolHref(p) : "/"}
              prefetch={!!p}
              aria-disabled={!p}
              tabIndex={p ? undefined : -1}
              onClick={(event) => {
                if (!p) event.preventDefault();
              }}
            >
              <div className="launch-card-identity">
                {p ? (
                  <PoolImage
                    poolId={p.id}
                    token={p.token}
                    hasImage={!!p.imageUrl}
                    size="small"
                  />
                ) : (
                  <span
                    className="chain-token small"
                    data-pending={!launches.data}
                  >
                    Token
                  </span>
                )}
                <span className="launch-card-label">
                  <strong data-pending={!p && !launches.data}>
                    {p?.name ?? (launches.data ? "\u00a0" : "Pool pending")}
                  </strong>
                  <small>
                    <time
                      data-pending={
                        (!p && !launches.data) || (!!p && now === null)
                      }
                      data-launched-at={p?.launchedAt}
                      dateTime={
                        p
                          ? new Date(p.launchedAt * 1000).toISOString()
                          : undefined
                      }
                      title={p ? utc(p.launchedAt) : undefined}
                    >
                      {p && now !== null
                        ? since(p.launchedAt, now)
                        : launches.data && !p
                          ? "\u00a0"
                          : "Pending"}
                    </time>
                  </small>
                </span>
              </div>
              <div className="launch-card-values">
                <Price wei={p?.stats.priceWei} pending={!launches.data} />
                <Change value={p?.stats.change} pending={!launches.data} />
              </div>
            </Link>
          ))}
        </div>
      </section>
      <div className="workspace-grid">
        <div>
          <section className="panel">
            <div className="table-tabs live-controls">
              {(
                [
                  ["all", "All"],
                  ["gainers", "Gainers"],
                  ["new", "New"],
                  ["crowd", "Crowd"],
                  ["watchlist", "Watchlist"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={view === key ? "active" : ""}
                  onClick={() =>
                    set({
                      view: key,
                      watchlist: null,
                      offset: null,
                      sort: null,
                    })
                  }
                >
                  {label}
                </button>
              ))}
              <WindowTabs
                value={window}
                onChange={(value) => {
                  setWindow(value);
                  set({ offset: null });
                }}
                options={["1h", "24h", "7d", "30d", "All"]}
              />
            </div>
            <div className="live-controls explore-controls">
              <input
                aria-label="Filter pools"
                placeholder="Filter tokens or paste an address"
                value={q}
                maxLength={100}
                onChange={(e) => set({ q: e.target.value, offset: null })}
              />
              <label>
                Sort
                <select
                  aria-label="Sort all pools"
                  value={sort}
                  onChange={(e) => set({ sort: e.target.value, offset: null })}
                >
                  <option value="volume">Volume - market data only</option>
                  <option value="change">
                    Price change - market data only
                  </option>
                  <option value="launch">Launch time</option>
                  <option value="liquidity">
                    Liquidity - market data only
                  </option>
                </select>
              </label>
              <span className="sort-coverage" data-pending={!data || undefined}>
                {data
                  ? sort === "launch" || view === "new"
                    ? `${data.total.toLocaleString("en-US")} discovered pools`
                    : `${data.total.toLocaleString("en-US")} pools with ${sort === "liquidity" ? "liquidity" : sort === "change" ? "price-change" : "market"} data`
                  : "Pool coverage pending"}
              </span>
              <button
                className="button secondary"
                onClick={() =>
                  set({
                    dir: direction === "desc" ? "asc" : "desc",
                    offset: null,
                  })
                }
              >
                {direction === "desc" ? "High to low ↓" : "Low to high ↑"}
              </button>
              <button
                className="button secondary"
                onClick={refresh}
                disabled={loading}
              >
                Refresh saved data
              </button>
            </div>
            {view === "watchlist" && (
              <WatchlistControls
                ids={watched}
                shared={shared}
                query={params.toString()}
                save={add}
                openPersonal={() => set({ watchlist: null, offset: null })}
              />
            )}
            {loading && data && (
              <span className="sr-only" role="status">
                Updating saved pools
              </span>
            )}
            {error && (
              <p className="panel-footnote" role="alert">
                {error}
              </p>
            )}
            <p className="panel-footnote explore-message">
              {data?.message ?? "\u00a0"}
            </p>
            <>
              <div
                className="table-scroll desktop-pools"
                aria-busy={stale}
                data-stale-rows={stale}
              >
                <table className="data-table pool-table">
                  <thead>
                    <tr>
                      <th aria-label="Watchlist" />
                      <th>Token</th>
                      <th>Price</th>
                      <th>{window} change</th>
                      <th>{window} volume</th>
                      <th>Liquidity</th>
                      <th>Holders</th>
                      <th>Launch sender</th>
                      <th>Trend</th>
                      <th>Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(
                      { length: Math.max(25, data?.items.length ?? 0) },
                      (_, index) => data?.items[index],
                    ).map((p, index) => (
                      <tr
                        key={index}
                        aria-hidden={!p}
                        data-row={p ? "resolved" : "reserved"}
                      >
                        <td data-pending={!p && !data}>
                          {p ? (
                            <>
                              <WatchButton id={p.id} />
                            </>
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                        <td data-pending={!p && !data}>
                          {p ? (
                            <>
                              <Link className="token-cell" href={poolHref(p)}>
                                <PoolImage
                                  poolId={p.id}
                                  token={p.token}
                                  hasImage={!!p.imageUrl}
                                />
                                <span>
                                  <strong>{p.name}</strong>
                                  <small>
                                    {p.symbol} ·{" "}
                                    {new Date(
                                      p.launchedAt * 1000,
                                    ).toLocaleDateString("en-US", {
                                      timeZone: "UTC",
                                    })}
                                  </small>
                                </span>
                              </Link>
                            </>
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                        <td data-pending={!p && !data}>
                          <Price wei={p?.stats.priceWei} pending={!data} />
                        </td>
                        <td data-pending={!p && !data}>
                          <Change value={p?.stats.change} pending={!data} />
                        </td>
                        <td data-pending={!p && !data}>
                          <Eth pending={!data} wei={p?.stats.volumeWei} />
                        </td>
                        <td data-pending={!p && !data}>
                          <Eth pending={!data} wei={p?.stats.liquidityWei} />
                        </td>
                        <td data-pending={!p && !data}>
                          {p ? (
                            <>{p.stats.holders ?? <Unavailable />}</>
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                        <td data-pending={!p && !data}>
                          {p ? (
                            <>
                              <Link
                                href={`/wallet/${p.launchSender.toLowerCase()}/`}
                                className="mono"
                              >
                                {shortAddress(p.launchSender)}
                              </Link>
                            </>
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                        <td data-pending={!p && !data}>
                          {p ? (
                            <>
                              {p.market?.series.length ? (
                                <Sparkline
                                  points={p.market.series}
                                  positive={(p.stats.change ?? 0) >= 0}
                                />
                              ) : (
                                <Unavailable />
                              )}
                            </>
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                        <td data-pending={!p && !data}>
                          {p ? (
                            <>
                              <span className="badge">
                                {p.processed
                                  ? "Market evidence"
                                  : "Launch only"}
                              </span>
                              {p.asOf && (
                                <small className="cell-sub">
                                  {utc(p.asOf)}
                                </small>
                              )}
                            </>
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div
                className="mobile-pools"
                aria-busy={stale}
                data-stale-rows={stale}
              >
                {Array.from(
                  { length: Math.max(25, data?.items.length ?? 0) },
                  (_, index) => data?.items[index],
                ).map((p, index) => (
                  <article className="mobile-pool" key={index}>
                    {p ? (
                      <>
                        <div className="mobile-pool-top">
                          <Link className="token-cell" href={poolHref(p)}>
                            <PoolImage
                              poolId={p.id}
                              token={p.token}
                              hasImage={!!p.imageUrl}
                            />
                            <span>
                              <strong>{p.name}</strong>
                              <small>
                                {p.symbol} ·{" "}
                                {p.processed
                                  ? "Saved analytics"
                                  : "Launch only"}
                              </small>
                            </span>
                          </Link>
                          <WatchButton id={p.id} />
                        </div>
                        <div className="mobile-pool-stats">
                          <span>
                            Price
                            <strong>
                              {p.stats.priceWei === null ? (
                                <Unavailable />
                              ) : (
                                <Price wei={p.stats.priceWei} />
                              )}
                            </strong>
                          </span>
                          <span>
                            {window} volume
                            <strong>
                              <Eth wei={p.stats.volumeWei} />
                            </strong>
                          </span>
                          <span>
                            Change
                            <strong>
                              {p.stats.change === null ? (
                                <Unavailable />
                              ) : (
                                <Change value={p.stats.change} />
                              )}
                            </strong>
                          </span>
                        </div>
                      </>
                    ) : !data ? (
                      <>
                        <div className="mobile-pool-top">
                          <span className="token-cell">
                            <span className="chain-token" data-pending="true">
                              Token
                            </span>
                            <span>
                              <strong data-pending="true">Pool pending</strong>
                              <small data-pending="true">
                                Coverage pending
                              </small>
                            </span>
                          </span>
                        </div>
                        <div className="mobile-pool-stats">
                          {["Price", `${window} volume`, "Change"].map(
                            (label) => (
                              <span key={label}>
                                {label}
                                <strong data-pending="true">Pending</strong>
                              </span>
                            ),
                          )}
                        </div>
                      </>
                    ) : null}
                  </article>
                ))}
              </div>
            </>
            {data && !data.items.length && !loading && (
              <div className="empty-state">
                <h3>
                  {view === "watchlist" && !watched.length
                    ? shared
                      ? "This shared watchlist cannot be displayed"
                      : "Your watchlist starts here"
                    : shared
                      ? "No shared pools match these filters"
                      : "No pools match these filters"}
                </h3>
                <p>
                  {view === "watchlist" && !watched.length
                    ? shared
                      ? "Ask for a new link, or open your own watchlist."
                      : "Star pools on Explore to save them in this browser."
                    : shared
                      ? "Try clearing the filter. Shared pools must be in the saved catalog to appear here."
                      : "Try another token or select All. Unprocessed launches are included in the catalog."}
                </p>
              </div>
            )}
            <ProductPagination
              offset={offset}
              total={data?.total ?? 0}
              nextOffset={data?.nextOffset ?? null}
              onPage={(n) => set({ offset: String(n) })}
              loading={loading}
            />
          </section>
        </div>
        <aside className="market-sidebar">
          <TradeStream />
          <section className="panel explore-leaders">
            <div className="panel-heading">
              <h2>Top traders · 24h</h2>
            </div>
            <div className="explore-leader-rows">
              {!leaders.data &&
                Array.from({ length: 5 }, (_, index) => (
                  <div className="leader-link" key={index} aria-hidden="true">
                    <span data-pending="true">Wallet pending</span>
                    <span className="number" data-pending="true">
                      PnL pending
                    </span>
                  </div>
                ))}
              {leaders.data?.items.map((w) => (
                <Link
                  className="leader-link"
                  key={w.address}
                  href={`/wallet/${w.address}/?window=24h`}
                >
                  <span>
                    #{w.rank} {shortAddress(w.address)}
                  </span>
                  <Eth wei={w.realizedWei} signed />
                </Link>
              ))}
              {!leaders.loading && !leaders.data?.items.length && (
                <p className="panel-footnote">
                  No qualifying saved traders in this window yet.
                </p>
              )}
            </div>
            <Link className="leader-link" href="/traders/">
              Full leaderboard ↗
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
