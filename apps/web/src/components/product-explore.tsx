"use client";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  observeWindowOffset,
  useWindowVirtualizer,
} from "@tanstack/react-virtual";
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
import { PAGE_SIZE, useExplorePages } from "@/lib/use-explore-pages";
import { rememberPoolRow } from "@/lib/pool-row-memory";
import {
  MAX_WATCHLIST_QUERY_POOLS,
  parseSharedWatchlist,
} from "@/lib/watchlist";
import { useDebouncedInput, useQuery, useWatchlist } from "./state";
import { WatchlistControls } from "./watchlist-controls";
import {
  AddressChip,
  Change,
  EmptyState,
  Price,
  Sparkline,
  WatchButton,
} from "./ui";
import { PoolImage } from "./pool-image";
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
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
/** The rows the page reserves before any data: the screener's first page. */
const RESERVED_ROWS = PAGE_SIZE;
const ROW_HEIGHT = 62;
const CARD_HEIGHT = 168;
/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 10;
/** Rows past the viewport whose page is read before they scroll into it. */
const PREFETCH_ROWS = 10;
/** The viewport the server assumes: tall enough to paint every reserved row. */
const SERVER_VIEWPORT = 1000;
const SCROLL_SNAPSHOT_KEY = "poolsinfo.explore.scroll.v1";
/** The list the container query shows, and where its rows begin in the document. */
function shownList(table: Element | null, cards: Element | null) {
  for (const [node, rowHeight] of [
    [table, ROW_HEIGHT],
    [cards, CARD_HEIGHT],
  ] as const) {
    const rect = node?.getBoundingClientRect();
    if (rect && rect.width > 0)
      return { top: rect.top + window.scrollY, rowHeight };
  }
  return null;
}
/** Brings the panel's head back under the site header when it has scrolled away. */
function headIntoView(panel: HTMLElement | null) {
  const padding =
    parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) ||
    0;
  if (panel && panel.getBoundingClientRect().top < padding)
    panel.scrollIntoView({ block: "start" });
}
/** The rows in the viewport of a shown list, with the rows read ahead on either side. */
function viewportSpan({ top, rowHeight }: { top: number; rowHeight: number }) {
  const scrolled = window.scrollY - top;
  return {
    start: Math.floor(scrolled / rowHeight) - PREFETCH_ROWS,
    end:
      Math.floor((scrolled + window.innerHeight) / rowHeight) + PREFETCH_ROWS,
  };
}
/**
 * One layout's rows, windowed against the document scroll: only the rows near
 * the viewport render, between two spacers that hold the list's full extent.
 * The offset it follows is measured from the list's own top, so nothing above
 * the list in the document enters the arithmetic, and a layout the container
 * query hides never hears the scroll: it keeps the reserved first page it
 * painted for the server. The server and the hydrating client both take the
 * list as unscrolled, which paints every reserved row.
 */
function useRowWindow(
  ref: RefObject<Element | null>,
  count: number,
  rowHeight: number,
) {
  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    initialRect: { width: 0, height: SERVER_VIEWPORT },
    initialOffset: 0,
    observeElementOffset: (instance, report) => {
      const follow = (isScrolling: boolean) => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect && rect.width > 0) report(-rect.top, isScrolling);
      };
      const unobserve = observeWindowOffset(instance, (_, isScrolling) =>
        follow(isScrolling),
      );
      const resized = () => follow(false);
      window.addEventListener("resize", resized);
      return () => {
        unobserve?.();
        window.removeEventListener("resize", resized);
      };
    },
    /* The page owns its scrolling: the virtualizer only reads the offset, so
       its own scroll writes, such as the one it makes on mount, are inert. */
    scrollToFn: () => {},
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0],
    last = items[items.length - 1];
  return {
    rows: items.map((item) => item.index),
    leading: first?.start ?? 0,
    trailing: last ? virtualizer.getTotalSize() - last.end : 0,
  };
}
/** Where the screener was left, in rows below the list's top, for this tab only. */
type ScrollSnapshot = { query: string; total: number; rows: number };
const subscribeSnapshot = (notify: () => void) => {
  window.addEventListener("storage", notify);
  return () => window.removeEventListener("storage", notify);
};
function readSnapshot() {
  try {
    return sessionStorage.getItem(SCROLL_SNAPSHOT_KEY);
  } catch {
    return null;
  }
}
const noSnapshot = () => null;
function parseSnapshot(saved: string | null): ScrollSnapshot | null {
  try {
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}
function writeSnapshot(snapshot: ScrollSnapshot) {
  try {
    sessionStorage.setItem(SCROLL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* Storage may be unavailable in private browsers. */
  }
}
/**
 * Back within the session lands where the list was left. The position is
 * written on leaving, in rows below the list's top so either layout can read
 * it, and read back on mount; the saved total sizes the list before its rows
 * arrive, so the position holds from the first paint and the page it lands on
 * is the first one read. Nothing is written while the page is shown, so the
 * snapshot never feeds back into the list it sized.
 */
function useScrollMemory(
  query: string,
  total: number | undefined,
  table: RefObject<Element | null>,
  cards: RefObject<Element | null>,
) {
  const saved = useSyncExternalStore(
    subscribeSnapshot,
    readSnapshot,
    noSnapshot,
  );
  const snapshot = useMemo(() => parseSnapshot(saved), [saved]);
  const restore = snapshot?.query === query ? snapshot : null;
  const applied = useRef(false);
  useLayoutEffect(() => {
    if (!restore || applied.current) return;
    const list = shownList(table.current, cards.current);
    if (!list) return;
    applied.current = true;
    window.scrollTo({
      top: list.top + restore.rows * list.rowHeight,
      behavior: "instant",
    });
  }, [restore, table, cards]);
  const reserved = total ?? restore?.total ?? 0;
  const latest = useRef({ query, total: reserved });
  useLayoutEffect(() => {
    latest.current = { query, total: reserved };
  });
  useLayoutEffect(() => {
    const save = () => {
      const list = shownList(table.current, cards.current);
      if (list)
        writeSnapshot({
          ...latest.current,
          rows: (window.scrollY - list.top) / list.rowHeight,
        });
    };
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [table, cards]);
  return reserved;
}
function PoolCell({ pool }: { pool: AnalyticsPoolRow }) {
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
          {launchOnly(pool)
            ? pool.symbol
            : `${pool.symbol} · ${new Date(
                pool.launchedAt * 1000,
              ).toLocaleDateString("en-US", { timeZone: "UTC" })}`}
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
type ExploreSort = NonNullable<AnalyticsExploreOptions["sort"]>;
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
  /* A new query reads from the top: the panel's head comes back under the
     site header while the previous rows dim. */
  const panelRef = useRef<HTMLElement>(null);
  const set = (updates: Record<string, string | null>) => {
    setQuery(updates);
    headIntoView(panelRef.current);
  };
  const view = (params.get("view") ??
      (params.has("watchlist")
        ? "watchlist"
        : "all")) as AnalyticsExploreOptions["view"],
    q = params.get("q") ?? "";
  const sort =
      params.get("sort") ?? (view === LAUNCH_VIEW ? "launch" : "volume"),
    direction = params.get("dir") ?? "desc";
  const filter = useDebouncedInput(q, (next) => set({ q: next }));
  /* Pages no longer live in the URL; a link that still names one reads from the top. */
  const legacyOffset = params.has("offset");
  useEffect(() => {
    if (legacyOffset) setQuery({ offset: null });
  }, [legacyOffset, setQuery]);
  /* Both read paths pin the launches view to launch order, so no header
     claims it there. */
  const activeSort = view === LAUNCH_VIEW ? "launch" : sort,
    ascending = direction === "asc";
  const sortBy = (key: ExploreSort) => {
    if (activeSort !== key)
      set({
        sort: key,
        dir: "desc",
        ...(view === LAUNCH_VIEW ? { view: "all" } : null),
      });
    else if (!ascending) set({ sort: key, dir: "asc" });
    else set({ sort: null, dir: null });
  };
  /* Three states per column: descending, ascending, then back to the default. */
  const sortable = (label: string, key: ExploreSort) => (
    <th
      aria-sort={
        activeSort === key ? (ascending ? "ascending" : "descending") : "none"
      }
    >
      <button
        className={activeSort === key ? "sort-active" : ""}
        onClick={() => sortBy(key)}
      >
        {label}
        {activeSort === key && (
          <span className="sort-arrow" aria-hidden="true">
            {ascending ? "↑" : "↓"}
          </span>
        )}
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
  const listQuery = query.toString();
  const pages = useExplorePages(listQuery);
  const { list: data, loading, stale, error, refresh } = pages;
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const total = useScrollMemory(
    listQuery,
    data?.head.total,
    tableRef,
    cardsRef,
  );
  const count = Math.max(RESERVED_ROWS, total);
  const table = useRowWindow(tableRef, count, ROW_HEIGHT);
  const cards = useRowWindow(cardsRef, count, CARD_HEIGHT);
  /* After every paint, the rows on screen decide which page reads next. */
  useEffect(() => {
    const list = shownList(tableRef.current, cardsRef.current);
    pages.reach(list && viewportSpan(list));
  });
  const launchPage =
    !!data?.head.items.length && data.head.items.every(launchOnly);
  const empty = pages.settled && data?.head.total === 0;
  const tableRows = table.rows.map((index) => ({
    index,
    pool: pages.row(index),
  }));
  const cardRows = cards.rows.map((index) => ({
    index,
    pool: pages.row(index),
  }));
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
                    headIntoView(panelRef.current);
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
            {stale && (
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
              <div
                className="table-scroll desktop-pools"
                aria-busy={stale}
                data-stale-rows={stale}
              >
                <table className="data-table pool-table">
                  {/* Column widths live here so a row that spans the metric
                      columns cannot move the ones before it. */}
                  <colgroup>
                    <col className="col-watch" />
                    <col className="col-token" />
                    <col className="col-price" />
                    <col className="col-change" />
                    <col className="col-volume" />
                    <col className="col-trades" />
                    <col className="col-liquidity" />
                    <col className="col-holders" />
                    <col className="col-sender" />
                    <col className="col-trend" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th aria-label="Watchlist" />
                      <th>Token</th>
                      {launchPage ? (
                        <th colSpan={8}>Launch</th>
                      ) : (
                        <>
                          <th>Price</th>
                          {sortable("Change", "change")}
                          {sortable("Volume", "volume")}
                          {sortable("Trades", "trades")}
                          {sortable("Liquidity", "liquidity")}
                          <th>Holders</th>
                          <th>Launch sender</th>
                          <th>Trend</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody ref={tableRef}>
                    {table.leading > 0 && (
                      <tr className="spacer" aria-hidden="true">
                        <td colSpan={10} style={{ height: table.leading }} />
                      </tr>
                    )}
                    {tableRows.map(({ index, pool: p }) => (
                      <tr
                        key={index}
                        data-index={index}
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
                            <PoolCell pool={p} />
                          ) : data ? (
                            "\u00a0"
                          ) : (
                            "Pending"
                          )}
                        </td>
                        {p && launchOnly(p) ? (
                          <td className="launch-cell" colSpan={8}>
                            <LaunchLine pool={p} now={now} />
                          </td>
                        ) : (
                          <>
                            <td data-pending={!p && !data}>
                              {p || !data ? (
                                <Price
                                  wei={p?.stats.priceWei}
                                  pending={!data}
                                />
                              ) : (
                                "\u00a0"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              {p || !data ? (
                                <Change
                                  value={p?.stats.change}
                                  pending={!data}
                                />
                              ) : (
                                "\u00a0"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              {p || !data ? (
                                <Eth pending={!data} wei={p?.stats.volumeWei} />
                              ) : (
                                "\u00a0"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              {p ? (
                                <>{p.stats.trades ?? <Unavailable />}</>
                              ) : data ? (
                                "\u00a0"
                              ) : (
                                "Pending"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              {p || !data ? (
                                <Eth
                                  pending={!data}
                                  wei={p?.stats.liquidityWei}
                                />
                              ) : (
                                "\u00a0"
                              )}
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
                                <AddressChip
                                  address={p.launchSender}
                                  href={`/wallet/${p.launchSender.toLowerCase()}/`}
                                  stacked
                                />
                              ) : data ? (
                                "\u00a0"
                              ) : (
                                "Pending"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              {p ? (
                                <>
                                  {p.marketCoverage?.source !==
                                    "canonical_broad" &&
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
                          </>
                        )}
                      </tr>
                    ))}
                    {table.trailing > 0 && (
                      <tr className="spacer" aria-hidden="true">
                        <td colSpan={10} style={{ height: table.trailing }} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div
                className="mobile-pools"
                ref={cardsRef}
                aria-busy={stale}
                data-stale-rows={stale}
              >
                {cards.leading > 0 && (
                  <div
                    className="spacer"
                    aria-hidden="true"
                    style={{ height: cards.leading }}
                  />
                )}
                {cardRows.map(({ index, pool: p }) => (
                  <article
                    className="mobile-pool"
                    key={index}
                    data-index={index}
                    data-row={p ? "resolved" : "reserved"}
                  >
                    {p ? (
                      <>
                        <div className="mobile-pool-top">
                          <PoolCell pool={p} />
                          <WatchButton id={p.id} />
                        </div>
                        {launchOnly(p) ? (
                          /* The card holds a fixed height, so the launch
                             facts take the stat slots rather than leaving
                             most of it empty. */
                          <div
                            className="mobile-pool-stats"
                            data-launch-row="true"
                          >
                            <span>
                              Launched
                              <strong>
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
                              </strong>
                            </span>
                            <span>
                              Sender
                              <strong>
                                <AddressChip
                                  address={p.launchSender}
                                  href={`/wallet/${p.launchSender.toLowerCase()}/`}
                                />
                              </strong>
                            </span>
                          </div>
                        ) : (
                          <div className="mobile-pool-stats">
                            <span>
                              Price
                              <strong>
                                <Price wei={p.stats.priceWei} />
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
                              <strong>
                                {p.stats.trades ?? <Unavailable />}
                              </strong>
                            </span>
                            <span>
                              Change
                              <strong>
                                <Change value={p.stats.change} />
                              </strong>
                            </span>
                          </div>
                        )}
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
                {cards.trailing > 0 && (
                  <div
                    className="spacer"
                    aria-hidden="true"
                    style={{ height: cards.trailing }}
                  />
                )}
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
