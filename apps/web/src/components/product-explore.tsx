"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { RefreshCw, Search } from "lucide-react";
import { TradeStream } from "./trade-stream";
import {
  poolHref,
  shortAddress,
  since,
  type AnalyticsLeaderboardResponse,
  type AnalyticsExploreResponse,
  type AnalyticsExploreOptions,
  type AnalyticsPoolRow,
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
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { ProductPagination } from "./product-common";
const subscribeClock = (notify: () => void) => {
  const id = setInterval(notify, 30000);
  return () => clearInterval(id);
};
const currentSeconds = () => Math.floor(Date.now() / 1000);
const serverSeconds = () => null;
function MarketBasis({ pool }: { pool: AnalyticsPoolRow }) {
  const basis = pool.marketCoverage;
  return (
    <span
      className="cell-sub"
      title={
        basis?.unitBasis
          ? `Price units: ${basis.unitBasis.decimals} decimals at block ${basis.unitBasis.block}, ${utc(basis.unitBasis.asOf)} (${basis.unitBasis.source}).`
          : "Normalized price units unavailable."
      }
    >
      {basis
        ? `${basis.source === "canonical_broad" ? "Broad swaps" : "Deep market"} · ${pool.stats.completeWindow ? "Covered window" : "Partial metrics"} · ${utc(basis.cutoff.asOf)}`
        : "Market unavailable"}
    </span>
  );
}
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
        <h1>
          Pools<span className="title-dot">.</span>
        </h1>
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
            <div className="table-toolbar explore-toolbar">
              <div className="table-tabs" aria-label="Pool views">
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
                    aria-pressed={view === key}
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
              </div>
              <div className="market-filter-actions">
                <label className="filter-input">
                  <Search size={13} aria-hidden="true" />
                  <input
                    aria-label="Filter pools"
                    placeholder="Filter tokens or address"
                    value={q}
                    maxLength={100}
                    onChange={(e) => set({ q: e.target.value, offset: null })}
                  />
                </label>
                <select
                  aria-label="Sort all pools"
                  value={sort}
                  onChange={(e) => set({ sort: e.target.value, offset: null })}
                >
                  <option value="volume">Volume</option>
                  <option value="trades">Trade count</option>
                  <option value="change">Price change</option>
                  <option value="launch">Launch time</option>
                  <option value="liquidity">Liquidity</option>
                </select>
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
                  className="icon-button"
                  title="Refresh saved data"
                  aria-label="Refresh saved data"
                  onClick={refresh}
                  disabled={loading}
                >
                  <RefreshCw size={12} />
                </button>
                <WindowTabs
                  value={window}
                  onChange={(value) => {
                    setWindow(value);
                    set({ offset: null });
                  }}
                  options={["1h", "24h", "7d", "30d", "All"]}
                />
              </div>
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
            <p className="panel-footnote">
              Observed windows end at each row&apos;s dated market cutoff.
              Coverage is partial across the catalog. Deep holders and verified
              PnL use separate evidence. Missing metrics remain N/A; sorting by
              a metric lists only pools with that metric.
            </p>
            {data?.broadMarketCutoff?.rebuildPending && (
              <p className="panel-footnote">
                Historical market rebuild is incomplete. The broad cutoff stops
                before the first missing batch.
              </p>
            )}
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
                      <th>{window} trades</th>
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
                          {p ? (
                            <>{p.stats.trades ?? <Unavailable />}</>
                          ) : data ? (
                            " "
                          ) : (
                            "Pending"
                          )}
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
                              {p.marketCoverage?.source !== "canonical_broad" &&
                              p.market?.series.length ? (
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
                                  : p.marketCoverage
                                    ? "Swaps only"
                                    : "Launch only"}
                              </span>
                              <MarketBasis pool={p} />
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
                        <MarketBasis pool={p} />
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
                            Trades
                            <strong>{p.stats.trades ?? <Unavailable />}</strong>
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
                          {[
                            "Price",
                            `${window} volume`,
                            "Trades",
                            "Change",
                          ].map((label) => (
                            <span key={label}>
                              {label}
                              <strong data-pending="true">Pending</strong>
                            </span>
                          ))}
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
