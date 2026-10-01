"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowRight, RefreshCw, Search, Star } from "lucide-react";
import {
  poolHref,
  shortAddress,
  since,
  windows,
  type AnalyticsLeaderboardResponse,
  type AnalyticsExploreResponse,
  type AnalyticsExploreOptions,
  type AnalyticsPoolRow,
  type LiveWindow,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import {
  validateStatsResponse,
  type ScreenerStatsResponse,
} from "@/lib/stats-response";
import { useExploreRows } from "@/lib/use-explore-rows";
import { useReportCut } from "@/lib/freshness";
import { tokenLabel } from "@/lib/token-identity";
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
  UnavailableState,
  WatchButton,
} from "./ui";
import { PoolImage } from "./pool-image";
import { Eth, WindowTabs, useWindow, utc } from "./live-ui";
import {
  EXPLORE_ROWS_CAP,
  answeredRowCount,
  launchOnly,
  PoolCell,
  SHOW_MORE_STEP,
  ShowMore,
  useClockSeconds,
} from "./product-common";
import { countLabel } from "@/lib/plural";
import { useBelowListKey, useListRelease } from "@/lib/list-release";
import { LaunchLine, PoolChange, RowSubtitle } from "./pool-row";
/** The launches tab: the API sorts this view by launch time on its own. */
const LAUNCH_VIEW = "new";
/** How far under the sticky site header a panel's head lands. */
const HEAD_GAP = 12;
/**
 * Brings the panel's head to just under the sticky site header: once it has
 * scrolled away under or above the header, or, with `always`, from wherever
 * it is. The header is measured rather than read from `scroll-padding-top`,
 * a single figure for a header that is 95px tall on desktop and 151px on a
 * phone. The scroll follows the page's own `scroll-behavior`, which reduced
 * motion turns off.
 */
function headIntoView(panel: HTMLElement | null, always = false) {
  if (!panel) return;
  const header =
    document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
  const offset = panel.getBoundingClientRect().top - header - HEAD_GAP;
  if (always ? offset !== 0 : offset < -HEAD_GAP)
    window.scrollTo({ top: window.scrollY + offset });
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
/* Crowd lists the pools.xyz crowd (auction) launches, as the export's tab
   set places it: between New and Watchlist. */
type ScreenerView = NonNullable<AnalyticsExploreOptions["view"]>;
const SCREENER_VIEWS = [
  ["all", "All"],
  ["gainers", "Gainers"],
  ["new", "New"],
  ["crowd", "Crowd"],
  ["watchlist", "Watchlist"],
] as const satisfies readonly (readonly [ScreenerView, string])[];
const isScreenerView = (value: string): value is ScreenerView =>
  SCREENER_VIEWS.some(([key]) => key === value);
function ScreenerStats({
  initial,
  window,
}: {
  initial: ScreenerStatsResponse | null;
  window: LiveWindow;
}) {
  const [answer, setAnswer] = useState({
    window: initial?.window ?? window,
    data: initial,
  });
  const [failedWindow, setFailedWindow] = useState<LiveWindow | null>(null);
  const [attempt, setAttempt] = useState(0);
  /* The header's freshness stamp: the stats read names the ledger cut it
     summed through, block and all, so it is the screener's cut wherever the
     stats route is served; the last answer stays reported while the next
     window's is on its way, as its figures stay on screen. */
  useReportCut("stats", answer.data?.cutoff.block, answer.data?.asOf);
  useEffect(() => {
    const selected = new URLSearchParams(location.search).get("window");
    const browserWindow =
      selected && Object.hasOwn(windows, selected) ? selected : "24h";
    // The query store's server snapshot is empty during hydration. A saved
    // window URL must settle before deciding whether this is a new window.
    if (browserWindow !== window) return;
    // A route absent at first paint has no row or reserved gap. A subsequent
    // deployment becomes visible on reload, when the server can size it first.
    if (!initial || answer.window === window) return;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      try {
        const response = await fetch(`/api/product/stats/?window=${window}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw Error("Stats unavailable");
        const data: unknown = await response.json();
        validateStatsResponse(data, window);
        if (controller.signal.aborted) return;
        setAnswer({ window, data });
        setFailedWindow(null);
      } catch {
        if (!controller.signal.aborted) setFailedWindow(window);
      }
    });
    return () => controller.abort();
  }, [answer.window, attempt, initial, window]);
  if (!initial) return null;
  const pending = answer.window !== window;
  const failed = failedWindow === window;
  const data = answer.data;
  const labelWindow = answer.data?.window ?? initial.window;
  return (
    <section
      className="stats-grid screener-stats"
      aria-label="Screener stats"
      aria-busy={pending || failed}
    >
      <div className="stat">
        <span>Volume · {labelWindow}</span>
        <strong data-pending={pending}>
          {data?.volumeWei === null || !data ? (
            <span className="stats-empty" />
          ) : (
            <Eth wei={data.volumeWei} />
          )}
        </strong>
      </div>
      <div className="stat">
        <span>Launches · {labelWindow}</span>
        <strong data-pending={pending}>
          {data ? (
            data.poolsLaunched.toLocaleString("en-US")
          ) : (
            <span className="stats-empty" />
          )}
        </strong>
      </div>
      <div className="stat">
        <span>Traders · {labelWindow}</span>
        <strong data-pending={pending}>
          {data?.activeTraders === null || !data ? (
            <span className="stats-empty" />
          ) : (
            data.activeTraders.toLocaleString("en-US")
          )}
        </strong>
      </div>
      {failed && (
        <div className="screener-stats-error">
          <UnavailableState
            subject="Screener stats"
            onRetry={() => {
              setFailedWindow(null);
              setAttempt((current) => current + 1);
            }}
          />
        </div>
      )}
    </section>
  );
}
function TopTradersRail({ window }: { window: LiveWindow }) {
  const leaders = useProduct<AnalyticsLeaderboardResponse>(
    `leaderboard?limit=5&window=${window}&minTrades=10`,
  );
  const failed = !!leaders.error && !leaders.data;
  /* Stacked under the list on a phone, the rail moves up when the list
     releases rows it reserved; its section remounts there instead, keeping
     this read (lib/list-release.ts). */
  const releaseKey = useBelowListKey();
  return (
    <section className="panel explore-leaders" key={releaseKey}>
      <div className="panel-heading">
        <h2>Top traders · {window}</h2>
      </div>
      <div className="explore-leader-rows">
        {failed && <p className="rail-note">Top traders unavailable</p>}
        {!leaders.data &&
          !failed &&
          Array.from({ length: 5 }, (_, index) => (
            <div className="leader-link" key={index} aria-hidden="true">
              <span data-pending="true">Wallet pending</span>
              <span className="number" data-pending="true">
                PnL pending
              </span>
            </div>
          ))}
        {leaders.data?.items.map((trader) => (
          <Link
            className="leader-link"
            key={trader.address}
            href={`/wallet/${trader.address}/?window=${window}`}
          >
            <span>
              #{trader.rank} {shortAddress(trader.address)}
            </span>
            <Eth wei={trader.realizedWei} signed />
          </Link>
        ))}
        {!leaders.loading && !failed && !leaders.data?.items.length && (
          <p className="panel-footnote">No ranked traders in {window} yet.</p>
        )}
      </div>
      <Link className="leader-link" href={`/traders/?window=${window}`}>
        Full leaderboard ↗
      </Link>
    </section>
  );
}

export function ProductExplore({
  initialStats,
  initialSearch,
}: {
  initialStats: ScreenerStatsResponse | null;
  initialSearch: string;
}) {
  const now = useClockSeconds();
  const launches = useProduct<AnalyticsExploreResponse>(
    "explore?sort=launch&direction=desc&limit=6&window=24h",
  );
  const { params, set: setQuery } = useQuery(initialSearch),
    { ids, add } = useWatchlist(),
    { window, setWindow } = useWindow("24h");
  /* The board has no 1h or 6h ranks. Keep its data, label and links on 24h. */
  const railWindow = window === "1h" || window === "6h" ? "24h" : window;
  /* A bookmarked view no tab offers, or an order no header offers (direction
     included), reads as the default and leaves the URL at the next write. */
  const requestedView = params.get("view"),
    staleView = requestedView !== null && !isScreenerView(requestedView),
    view: ScreenerView =
      requestedView !== null && isScreenerView(requestedView)
        ? requestedView
        : params.has("watchlist")
          ? "watchlist"
          : "all",
    q = params.get("q") ?? "";
  const requested = params.get("sort"),
    staleSort = requested !== null && !SCREENER_SORTS.includes(requested),
    sort =
      (staleSort ? null : requested) ??
      (view === LAUNCH_VIEW || view === "crowd" ? "launch" : "volume"),
    direction = (staleSort ? null : params.get("dir")) ?? "desc";
  const cleaned = (updates: Record<string, string | null>) => ({
    ...(staleView ? { view: null } : null),
    ...(staleSort ? { sort: null, dir: null } : null),
    ...updates,
  });
  const write = (updates: Record<string, string | null>) =>
    setQuery(cleaned(updates));
  /* A new query reads from the top: the panel's head comes back under the
     site header while the rows swap to skeletons, and the rows on show go
     back to the first page. The query commits first, so a list that had
     released rows its last answer did not fill reserves the new page again
     and the page is long enough to bring the head up. */
  const panelRef = useRef<HTMLElement>(null);
  const set = (updates: Record<string, string | null>) => {
    flushSync(() => write({ ...updates, limit: null }));
    headIntoView(panelRef.current);
  };
  /* All launches is the New tab reached from the rail above the list. Changed
     in place, the list below the rail swapped its rows with nothing on
     screen saying so, so the click brings the list's head up under the site
     header with that tab pressed and the All tab beside it to undo it. It is
     a real link to the same URL state, so it also opens in a new tab, and
     focus moves to the tab it pressed. */
  const launchesView: Record<string, string | null> = {
    view: LAUNCH_VIEW,
    watchlist: null,
    sort: null,
  };
  const launchesHref = (() => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(
      cleaned({ ...launchesView, limit: null }),
    ))
      if (value) next.set(key, value);
      else next.delete(key);
    return `/?${next}`;
  })();
  const newTabRef = useRef<HTMLButtonElement>(null);
  const showLaunches = () => {
    flushSync(() => write({ ...launchesView, limit: null }));
    newTabRef.current?.focus({ preventScroll: true });
    headIntoView(panelRef.current, true);
  };
  /* The rows on show live in the URL as `limit`, as on the traders and
     creators lists: absent or invalid, the first page; each Show more adds
     the next page, and a reload or Back brings back what was on show. */
  const rawLimit = Number(params.get("limit")),
    shown =
      Number.isInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, EXPLORE_ROWS_CAP)
        : SHOW_MORE_STEP;
  const filter = useDebouncedInput(q, (next) => set({ q: next }));
  /* Each rail reads on its own, so each says for itself whether it was served. */
  const launchesFailed = !!launches.error && !launches.data;
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
        data-window-sort={key === "change"}
        onClick={() => sortBy(key)}
      >
        {activeSort === key && (
          <span className="sort-arrow" aria-hidden="true">
            {ascending ? "↑" : "↓"}
          </span>
        )}
        <span key={label}>{label}</span>
      </button>
    </th>
  );
  const query = new URLSearchParams({
    window,
    view,
    q,
    sort,
    direction,
  });
  const shared = view === "watchlist" ? parseSharedWatchlist(params) : null;
  const watched = shared?.ids ?? ids;
  /* The ids that drove the last fetch for this view, frozen against a bare
     star toggle: unstarring never changes this, so the query below stays
     the same and the row leaves through the client-side filter underneath
     instead of a refetch. A newly starred pool the fetch has never seen
     (`ids` growing past this set), or any other query change (the base
     string below), still updates it and reads through as a normal new
     fetch. Adjusted during render, as `useDebouncedInput` above corrects
     its own state when the URL moves on its own: the correction lands
     before this render commits, so nothing downstream ever reads a stale
     value. */
  const [fetchedWatch, setFetchedWatch] = useState({
    base: "",
    ids: [] as string[],
  });
  let queryWatchedIds = fetchedWatch.ids;
  if (view === "watchlist" && !shared) {
    const base = query.toString();
    const grew = ids.some((id) => !fetchedWatch.ids.includes(id));
    if (fetchedWatch.base !== base || grew) {
      queryWatchedIds = ids;
      setFetchedWatch({ base, ids });
    }
  }
  const queryWatched = shared?.ids ?? queryWatchedIds;
  if (view === "watchlist")
    query.set(
      "ids",
      queryWatched.slice(0, MAX_WATCHLIST_QUERY_POOLS).join(","),
    );
  /* A metric order excludes pools without that metric in the explore reader.
     Read the complete saved set in launch order, with the selected window's
     figures, then order only this bounded Watchlist set below. */
  const readQuery = new URLSearchParams(query);
  if (view === "watchlist") {
    readQuery.set("sort", "launch");
    readQuery.set("direction", "desc");
  }
  const { list, stale, loading, settled, error, refresh, asOf } =
    useExploreRows(
      readQuery.toString(),
      view === "watchlist"
        ? Math.max(1, Math.min(queryWatched.length, MAX_WATCHLIST_QUERY_POOLS))
        : shown,
    );
  /* The rows' own cut names no block; it feeds the stamp only where the
     stats read is not served (a fixture deployment). */
  useReportCut("explore", null, asOf);
  /* Wait for every saved row before sorting. Showing a partially fetched
     order would move already painted rows when the next chunk arrives. */
  const readyList =
    view === "watchlist" &&
    list &&
    list.rows.length < Math.min(queryWatched.length, list.total)
      ? undefined
      : list;
  /* Pools the fetch above still carries but this browser has since
     unstarred: hidden from every derived view below without asking the
     server again, since `queryWatchedIds` (and so `query`) did not move.
     Scoped to `list`, this query's own rows - a stale row below belongs to a
     query this filter was never computed against. */
  const removedFromWatch =
    view === "watchlist" && !shared
      ? queryWatchedIds.filter((id) => !ids.includes(id))
      : [];
  /* Every tab and sort here names a genuinely different server-side filter
     or order over the whole catalog (see `useExploreRows`), so a tab, sort,
     window or filter change always reads again rather than re-deriving from
     what is already on hand. While that read is pending, the previous
     query's rows (`stale`) keep the table's rendered rows and geometry in
     place instead of collapsing to a full-table skeleton; `isStale` is what
     dims them and marks the region busy without presenting them as this
     query's own answer. */
  const isStale = !readyList && !!stale;
  const displayList = readyList ?? stale;
  const orderedRows =
    view === "watchlist" && readyList
      ? [...readyList.rows].sort((a, b) => {
          const metric = (row: AnalyticsPoolRow): bigint | number | null => {
            if (sort === "launch") return row.launchBlock;
            if (sort === "change") return row.stats.change;
            if (sort === "trades") return row.stats.trades;
            const value = row.stats.volumeWei;
            return value === null ? null : BigInt(value);
          };
          const left = metric(a);
          const right = metric(b);
          if (left === null)
            return right === null ? a.id.localeCompare(b.id) : 1;
          if (right === null) return -1;
          return (
            (left > right ? 1 : left < right ? -1 : 0) *
              (direction === "asc" ? 1 : -1) || a.id.localeCompare(b.id)
          );
        })
      : readyList?.rows;
  const rows = readyList
    ? removedFromWatch.length
      ? orderedRows?.filter((row) => !removedFromWatch.includes(row.id))
      : orderedRows
    : displayList?.rows;
  const total = readyList
    ? removedFromWatch.length
      ? Math.max(0, readyList.total - removedFromWatch.length)
      : readyList.total
    : displayList?.total;
  const launchPage = !!rows?.length && rows.every(launchOnly);
  const empty = settled && total === 0;
  /* Nothing was served for this query, stale or otherwise. The reserved rows
     stay reserved and stay blank: a shimmer would read as "still loading"
     and another query's rows would read as this query's answer. */
  const failed = !!error && !readyList;
  /* The rows on show, reserved from the URL before any data so a read that
     lands never resizes the table. A view, sort, window or filter change
     keeps showing the previous query's rows, dimmed, instead of swapping to
     skeletons; a same-query refresh keeps showing the rows it already has,
     undimmed, while it quietly reloads them; a Show more adds its rows as
     skeletons under the ones on show, and a row past the list's end is left
     blank rather than shimmering for nothing. */
  const shownRows = Array.from(
    /* The page the URL names while this query's answer is pending (so a
       tab reached from above can still bring the list's head under the
       site header), then the rows that answer fills: its own total, not
       what is left of it after an unstar, so a removal leaves its slot
       until the next navigation. */
    { length: answeredRowCount(shown, readyList?.total ?? null) },
    (_, index) => rows?.[index],
  );
  useListRelease(shownRows.length, shown);
  const skeletonAt = (index: number) =>
    !failed && (!displayList || (loading && index < displayList.total));
  /* Show more keeps the reader where they are and lands them on the first
     new row once it arrives, rather than bringing the panel's head back. It
     asks for no more than the list holds, so the last page reserves the rows
     it will fill and none past the end. */
  const focusAt = useRef<number | null>(null);
  const showMore = () => {
    focusAt.current = shown;
    write({
      limit: String(
        Math.min(
          shown + SHOW_MORE_STEP,
          list?.total ?? Infinity,
          EXPLORE_ROWS_CAP,
        ),
      ),
    });
  };
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
    <div className="page explore-page" data-watchlist={view === "watchlist"}>
      <div className="page-heading">
        <h1>
          Pools<span className="title-dot">.</span>
        </h1>
        <Link href="/traders/" className="button leaderboard-cta">
          Trader leaderboard
          <ArrowRight aria-hidden="true" />
        </Link>
      </div>
      <ScreenerStats initial={initialStats} window={window} />
      <section className="launch-section" aria-label="Just launched">
        <div className="section-caption">
          <span>
            <i />
            Just launched
            <small className="launch-window-caption">Change · 24h</small>
          </span>
          <a
            className="section-link"
            href={launchesHref}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              showLaunches();
            }}
          >
            All launches
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
        <div className="launch-rail">
          {/* The rail's own height is fixed by `.launch-section`, so saying
              nothing arrived costs the page no movement. Six shimmering
              cards would go on claiming the launches are still coming. */}
          {launchesFailed && <p className="rail-note">Launches unavailable</p>}
          {!launchesFailed &&
            Array.from(
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
                      symbol={p.symbol}
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
                      {p
                        ? tokenLabel(p)
                        : launches.data
                          ? "\u00a0"
                          : "Pool pending"}
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
              <div className="table-tabs" role="group" aria-label="Pool views">
                {SCREENER_VIEWS.map(([key, label]) => (
                  <button
                    key={key}
                    ref={key === LAUNCH_VIEW ? newTabRef : undefined}
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
            {/* Rows already on show and a read that failed after them: the
                list keeps what it has and says the rest did not arrive. A
                first read that failed has no rows, and speaks for itself
                inside the table region below. */}
            {error && !failed && (
              <p className="panel-footnote" role="alert">
                {error}
              </p>
            )}
            {/* A filter that matches fewer rows than the page keeps only the
                rows it fills, and one that matches nothing keeps a short slot
                the empty state overlays, directly under the toolbar. A failed
                first read keeps every reserved row, blank, and the failed
                state overlays the top of them the same way. */}
            <div
              className="table-region"
              data-empty={empty || failed}
              data-failed={failed}
            >
              <div
                className="table-scroll desktop-pools"
                aria-busy={loading}
                data-stale-rows={isStale}
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
                    <col className="col-sender" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        <span className="sr-only">Watchlist</span>
                      </th>
                      {view === "crowd" ? (
                        sortable("Newest", "launch")
                      ) : (
                        <th>Token</th>
                      )}
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
                                subtitle={
                                  <RowSubtitle
                                    key={`${window}:${p.stats.trades}`}
                                    pool={p}
                                    now={now}
                                  />
                                }
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
                                  p ? (
                                    <PoolChange
                                      key={`${window}:${p.stats.change}`}
                                      pool={p}
                                      window={window}
                                      now={now}
                                    />
                                  ) : (
                                    <Change pending />
                                  )
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
              <div
                className="mobile-pools"
                aria-busy={loading}
                data-stale-rows={isStale}
              >
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
                                <RowSubtitle
                                  key={window}
                                  pool={p}
                                  now={now}
                                  trades={false}
                                />
                              }
                            />
                            {!launchOnly(p) && (
                              <div className="mobile-pool-price">
                                <Price wei={p.stats.priceWei} />
                                <PoolChange
                                  key={`${window}:${p.stats.change}`}
                                  pool={p}
                                  window={window}
                                  now={now}
                                />
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
                              <span
                                key={`${window}:${p.stats.volumeWei}:${p.stats.trades}`}
                              >
                                Vol <Eth wei={p.stats.volumeWei} />
                                {p.stats.trades !== null && (
                                  <>
                                    {" · "}
                                    {countLabel(p.stats.trades, "trade")}
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
              {failed && <UnavailableState subject="Pools" onRetry={refresh} />}
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
              total={failed ? 0 : (total ?? null)}
              cap={EXPLORE_ROWS_CAP}
              loading={loading}
              onMore={showMore}
            />
          </section>
        </div>
        <aside className="market-sidebar explore-sidebar">
          <TopTradersRail key={railWindow} window={railWindow} />
        </aside>
      </div>
    </div>
  );
}
