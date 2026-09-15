"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  CoverageSkeleton,
  StatsSkeleton,
  RowsSkeleton,
  LaunchesSkeleton,
} from "./skeletons";
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
  const sort = params.get("sort") ?? (view === "new" ? "launch" : "volume"),
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
  const { data, loading, error, refresh } =
    useProduct<AnalyticsExploreResponse>(`explore?${query}`);
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
          Trader leaderboard ↗
        </Link>
      </div>
      {loading && !data && (
        <div
          role="status"
          aria-label="Loading pool overview"
          aria-busy="true"
          data-skeleton="explore"
        >
          <CoverageSkeleton />
          <StatsSkeleton />
        </div>
      )}
      {data && (
        <>
          <ProductCoverage coverage={data.coverage} delivery={data.delivery} />
          <div className="stats-grid">
            <Stat label="Pools discovered" note="Saved launch catalog">
              {data.coverage.catalogPools}
            </Stat>
            <Stat label="Analytics ready" note="Background snapshots available">
              {data.coverage.processedPools}
            </Stat>
            <Stat label="Matching pools" note="Across the entire saved catalog">
              {data.total}
            </Stat>
            <Stat
              label="Market data"
              note="Unprocessed pools remain searchable"
            >
              {data.coverage.catalogPools
                ? `${Math.round((data.coverage.processedPools / data.coverage.catalogPools) * 100)}% covered`
                : "Pending"}
            </Stat>
          </div>
        </>
      )}
      {launches.loading && !launches.data && <LaunchesSkeleton />}
      {!!launches.data?.items.length && (
        <section className="launch-section" aria-label="Just launched">
          <div className="section-caption">
            <span>
              <i />
              Just launched
            </span>
            <button
              onClick={() => set({ view: "new", sort: "launch", offset: null })}
            >
              All covered launches →
            </button>
          </div>
          <div className="launch-rail">
            {launches.data.items.map((p) => (
              <Link className="launch-card" key={p.id} href={poolHref(p)}>
                <div className="launch-card-identity">
                  <PoolImage
                    poolId={p.id}
                    token={p.token}
                    hasImage={!!p.imageUrl}
                    size="small"
                  />
                  <span className="launch-card-label">
                    <strong>{p.name}</strong>
                    <small>
                      <time
                        data-launched-at={p.launchedAt}
                        dateTime={new Date(p.launchedAt * 1000).toISOString()}
                      >
                        {now === null
                          ? utc(p.launchedAt)
                          : since(p.launchedAt, now)}
                      </time>
                    </small>
                  </span>
                </div>
                <div className="launch-card-values">
                  {p.stats.priceWei ? (
                    <Price wei={p.stats.priceWei} />
                  ) : (
                    <span className="badge">Processing analytics</span>
                  )}
                  {p.stats.change !== null && <Change value={p.stats.change} />}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
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
            <div className="live-controls">
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
                  <option value="volume">Volume</option>
                  <option value="change">Price change</option>
                  <option value="launch">Launch time</option>
                  <option value="liquidity">Liquidity</option>
                </select>
              </label>
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
            {data?.message && <p className="panel-footnote">{data.message}</p>}
            {loading && !data ? (
              <RowsSkeleton label="Loading pools" />
            ) : (
              <>
                <div className="table-scroll desktop-pools">
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
                      {data?.items.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <WatchButton id={p.id} />
                          </td>
                          <td>
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
                          </td>
                          <td>
                            {p.stats.priceWei === null ? (
                              <Unavailable />
                            ) : (
                              <Price wei={p.stats.priceWei} />
                            )}
                          </td>
                          <td>
                            {p.stats.change === null ? (
                              <Unavailable />
                            ) : (
                              <Change value={p.stats.change} />
                            )}
                          </td>
                          <td>
                            <Eth wei={p.stats.volumeWei} />
                          </td>
                          <td>
                            <Eth wei={p.stats.liquidityWei} />
                          </td>
                          <td>{p.stats.holders ?? <Unavailable />}</td>
                          <td>
                            <Link
                              href={`/wallet/${p.launchSender.toLowerCase()}/`}
                              className="mono"
                            >
                              {shortAddress(p.launchSender)}
                            </Link>
                          </td>
                          <td>
                            {p.market?.series.length ? (
                              <Sparkline
                                points={p.market.series}
                                positive={(p.stats.change ?? 0) >= 0}
                              />
                            ) : (
                              <Unavailable />
                            )}
                          </td>
                          <td>
                            <span className="badge">
                              {p.processed ? "Saved" : "Processing"}
                            </span>
                            {p.asOf && (
                              <small className="cell-sub">{utc(p.asOf)}</small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mobile-pools">
                  {data?.items.map((p) => (
                    <article className="mobile-pool" key={p.id}>
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
                                : "Processing analytics"}
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
                    </article>
                  ))}
                </div>
              </>
            )}
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
            {data && (
              <ProductPagination
                offset={offset}
                total={data.total}
                nextOffset={data.nextOffset}
                onPage={(n) => set({ offset: String(n) })}
                loading={loading}
              />
            )}
          </section>
        </div>
        <aside className="market-sidebar">
          <TradeStream />
          <section className="panel">
            <div className="panel-heading">
              <h2>Top traders · 24h</h2>
            </div>
            {leaders.loading && !leaders.data && (
              <RowsSkeleton rows={3} label="Loading top traders" />
            )}
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
            <Link className="leader-link" href="/traders/">
              Full leaderboard ↗
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
