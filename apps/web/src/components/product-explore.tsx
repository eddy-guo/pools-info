"use client";
import Link from "next/link";
import {
  Fragment,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RefreshCw, Search, Star } from "lucide-react";
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
import { useExploreRows } from "@/lib/use-explore-rows";
import { rememberPoolRow } from "@/lib/pool-row-memory";
import {
  MAX_WATCHLIST_QUERY_POOLS,
  parseSharedWatchlist,
} from "@/lib/watchlist";
import { useDebouncedInput, useQuery, useWatchlist } from "./state";
import { WatchlistControls } from "./watchlist-controls";
import { AddressChip, Change, EmptyState, Price, WatchButton } from "./ui";
import { PoolImage } from "./pool-image";
import { Eth, WindowTabs, useWindow, utc } from "./live-ui";
import { SHOW_MORE_STEP, ShowMore } from "./product-common";
const subscribeClock = (notify: () => void) => {
  const id = setInterval(notify, 30000);
  return () => clearInterval(id);
};
const currentSeconds = () => Math.floor(Date.now() / 1000);
const serverSeconds = () => null;
/** The launches tab: the API sorts this view by launch time on its own. */
const LAUNCH_VIEW = "new";
/**
 * A pool with neither a deep publication nor a broad rollup has no market
 * evidence at all; it reads as a launch rather than as a row of N/A.
 */
const launchOnly = (pool: AnalyticsPoolRow) =>
  !pool.processed && !pool.marketCoverage;
/** The most rows the screener shows at once: forty pages of Show more, and
    the most a hand-edited or stale URL can make a page read and render. */
const CAP = 1000;
/** Brings the panel's head back under the site header when it has scrolled away. */
function headIntoView(panel: HTMLElement | null) {
  const padding =
    parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) ||
    0;
  if (panel && panel.getBoundingClientRect().top < padding)
    panel.scrollIntoView({ block: "start" });
}
/** Whole counts with the export's thousands separators: `1,284 trades`. */
const integers = new Intl.NumberFormat("en-US");
/**
 * The table row's subtitle, as the export sets it: the symbol in mono, the
 * pool's age and (on desktop) its trade count in the window, separated by
 * middle dots. A launch without market evidence keeps its symbol alone (its
 * launch line carries the age), and a figure the read API does not send is
 * left out rather than marked. The phone row keeps only the age (`trades`
 * false) to hold its identity tile to `SYMBOL · age`.
 */
function RowSubtitle({
  pool,
  now,
  trades = true,
}: {
  pool: AnalyticsPoolRow;
  now: number | null;
  trades?: boolean;
}) {
  const facts = launchOnly(pool)
    ? []
    : [
        now === null ? null : since(pool.launchedAt, now),
        !trades || pool.stats.trades === null
          ? null
          : `${integers.format(pool.stats.trades)} trades`,
      ].filter((fact) => fact !== null);
  return (
    <>
      <span className="mono">{pool.symbol}</span>
      {facts.map((fact) => (
        <Fragment key={fact}>
          {" · "}
          {fact}
        </Fragment>
      ))}
    </>
  );
}
function PoolCell({
  pool,
  subtitle,
}: {
  pool: AnalyticsPoolRow;
  subtitle?: ReactNode;
}) {
  /* The read API does not publish every pool's detail; the page this row opens
     reads back what the row already showed rather than dropping its identity. */
  useEffect(() => rememberPoolRow(pool), [pool]);
  return (
    <Link className="token-cell" href={poolHref(pool)}>
      <PoolImage
        poolId={pool.id}
        token={pool.token}
        hasImage={!!pool.imageUrl}
      />
      <span>
        <strong>{pool.name}</strong>
        <small>
          {subtitle ??
            (launchOnly(pool)
              ? pool.symbol
              : `${pool.symbol} · ${new Date(
                  pool.launchedAt * 1000,
                ).toLocaleDateString("en-US", { timeZone: "UTC" })}`)}
        </small>
      </span>
    </Link>
  );
}
function LaunchLine({
  pool,
  now,
}: {
  pool: AnalyticsPoolRow;
  now: number | null;
}) {
  return (
    <span className="launch-line">
      Launched{" "}
      <time
        data-pending={now === null}
        dateTime={new Date(pool.launchedAt * 1000).toISOString()}
        title={utc(pool.launchedAt)}
      >
        {now === null ? "Pending" : since(pool.launchedAt, now)}
      </time>{" "}
      ago
      <span aria-hidden="true"> · </span>
      <Link
        href={`/wallet/${pool.launchSender.toLowerCase()}/`}
        className="mono"
      >
        {shortAddress(pool.launchSender)}
      </Link>
    </span>
  );
}
/* The read API also orders by liquidity, but the screener does not offer it,
   so a URL naming it reads as the default order. */
type ScreenerSort = Exclude<
  NonNullable<AnalyticsExploreOptions["sort"]>,
  "liquidity"
>;
const SCREENER_SORTS: readonly string[] = [
  "volume",
  "trades",
  "change",
  "launch",
] satisfies ScreenerSort[];
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
  const { params, set: setQuery } = useQuery(),
    { ids, add } = useWatchlist(),
    { window, setWindow } = useWindow("24h");
  const view = (params.get("view") ??
      (params.has("watchlist")
        ? "watchlist"
        : "all")) as AnalyticsExploreOptions["view"],
    q = params.get("q") ?? "";
  /* A bookmarked order no header offers reads as the default, direction
     included, and leaves the URL at the next write. */
  const requested = params.get("sort"),
    staleSort = requested !== null && !SCREENER_SORTS.includes(requested),
    sort =
      (staleSort ? null : requested) ??
      (view === LAUNCH_VIEW ? "launch" : "volume"),
    direction = (staleSort ? null : params.get("dir")) ?? "desc";
  const write = (updates: Record<string, string | null>) =>
    setQuery(staleSort ? { sort: null, dir: null, ...updates } : updates);
  /* A new query reads from the top: the panel's head comes back under the
     site header while the rows swap to skeletons, and the rows on show go
     back to the first page. */
  const panelRef = useRef<HTMLElement>(null);
  const set = (updates: Record<string, string | null>) => {
    write({ ...updates, limit: null });
    headIntoView(panelRef.current);
  };
  /* The rows on show live in the URL as `limit`, as on the traders and
     creators lists: absent or invalid, the first page; each Show more adds
     the next page, and a reload or Back brings back what was on show. */
  const rawLimit = Number(params.get("limit")),
    shown =
      Number.isInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, CAP)
        : SHOW_MORE_STEP;
  const filter = useDebouncedInput(q, (next) => set({ q: next }));
  /* Both read paths pin the launches view to launch order, so no header
     claims it there. */
  const activeSort = view === LAUNCH_VIEW ? "launch" : sort,
    ascending = direction === "asc";
  const sortBy = (key: ScreenerSort) => {
    if (activeSort !== key)
      set({
        sort: key,
        dir: "desc",
        ...(view === LAUNCH_VIEW ? { view: "all" } : null),
      });
    else if (!ascending) set({ sort: key, dir: "asc" });
    else set({ sort: null, dir: null });
  };
  /* Three states per column: descending, ascending, then back to the default.
     The arrow sits before the label, out of the flow, as the explore
     reference's does: the label keeps its right edge on the column's figures
     and the head's box never changes with the order, so a sorted or launches
     URL hydrating over the static default head moves nothing. */
  const sortable = (label: string, key: ScreenerSort) => (
    <th
      aria-sort={
        activeSort === key ? (ascending ? "ascending" : "descending") : "none"
      }
    >
      <button
        className={activeSort === key ? "sort-active" : ""}
        onClick={() => sortBy(key)}
      >
        {activeSort === key && (
          <span className="sort-arrow" aria-hidden="true">
            {ascending ? "↑" : "↓"}
          </span>
        )}
        {label}
      </button>
    </th>
  );
  const query = new URLSearchParams({
    window,
    view: view ?? "all",
    q,
    sort,
    direction,
  });
  const shared = view === "watchlist" ? parseSharedWatchlist(params) : null;
  const watched = shared?.ids ?? ids;
  if (view === "watchlist")
    query.set("ids", watched.slice(0, MAX_WATCHLIST_QUERY_POOLS).join(","));
  const { list, loading, settled, error, refresh } = useExploreRows(
    query.toString(),
    shown,
  );
  const launchPage = !!list?.rows.length && list.rows.every(launchOnly);
  const empty = settled && list?.total === 0;
  /* The rows on show, reserved from the URL before any data so a read that
     lands never resizes the table. A view, sort, window or filter change
     swaps straight to skeleton rows instead of dimming the previous view's,
     which the hook drops with the query; a same-query refresh keeps showing
     the rows it already has while it quietly reloads them; a Show more adds
     its rows as skeletons under the ones on show, and a row past the list's
     end is left blank rather than shimmering for nothing. */
  const shownRows = Array.from(
    { length: shown },
    (_, index) => list?.rows[index],
  );
  const skeletonAt = (index: number) =>
    !list || (loading && index < list.total);
  /* Show more keeps the reader where they are and lands them on the first
     new row once it arrives, rather than bringing the panel's head back. It
     asks for no more than the list holds, so the last page reserves the rows
     it will fill and none past the end. */
  const focusAt = useRef<number | null>(null);
  const showMore = () => {
    focusAt.current = shown;
    write({
      limit: String(
        Math.min(shown + SHOW_MORE_STEP, list?.total ?? Infinity, CAP),
      ),
    });
  };
  const rows = list?.rows;
  useEffect(() => {
    const index = focusAt.current;
    if (index === null || !rows || rows.length <= index) return;
    focusAt.current = null;
    const links = panelRef.current?.querySelectorAll<HTMLElement>(
      `[data-row-index="${index}"] a.token-cell`,
    );
    /* Both layouts hold the row; the one the container query shows has a box. */
    [...(links ?? [])].find((link) => link.getClientRects().length)?.focus();
  }, [rows]);
  return (
    <div className="page explore-page">
      <div className="page-heading">
        <h1>
          Pools<span className="title-dot">.</span>
        </h1>
        <Link href="/traders/" className="leaderboard-cta">
          Trader leaderboard →
        </Link>
      </div>
      <section className="launch-section" aria-label="Just launched">
        <div className="section-caption">
          <span>
            <i />
            Just launched
          </span>
          <button onClick={() => set({ view: LAUNCH_VIEW, sort: null })}>
            All launches →
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
                {p && launchOnly(p) ? (
                  <span className="mono launch-card-sender">
                    {shortAddress(p.launchSender)}
                  </span>
                ) : p ? (
                  <>
                    <Price wei={p.stats.priceWei} />
                    <Change value={p.stats.change} />
                  </>
                ) : (
                  <>
                    <span data-pending={!launches.data}>
                      {launches.data ? "\u00a0" : "Price"}
                    </span>
                    <span
                      className="mono launch-card-sender"
                      data-pending={!launches.data}
                    >
                      {launches.data ? "\u00a0" : "Sender"}
                    </span>
                  </>
                )}
              </div>
            </Link>
          ))}
        </div>
      </section>
      <div className="workspace-grid">
        <div>
          <section className="panel" ref={panelRef}>
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
                      set({ view: key, watchlist: null, sort: null })
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
                    value={filter.value}
                    maxLength={100}
                    onChange={(e) => filter.set(e.target.value)}
                    onBlur={filter.flush}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") filter.flush();
                    }}
                  />
                </label>
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
                    set({});
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
                openPersonal={() => set({ watchlist: null })}
              />
            )}
            {loading && (
              <span className="sr-only" role="status">
                Updating saved pools
              </span>
            )}
            {error && (
              <p className="panel-footnote" role="alert">
                {error}
              </p>
            )}
            {/* The reserved row geometry stays put when a filter matches
                nothing; the empty state overlays the top of that area so the
                message reads directly under the toolbar instead of below a
                screen and a half of blank rows. */}
            <div className="table-region" data-empty={empty}>
              <div className="table-scroll desktop-pools" aria-busy={loading}>
                <table className="data-table pool-table">
                  {/* Column widths live here so a row that spans the metric
                      columns cannot move the ones before it. */}
                  <colgroup>
                    <col className="col-watch" />
                    <col className="col-token" />
                    <col className="col-price" />
                    <col className="col-change" />
                    <col className="col-volume" />
                    <col className="col-sender" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th aria-label="Watchlist" />
                      <th>Token</th>
                      {launchPage ? (
                        <th colSpan={4}>Launch</th>
                      ) : (
                        <>
                          <th>Price</th>
                          {/* The change is measured over the selected window,
                              so its head names the window as the export's does. */}
                          {sortable(window, "change")}
                          {sortable("Volume", "volume")}
                          <th>Launch sender</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((p, index) => {
                      const skeleton = !p && skeletonAt(index);
                      return (
                        <tr
                          key={index}
                          data-row-index={index}
                          aria-hidden={!p}
                          data-row={
                            p ? "resolved" : skeleton ? "skeleton" : "reserved"
                          }
                        >
                          <td data-pending={skeleton}>
                            {p ? (
                              <>
                                <WatchButton id={p.id} />
                              </>
                            ) : skeleton ? (
                              "Pending"
                            ) : (
                              "\u00a0"
                            )}
                          </td>
                          <td data-pending={skeleton}>
                            {p ? (
                              <PoolCell
                                pool={p}
                                subtitle={<RowSubtitle pool={p} now={now} />}
                              />
                            ) : skeleton ? (
                              "Pending"
                            ) : (
                              "\u00a0"
                            )}
                          </td>
                          {p && launchOnly(p) ? (
                            <td className="launch-cell" colSpan={4}>
                              <LaunchLine pool={p} now={now} />
                            </td>
                          ) : (
                            <>
                              <td data-pending={skeleton}>
                                {p || skeleton ? (
                                  <Price
                                    wei={p?.stats.priceWei}
                                    pending={skeleton}
                                  />
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                              <td data-pending={skeleton}>
                                {p || skeleton ? (
                                  <Change
                                    value={p?.stats.change}
                                    pending={skeleton}
                                  />
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                              <td data-pending={skeleton}>
                                {p || skeleton ? (
                                  <Eth
                                    pending={skeleton}
                                    wei={p?.stats.volumeWei}
                                  />
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                              <td data-pending={skeleton}>
                                {p ? (
                                  <AddressChip
                                    address={p.launchSender}
                                    href={`/wallet/${p.launchSender.toLowerCase()}/`}
                                    stacked
                                  />
                                ) : skeleton ? (
                                  "Pending"
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mobile-pools" aria-busy={loading}>
                {shownRows.map((p, index) => {
                  const skeleton = !p && skeletonAt(index);
                  return (
                    <article
                      className="mobile-pool"
                      key={index}
                      data-row-index={index}
                      data-row={
                        p ? "resolved" : skeleton ? "skeleton" : "reserved"
                      }
                    >
                      {p ? (
                        <>
                          <div className="mobile-pool-top">
                            <PoolCell
                              pool={p}
                              subtitle={
                                <RowSubtitle pool={p} now={now} trades={false} />
                              }
                            />
                            {!launchOnly(p) && (
                              <div className="mobile-pool-price">
                                <Price wei={p.stats.priceWei} />
                                <Change value={p.stats.change} />
                              </div>
                            )}
                            <WatchButton id={p.id} />
                          </div>
                          {launchOnly(p) ? (
                            /* The card holds a fixed height, so the launch
                             age and sender take the stat slot rather than
                             leaving most of it empty. The chip is the same
                             shared small one the leaderboard's mobile row
                             uses, at its own compact size. */
                            <div
                              className="mobile-pool-stats"
                              data-launch-row="true"
                            >
                              <span>
                                Launched{" "}
                                <time
                                  data-pending={now === null}
                                  dateTime={new Date(
                                    p.launchedAt * 1000,
                                  ).toISOString()}
                                  title={utc(p.launchedAt)}
                                >
                                  {now === null
                                    ? "Pending"
                                    : `${since(p.launchedAt, now)} ago`}
                                </time>
                              </span>
                              <AddressChip
                                address={p.launchSender}
                                href={`/wallet/${p.launchSender.toLowerCase()}/`}
                              />
                            </div>
                          ) : (
                            <div className="mobile-pool-stats">
                              <span>
                                Vol <Eth wei={p.stats.volumeWei} />
                                {p.stats.trades !== null && (
                                  <>
                                    {" · "}
                                    {integers.format(p.stats.trades)} trades
                                  </>
                                )}
                              </span>
                            </div>
                          )}
                        </>
                      ) : skeleton ? (
                        <>
                          <div className="mobile-pool-top">
                            <span className="token-cell">
                              <span className="chain-token" data-pending="true">
                                Token
                              </span>
                              <span>
                                <strong data-pending="true">
                                  Pool pending
                                </strong>
                                <small data-pending="true">{"\u00a0"}</small>
                              </span>
                            </span>
                            <div className="mobile-pool-price">
                              <Price pending />
                              <Change pending />
                            </div>
                            {/* Reserves the star's box so the price box next
                                to it does not move once the real button
                                mounts. */}
                            <button
                              className="icon-button watch"
                              disabled
                              aria-hidden="true"
                              tabIndex={-1}
                            >
                              <Star size={16} />
                            </button>
                          </div>
                          <div className="mobile-pool-stats">
                            <span data-pending="true">{"\u00a0"}</span>
                          </div>
                        </>
                      ) : null}
                    </article>
                  );
                })}
              </div>
              {empty && (
                <EmptyState
                  title={
                    view === "watchlist" && !watched.length
                      ? shared
                        ? "This shared watchlist cannot be displayed"
                        : "Your watchlist starts here"
                      : shared
                        ? "No shared pools match these filters"
                        : "No pools match these filters"
                  }
                  description={
                    view === "watchlist" && !watched.length
                      ? shared
                        ? "Ask for a new link, or open your own watchlist."
                        : "Star pools on Explore to save them in this browser."
                      : shared
                        ? "Try clearing the filter, or open your own watchlist."
                        : "Try another token, or select All."
                  }
                />
              )}
            </div>
            <ShowMore
              shown={shown}
              total={list?.total ?? null}
              cap={CAP}
              loading={loading}
              onMore={showMore}
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
