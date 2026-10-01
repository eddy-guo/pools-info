"use client";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalyticsExploreResponse,
  AnalyticsPoolRow,
  CreatorRow,
  CreatorsResponse,
} from "@pools/core";
import { DATA_UNAVAILABLE, fetchProduct, useProduct } from "@/lib/use-product";
import { useReportCut } from "@/lib/freshness";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress, since } from "@pools/core";
import { Eth, Stat, Unavailable, useWindow, utc, WindowTabs } from "./live-ui";
import { useQuery } from "./state";
import {
  AddressChip,
  AddressLabel,
  Avatar,
  Change,
  EmptyState,
  Price,
  UnavailableState,
} from "./ui";
import { useListRelease } from "@/lib/list-release";
import {
  EXPLORE_ROWS_CAP,
  answeredRowCount,
  PoolCell,
  SHOW_MORE_STEP,
  ShowMore,
  useClockSeconds,
} from "./product-common";
import { useExploreRows } from "@/lib/use-explore-rows";
import { tokenSubSymbol } from "@/lib/token-identity";
import { plural } from "@/lib/plural";

/** Mapped onto the read API's own sort keys. */
const CREATOR_SORTS = [
  ["launches", "Launches"],
  ["volume", "Volume"],
  ["median", "Median"],
] as const;
type CreatorSort = (typeof CREATOR_SORTS)[number][0];

/** The leaderboard never requests past its top 100, whatever the API allows. */
const CAP = 100;

/** The export's still-trading cell: a 132x5 fill under the fraction and
    percentage it represents, whose denominator the export defines as the
    creator's launch count. The read's `traded` counts measured launches
    only, so the cell is shown when every launch is measured and the fraction
    is the one the row's launch count names; a creator with launches the read
    has no figure for gets an empty cell, since "8 of 8" beside 414 launches
    reads as a survival rate the figures do not support. Left-aligned text
    never moves its start when the digits change, so this needs no
    shift-avoidance keying. */
function StillTrading({ r }: { r: CreatorRow }) {
  if (!r.measured) return <Unavailable />;
  if (r.measured < r.launches) return <Unavailable />;
  const pct = Math.round((r.traded / r.measured) * 100);
  return (
    <span className="still-trading">
      <span className="still-trading-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="still-trading-label">
        {r.traded} of {r.measured} · {pct}%
      </span>
    </span>
  );
}

/** The board's row where its table cannot fit: the screener's phone row shape,
    identity with the headline launch count at the right, then one secondary
    line. Median and Best stay out, as the table drops them first. */
function MobileCreatorRow({
  r,
  index,
  pending,
}: {
  r: CreatorRow | undefined;
  index: number;
  pending: boolean;
}) {
  return (
    <div
      className="mobile-creator"
      data-row-index={index}
      data-row={r ? "resolved" : "reserved"}
      aria-hidden={!r}
    >
      {/* Keyed so the resolved row mounts new nodes rather than rewriting the
          pending row's right-aligned text in place, which Chrome scores as a
          layout shift. */}
      {r ? (
        <Fragment key="resolved">
          <div className="mobile-creator-top">
            <span className="rank-number">{index + 1}</span>
            <AddressChip
              address={r.address}
              href={`/creators/${r.address}/`}
              badge={
                r.boughtOwnLaunch === true ? (
                  <span className="badge bought-own">BOUGHT OWN</span>
                ) : undefined
              }
            />
            <span className="mobile-creator-launches">
              <strong>{r.launches}</strong>
              <span>{plural(r.launches, "launch", "launches")}</span>
            </span>
          </div>
          <div className="mobile-creator-stats">
            <span>
              {r.volumeWei !== null && (
                <>
                  Vol <Eth wei={r.volumeWei} />
                </>
              )}
            </span>
            <StillTrading r={r} />
          </div>
        </Fragment>
      ) : pending ? (
        <Fragment key="pending">
          <div className="mobile-creator-top">
            <span className="rank-number" data-pending="true">
              Rank
            </span>
            <span className="mobile-creator-identity" data-pending="true">
              Creator pending
            </span>
            <span className="mobile-creator-launches">
              <strong data-pending="true">Pending</strong>
            </span>
          </div>
          <div className="mobile-creator-stats">
            <span data-pending="true">{"\u00a0"}</span>
          </div>
        </Fragment>
      ) : null}
    </div>
  );
}

export function Creators({ address }: { address?: string }) {
  return address ? (
    <CreatorProfile key={address} address={address} />
  ) : (
    <CreatorDirectory />
  );
}

type CreatorsState = {
  key: string;
  attempt: number;
  items: CreatorRow[];
  total: number;
  loadedShown: number;
  loading: boolean;
  settled: boolean;
  /** The chain timestamp the rows on hand were measured through
      (`coverage.asOf`), the page's freshness cut; the read names no block. */
  asOf: number | null;
  error?: string;
};

/**
 * Grows a creators leaderboard window/sort pair page by page: a window or
 * sort change (a new `key`) replaces the list from scratch, while a growing
 * `shown` target on the same key fetches only the rows not already held and
 * appends them, so an already-loaded row is never requested twice. The
 * returned `refresh` reruns the same key from its top, for the failed
 * state's retry control.
 */
function useCreatorsBoard(
  key: string,
  window: string,
  sort: string,
  shown: number,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CreatorsState>({
    key: "",
    attempt: 0,
    items: [],
    total: 0,
    loadedShown: 0,
    loading: true,
    settled: false,
    asOf: null,
  });
  useEffect(() => {
    const isReset = state.key !== key || state.attempt !== attempt;
    if (!isReset && shown <= state.loadedShown) return;
    const baseItems = isReset ? [] : state.items;
    const baseLoaded = isReset ? 0 : state.loadedShown;
    const fetchLimit = shown - baseLoaded;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const query = new URLSearchParams({
      window,
      sort,
      offset: String(baseLoaded),
      limit: String(fetchLimit),
    });
    void (async () => {
      try {
        const data = await fetchProduct<CreatorsResponse>(
          `creators?${query}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setState({
          key,
          attempt,
          items: [...baseItems, ...data.items],
          total: data.total,
          loadedShown: baseLoaded + data.items.length,
          loading: false,
          settled: true,
          /* A Show more's page can be read through a later cut than the
             rows above it; the stamp keeps the oldest, never claiming the
             top of the board is fresher than it is. */
          asOf:
            isReset || state.asOf === null
              ? data.coverage.asOf
              : Math.min(state.asOf, data.coverage.asOf),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          key,
          attempt,
          loading: false,
          error: error instanceof Error ? error.message : DATA_UNAVAILABLE,
        }));
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, window, sort, shown, attempt]);
  return { ...state, refresh: () => setAttempt((n) => n + 1) };
}

function CreatorDirectory() {
  const { params, set } = useQuery();
  const { window, setWindow } = useWindow("All");
  const rawSort = params.get("sort");
  const sort: CreatorSort = CREATOR_SORTS.some(([key]) => key === rawSort)
    ? (rawSort as CreatorSort)
    : "launches";
  const rawShown = Number(params.get("limit"));
  const shown =
    Number.isInteger(rawShown) && rawShown > 0 && rawShown <= CAP
      ? rawShown
      : 25;
  const key = `${window}:${sort}`;
  const state = useCreatorsBoard(key, window, sort, shown);
  const forKey = state.key === key;
  const settled = forKey && state.settled;
  const items = forKey ? state.items.slice(0, shown) : [];
  // Read off the capped total, not the read API's uncapped one: this stays a
  // top-100 leaderboard even before the data side caps the read itself.
  const total = settled ? Math.min(state.total, CAP) : null;
  const knownAbsent = (index: number) => settled && index >= state.total;
  /* No board was served: the reserved rows stay reserved and blank rather
     than shimmering on for ever, and the panel says what happened over the
     top of them, so nothing under the board moves. */
  const failed = forKey && !!state.error && items.length === 0;
  const rowCount = answeredRowCount(
    shown,
    settled ? Math.min(state.total, CAP) : null,
  );
  useListRelease(rowCount, shown);
  const empty = settled && total === 0;
  /* The header's freshness stamp: the board's own cut; nothing once it
     failed with no rows to show. */
  useReportCut("creators", null, failed ? null : state.asOf);

  const focusFromRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const handleMore = useCallback(() => {
    focusFromRef.current = shown;
    const ceiling = total === null ? CAP : Math.min(CAP, total);
    set({ limit: String(Math.min(shown + SHOW_MORE_STEP, ceiling)) });
  }, [shown, set, total]);
  useEffect(() => {
    const index = focusFromRef.current;
    if (index === null || state.loading) return;
    if (state.items.length <= index) return;
    focusFromRef.current = null;
    const container = panelRef.current;
    if (!container) return;
    // The table and the rows both carry the index; only one of them is shown.
    const row = [
      ...container.querySelectorAll<HTMLElement>(`[data-row-index="${index}"]`),
    ].find((node) => node.offsetParent !== null);
    const target = row?.querySelector<HTMLElement>(".address-chip-link") ?? row;
    target?.focus();
  }, [state.items.length, state.loading]);

  return (
    <div className="page creators-page">
      <div className="page-heading">
        <div>
          <h1>
            Creators<span className="title-dot">.</span>
          </h1>
          <p>Who launches pools, how often, and how their launches trade.</p>
        </div>
        <div className="traders-controls">
          <div className="segmented" role="group" aria-label="Sort creators">
            {CREATOR_SORTS.map(([key, label]) => (
              <button
                key={key}
                aria-pressed={sort === key}
                onClick={() =>
                  set({ sort: key === "launches" ? null : key, limit: null })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <WindowTabs
            value={window}
            onChange={(value) => {
              setWindow(value);
              set({ limit: null });
            }}
          />
        </div>
      </div>
      <section className="panel creators-panel" ref={panelRef}>
        {state.loading && items.length > 0 && (
          <span className="sr-only" role="status">
            Updating saved creators
          </span>
        )}
        {state.error && !failed && (
          <p role="alert" className="panel-footnote">
            {state.error}
          </p>
        )}
        {/* A failed or empty answer's message overlays the top of the rows
            the board still reserves, right under the heading. */}
        <div
          className="table-region"
          data-empty={empty || failed}
          data-released={rowCount < shown}
        >
          <div className="table-scroll desktop-creators">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Creator</th>
                  <th>Launches</th>
                  <th>{window === "All" ? "Traded" : "Traded in window"}</th>
                  <th>Volume</th>
                  <th>Median</th>
                  <th>Best</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(
                  { length: rowCount },
                  (_, index) => items[index],
                ).map((r, index) => {
                  const absent = knownAbsent(index);
                  const pending = !r && !absent && !failed;
                  return (
                    <tr
                      key={index}
                      data-row-index={index}
                      aria-hidden={!r}
                      data-row={r ? "resolved" : "reserved"}
                    >
                      <td className="rank-number" data-pending={pending}>
                        {r ? index + 1 : pending ? "Pending" : "\u00a0"}
                      </td>
                      <td data-pending={pending}>
                        {r ? (
                          <AddressChip
                            address={r.address}
                            href={`/creators/${r.address}/`}
                            size="large"
                            badge={
                              r.boughtOwnLaunch === true ? (
                                <span className="badge bought-own">
                                  BOUGHT OWN
                                </span>
                              ) : undefined
                            }
                          />
                        ) : pending ? (
                          "Creator pending"
                        ) : (
                          "\u00a0"
                        )}
                      </td>
                      <td data-pending={pending}>
                        {r ? (
                          // Keyed so a new count replaces its text node: rewriting
                          // right-aligned text in place moves its start, which
                          // Chrome scores as a layout shift.
                          <Fragment key={r.launches}>{r.launches}</Fragment>
                        ) : pending ? (
                          "Pending"
                        ) : (
                          "\u00a0"
                        )}
                      </td>
                      <td data-pending={pending}>
                        {r ? (
                          <StillTrading r={r} />
                        ) : pending ? (
                          "Pending"
                        ) : (
                          "\u00a0"
                        )}
                      </td>
                      <td data-pending={pending}>
                        <Eth wei={r?.volumeWei} pending={pending} />
                      </td>
                      <td data-pending={pending}>
                        <Eth wei={r?.medianVolumeWei} pending={pending} />
                      </td>
                      <td data-pending={pending}>
                        {r ? (
                          r.bestLaunch ? (
                            <Link
                              className="mono"
                              href={poolHref(r.bestLaunch)}
                            >
                              {r.bestLaunch.symbol}
                            </Link>
                          ) : (
                            <Unavailable />
                          )
                        ) : pending ? (
                          "Pending"
                        ) : (
                          "\u00a0"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mobile-creators">
            {Array.from({ length: rowCount }, (_, index) => items[index]).map(
              (r, index) => (
                <MobileCreatorRow
                  key={index}
                  r={r}
                  index={index}
                  pending={!r && !knownAbsent(index) && !failed}
                />
              ),
            )}
          </div>
          {failed && (
            <UnavailableState subject="Creators" onRetry={state.refresh} />
          )}
          {empty && (
            <div className="empty-state">
              <h2>No creators in this window</h2>
              <p>Switch the window or sort to find launches to group.</p>
            </div>
          )}
        </div>
        <ShowMore
          shown={shown}
          total={failed ? 0 : total}
          cap={CAP}
          loading={state.loading}
          onMore={handleMore}
        />
      </section>
    </div>
  );
}

/**
 * A measured launch's trading state over the last 24 hours, as the export
 * names it: Active with an observed swap, Dormant without one. A launch the
 * read has no market figure for shows no state at all, as its figure cells
 * are empty. The state is an element rather than a bare string, so it mounts
 * as a new node over the pending text rather than rewriting right-aligned
 * text in place, which Chrome scores as a shift.
 */
function LaunchStatus({ pool }: { pool: AnalyticsPoolRow }) {
  return pool.stats.trades === null ? (
    <Unavailable />
  ) : pool.stats.trades > 0 ? (
    <span className="positive">Active</span>
  ) : (
    <span className="muted">Dormant</span>
  );
}

/** Where the launch came from, when the read names it. */
function launchMode(pool: AnalyticsPoolRow) {
  return pool.launchType === "crowd"
    ? "Crowd"
    : pool.launchType === "instant"
      ? "Instant"
      : null;
}

/** The token tile's subtitle: the symbol in mono and the launch's age, the
    exact launch time on hover. The age paints once the client knows the
    time; until then the line holds its height. */
function LaunchAge({
  pool,
  now,
}: {
  pool: AnalyticsPoolRow;
  now: number | null;
}) {
  const symbol = tokenSubSymbol(pool);
  return (
    <>
      {symbol && <span className="mono">{symbol}</span>}
      {now !== null && (
        <span title={utc(pool.launchedAt)}>
          {symbol && " · "}
          {since(pool.launchedAt, now)} old
        </span>
      )}
      {!symbol && now === null && " "}
    </>
  );
}

/** A launch time as a stat tile shows it: the age, with its UTC date as the
    note and the exact time on hover. */
function LaunchTime({
  at,
  now,
}: {
  at: number | null | undefined;
  now: number | null;
}) {
  if (at === undefined || now === null) return null;
  if (at === null) return <Unavailable />;
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={utc(at)}>
      {since(at, now)} ago
    </time>
  );
}
const launchDate = (at: number | null | undefined) =>
  at ? new Date(at * 1000).toISOString().slice(0, 10) : " ";

/**
 * A creator's own page, as the export sets it: a breadcrumb, the identity,
 * the stat tiles and the launches. The tiles carry only figures the reads
 * serve: the launch count, and the first and latest launch times from the
 * launch order's two ends. The export's other tiles (still trading, volume
 * created, median, creator fee, bought own) have no per-creator read, so
 * they are left out rather than shown empty or estimated.
 *
 * The launches come in launch order through the screener's own hook: the
 * rows the URL's `limit` names are reserved at first paint (25 by default,
 * grown by the shared Show more control up to the explore ceiling), so a
 * read that lands never resizes the panel and the footer under it never
 * moves. Rows are keyed by position, so a pending row becomes the real one
 * in place rather than remounting under a shift-scoring swap.
 */
function CreatorProfile({ address }: { address: string }) {
  const { params, set } = useQuery();
  const now = useClockSeconds();
  const rawShown = Number(params.get("limit"));
  const shown =
    Number.isInteger(rawShown) && rawShown > 0
      ? Math.min(rawShown, EXPLORE_ROWS_CAP)
      : SHOW_MORE_STEP;
  const { list, loading, settled, error, refresh, asOf } = useExploreRows(
    `window=24h&sort=launch&q=${address}`,
    shown,
  );
  /* The header's freshness stamp: the launch list's own cut. */
  useReportCut("creator-launches", null, asOf);
  /* The launch order's other end: the creator's first launch. */
  const first = useProduct<AnalyticsExploreResponse>(
    `explore?window=24h&sort=launch&direction=asc&q=${address}&limit=1`,
  );
  /* Nothing was served: the reserved rows stay reserved and blank rather
     than shimmering on for ever, and the panel says what happened over the
     top of them. */
  const failed = !!error && !list;
  const total = list ? list.total : null;
  /* An answer shorter than a page keeps only the rows it fills. */
  const rows = Array.from(
    { length: answeredRowCount(shown, total) },
    (_, index) => list?.rows[index],
  );
  useListRelease(rows.length, shown);
  const skeletonAt = (index: number) =>
    !failed && (!list || (loading && index < list.total));
  const empty = settled && total === 0;
  /* Each end of the launch order: undefined while its read is out, null
     once it is known there is no launch. */
  const latestAt = list ? (list.rows[0]?.launchedAt ?? null) : undefined;
  const firstAt = first.data
    ? (first.data.items[0]?.launchedAt ?? null)
    : undefined;
  const firstFailed = !first.data && !!first.error;

  const focusAt = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const showMore = useCallback(() => {
    focusAt.current = shown;
    set({
      limit: String(
        Math.min(shown + SHOW_MORE_STEP, total ?? Infinity, EXPLORE_ROWS_CAP),
      ),
    });
  }, [shown, set, total]);
  const held = list?.rows;
  useEffect(() => {
    const index = focusAt.current;
    if (index === null || !held || held.length <= index) return;
    focusAt.current = null;
    const links = panelRef.current?.querySelectorAll<HTMLElement>(
      `[data-row-index="${index}"] a`,
    );
    /* Both layouts hold the row; the one the container query shows has a box. */
    [...(links ?? [])].find((link) => link.getClientRects().length)?.focus();
  }, [held]);

  return (
    <div className={`page creator-page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/creators/">Creators</Link>
        <span>/</span>
        <span>{shortAddress(address)}</span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <Avatar address={address} large />
          <div>
            <div className={styles.title}>
              <h1>{shortAddress(address)}</h1>
            </div>
            <AddressLabel address={address} />
          </div>
        </div>
        <div className={styles.actions}>
          <Link
            className="button secondary"
            href={`/wallet/${address}/?window=All`}
          >
            Trading activity
          </Link>
        </div>
      </div>
      {error && !failed && (
        <p role="alert" className="coverage-notice">
          {error}
        </p>
      )}
      <div className="stats-grid live-six-stats creator-stats">
        <Stat label="Launches" pending={total === null && !failed}>
          {failed ? <Unavailable /> : total?.toLocaleString("en-US")}
        </Stat>
        <Stat
          label="First launch"
          pending={!firstFailed && (firstAt === undefined || now === null)}
          note={launchDate(firstAt)}
        >
          {firstFailed ? (
            <Unavailable />
          ) : (
            <LaunchTime at={firstAt} now={now} />
          )}
        </Stat>
        <Stat
          label="Latest launch"
          pending={!failed && (latestAt === undefined || now === null)}
          note={launchDate(latestAt)}
        >
          {failed ? <Unavailable /> : <LaunchTime at={latestAt} now={now} />}
        </Stat>
      </div>
      <section className="panel live-section creator-launches" ref={panelRef}>
        <div className="panel-heading">
          <h2>Launches</h2>
        </div>
        {loading && list && (
          <span className="sr-only" role="status">
            Updating saved launches
          </span>
        )}
        {/* A creator with fewer launches than a page keeps only the rows
            they fill, and one with none keeps a short slot the empty state
            overlays. A failed first read keeps every reserved row, blank,
            and the failed state overlays the top of them, right under the
            heading. */}
        <div className="table-region" data-empty={empty || failed}>
          <div className="table-scroll desktop-pools desktop-creator-launches">
            <table className="data-table creator-launches-table">
              {/* Whole-pixel widths so a row streamed in later, with a longer
                  token name or a resolved figure, cannot reflow the columns
                  already on screen. */}
              <colgroup>
                <col />
                <col className="col-mode" />
                <col className="col-price" />
                <col className="col-change" />
                <col className="col-volume" />
                <col className="col-status" />
              </colgroup>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Mode</th>
                  <th>Price</th>
                  <th>24h</th>
                  <th>24h volume</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, index) => {
                  const skeleton = !p && skeletonAt(index);
                  const blank = !p && !skeleton;
                  return (
                    <tr
                      key={index}
                      data-row-index={index}
                      data-row={
                        p ? "resolved" : skeleton ? "skeleton" : "reserved"
                      }
                      aria-hidden={!p}
                    >
                      <td data-pending={skeleton}>
                        {p ? (
                          <PoolCell
                            pool={p}
                            subtitle={<LaunchAge pool={p} now={now} />}
                          />
                        ) : skeleton ? (
                          "Token pending"
                        ) : (
                          " "
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {p ? (
                          <span>{launchMode(p)}</span>
                        ) : skeleton ? (
                          "Pending"
                        ) : (
                          " "
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {blank ? (
                          " "
                        ) : (
                          <Price wei={p?.stats.priceWei} pending={skeleton} />
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {blank ? (
                          " "
                        ) : p ? (
                          <Change value={p.stats.change} />
                        ) : (
                          <Change pending />
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {blank ? (
                          " "
                        ) : (
                          <Eth wei={p?.stats.volumeWei} pending={skeleton} />
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {p ? (
                          <LaunchStatus pool={p} />
                        ) : skeleton ? (
                          "Pending"
                        ) : (
                          " "
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Below 768px: the screener's own card, the token tile with its
              price over its 24h change at the right, then the mode and 24h
              volume with the status at the right. */}
          <div className="mobile-pools">
            {rows.map((p, index) => {
              const skeleton = !p && skeletonAt(index);
              return (
                <article
                  className="mobile-pool"
                  key={index}
                  data-row-index={index}
                  data-row={p ? "resolved" : skeleton ? "skeleton" : "reserved"}
                  aria-hidden={!p}
                >
                  {p ? (
                    <Fragment key="resolved">
                      <div className="mobile-pool-top">
                        <PoolCell
                          pool={p}
                          subtitle={<LaunchAge pool={p} now={now} />}
                        />
                        <div className="mobile-pool-price">
                          <Price wei={p.stats.priceWei} />
                          <Change value={p.stats.change} />
                        </div>
                      </div>
                      <div className="mobile-pool-stats">
                        <span>
                          {[
                            launchMode(p),
                            p.stats.volumeWei !== null ? "Vol" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          {p.stats.volumeWei !== null && (
                            <>
                              {" "}
                              <Eth wei={p.stats.volumeWei} />
                            </>
                          )}
                        </span>
                        <LaunchStatus pool={p} />
                      </div>
                    </Fragment>
                  ) : skeleton ? (
                    <Fragment key="pending">
                      <div className="mobile-pool-top">
                        <span className="token-cell">
                          <span className="chain-token" data-pending="true">
                            Token
                          </span>
                          <span>
                            <strong data-pending="true">Token pending</strong>
                            <small data-pending="true">{" "}</small>
                          </span>
                        </span>
                        <div className="mobile-pool-price">
                          <Price pending />
                          <Change pending />
                        </div>
                      </div>
                      <div className="mobile-pool-stats">
                        <span data-pending="true">{" "}</span>
                      </div>
                    </Fragment>
                  ) : null}
                </article>
              );
            })}
          </div>
          {failed && <UnavailableState subject="Launches" onRetry={refresh} />}
          {empty && (
            <EmptyState
              title="No launches"
              description="Nothing launched by this address."
            />
          )}
        </div>
        <ShowMore
          shown={shown}
          total={failed ? 0 : total}
          cap={EXPLORE_ROWS_CAP}
          loading={loading}
          onMore={showMore}
        />
      </section>
    </div>
  );
}
