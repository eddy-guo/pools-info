"use client";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  AnalyticsPoolRow,
  CreatorRow,
  CreatorsResponse,
} from "@pools/core";
import { DATA_UNAVAILABLE, fetchProduct } from "@/lib/use-product";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress } from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
import { useLive } from "./live-provider";
import { Eth, Unavailable, useWindow, utc, WindowTabs } from "./live-ui";
import { useQuery } from "./state";
import { AddressChip, AddressLabel, EmptyState, UnavailableState } from "./ui";
import { EXPLORE_ROWS_CAP, SHOW_MORE_STEP, ShowMore } from "./product-common";
import { useExploreRows } from "@/lib/use-explore-rows";

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
  if (!r.measured) return <Unavailable reason="No measured launch" />;
  if (r.measured < r.launches)
    return <Unavailable reason="Not every launch measured" />;
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
                  <span className="badge lavender">BOUGHT OWN</span>
                ) : undefined
              }
            />
            <span className="mobile-creator-launches">
              <strong>{r.launches}</strong>
              <span>launches</span>
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
  items: CreatorRow[];
  total: number;
  loadedShown: number;
  loading: boolean;
  settled: boolean;
  error?: string;
};

/**
 * Grows a creators leaderboard window/sort pair page by page: a window or
 * sort change (a new `key`) replaces the list from scratch, while a growing
 * `shown` target on the same key fetches only the rows not already held and
 * appends them, so an already-loaded row is never requested twice.
 */
function useCreatorsBoard(
  key: string,
  window: string,
  sort: string,
  shown: number,
) {
  const [state, setState] = useState<CreatorsState>({
    key: "",
    items: [],
    total: 0,
    loadedShown: 0,
    loading: true,
    settled: false,
  });
  useEffect(() => {
    const isReset = state.key !== key;
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
          items: [...baseItems, ...data.items],
          total: data.total,
          loadedShown: baseLoaded + data.items.length,
          loading: false,
          settled: true,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          key,
          loading: false,
          error: error instanceof Error ? error.message : DATA_UNAVAILABLE,
        }));
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, window, sort, shown]);
  return state;
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
  /* No board was served: the reserved rows stay blank rather than shimmering
     on for ever, and the panel says what happened. */
  const failed = forKey && !!state.error && items.length === 0;

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
        <div className="table-scroll desktop-creators">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Creator</th>
                <th>Launches</th>
                <th>Still trading</th>
                <th>Volume</th>
                <th>Median</th>
                <th>Best</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(
                { length: failed ? 0 : shown },
                (_, index) => items[index],
              ).map((r, index) => {
                const absent = knownAbsent(index);
                const pending = !r && !absent;
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
                              <span className="badge lavender">BOUGHT OWN</span>
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
                          <Link className="mono" href={poolHref(r.bestLaunch)}>
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
          {Array.from(
            { length: failed ? 0 : shown },
            (_, index) => items[index],
          ).map((r, index) => (
            <MobileCreatorRow
              key={index}
              r={r}
              index={index}
              pending={!r && !knownAbsent(index)}
            />
          ))}
        </div>
        {failed && <UnavailableState subject="Creators" />}
        {settled && total === 0 && (
          <div className="empty-state">
            <h3>No creators in this window</h3>
            <p>Switch the window or sort to find launches to group.</p>
          </div>
        )}
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
 * A measured launch's trading state over the last 24 hours. A launch the
 * read has no market figure for shows no state at all, as its figure cells
 * are empty: nothing here is waiting on a later pass.
 */
function launchActivity(p: AnalyticsPoolRow) {
  return p.stats.trades === null ? (
    <Unavailable reason="No measured activity" />
  ) : p.stats.trades > 0 ? (
    "Active"
  ) : (
    "No swap observed"
  );
}

/**
 * The creator's launches in launch order, read through the screener's own
 * hook: the rows the URL's `limit` names are reserved at first paint (25 by
 * default, grown by the shared Show more control up to the explore ceiling),
 * so a read that lands never resizes the panel and the footer under it never
 * moves. Rows are keyed by position, so a pending row becomes the real one in
 * place rather than remounting under a shift-scoring swap.
 */
function CreatorProfile({ address }: { address: string }) {
  const { params, set } = useQuery();
  const rawShown = Number(params.get("limit"));
  const shown =
    Number.isInteger(rawShown) && rawShown > 0
      ? Math.min(rawShown, EXPLORE_ROWS_CAP)
      : SHOW_MORE_STEP;
  const { list, loading, settled, error, refresh } = useExploreRows(
    `window=24h&sort=launch&q=${address}`,
    shown,
  );
  /* Nothing was served: the reserved rows stay blank rather than shimmering
     on for ever, and the panel says what happened. */
  const failed = !!error && !list;
  const total = list ? list.total : null;
  const rows = Array.from({ length: shown }, (_, index) => list?.rows[index]);
  const skeletonAt = (index: number) =>
    !failed && (!list || (loading && index < list.total));
  const empty = settled && total === 0;

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
    <div className={`page ${styles.page}`}>
      <div className="page-heading">
        <div>
          <h1>
            {shortAddress(address)}
            <span className="title-dot">.</span>
          </h1>
          <AddressLabel address={address} full />
        </div>
      </div>
      {error && !failed && (
        <p role="alert" className="coverage-notice">
          {error}
        </p>
      )}
      <section className="panel live-section creator-launches" ref={panelRef}>
        <div className="panel-heading">
          <h2>
            Launches{" "}
            {/* The count the read names, and only that: a launch with no
                market figure is still a launch. */}
            <span className="badge" data-pending={total === null && !failed}>
              {failed
                ? "unavailable"
                : total === null
                  ? "count pending"
                  : total.toLocaleString()}
            </span>
          </h2>
          <Link href={`/wallet/${address}/?window=All`}>
            View wallet profile ↗
          </Link>
        </div>
        {loading && list && (
          <span className="sr-only" role="status">
            Updating saved launches
          </span>
        )}
        {/* The reserved row geometry stays put when the creator has fewer
            launches than a page, or none: the empty state overlays the top
            of that area rather than sitting under a screen of blank rows. */}
        <div className="table-region" data-empty={empty || failed}>
          <div className="table-scroll desktop-creator-launches">
            <table className="data-table creator-launches-table">
              {/* Fixed widths so a row streamed in later, with a longer
                token name or a resolved date, cannot reflow the columns
                already on screen. */}
              <colgroup>
                <col />
                <col className="col-launch" />
                <col className="col-activity" />
                <col className="col-volume" />
                <col className="col-fees" />
              </colgroup>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Launch (UTC)</th>
                  <th>24h activity</th>
                  <th>24h volume</th>
                  <th>Creator fees</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, index) => {
                  const skeleton = !p && skeletonAt(index);
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
                          <Link href={poolHref(p)}>
                            {p.name} ({p.symbol})
                          </Link>
                        ) : skeleton ? (
                          "Token pending"
                        ) : (
                          "\u00a0"
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {p
                          ? utc(p.launchedAt)
                          : skeleton
                            ? "Launch pending"
                            : "\u00a0"}
                      </td>
                      <td data-pending={skeleton}>
                        {p
                          ? launchActivity(p)
                          : skeleton
                            ? "Pending"
                            : "\u00a0"}
                      </td>
                      <td data-pending={skeleton}>
                        {p || skeleton ? (
                          <Eth wei={p?.stats.volumeWei} pending={skeleton} />
                        ) : (
                          "\u00a0"
                        )}
                      </td>
                      <td data-pending={skeleton}>
                        {p ? (
                          p.market ? (
                            p.market.creatorFees ? (
                              "On"
                            ) : (
                              "Off"
                            )
                          ) : (
                            <Unavailable />
                          )
                        ) : skeleton ? (
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
          {/* Below 768px: the token with its 24h volume at the right, then the
            launch time and activity; creator fees stay out, as the table
            drops that column first. */}
          <div className="mobile-launches">
            {rows.map((p, index) => {
              const skeleton = !p && skeletonAt(index);
              return (
                <div
                  className="mobile-launch"
                  key={index}
                  data-row-index={index}
                  data-row={p ? "resolved" : skeleton ? "skeleton" : "reserved"}
                  aria-hidden={!p}
                >
                  <div className="mobile-launch-top">
                    {p ? (
                      <Link href={poolHref(p)}>
                        {p.name} ({p.symbol})
                      </Link>
                    ) : (
                      <span data-pending={skeleton}>
                        {skeleton ? "Token pending" : "\u00a0"}
                      </span>
                    )}
                    {p || skeleton ? (
                      <Eth wei={p?.stats.volumeWei} pending={skeleton} />
                    ) : (
                      <span className="number">{"\u00a0"}</span>
                    )}
                  </div>
                  <div className="mobile-launch-stats" data-pending={skeleton}>
                    {p ? (
                      <>
                        {utc(p.launchedAt)}
                        {p.stats.trades !== null && <> · {launchActivity(p)}</>}
                      </>
                    ) : skeleton ? (
                      "Launch pending"
                    ) : (
                      "\u00a0"
                    )}
                  </div>
                </div>
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

/** Public launch history only. This does not assert creator identity or allocation. */
export function WalletLaunches({ address }: { address: string }) {
  const { snapshot, audits } = useLive();
  const pools = [
    ...new Map(
      [...catalog.pools, ...snapshot.markets].map((m) => [m.id, m]),
    ).values(),
  ]
    .filter((m) => m.launchSender.toLowerCase() === address.toLowerCase())
    .sort((a, b) => b.launchBlock - a.launchBlock);
  return (
    <section className="panel live-section">
      <div className="panel-heading">
        <h2>
          Launches <span className="badge">{pools.length} covered</span>
        </h2>
      </div>
      {pools.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Launched (UTC)</th>
                <th>Status</th>
                <th>Observed volume</th>
                <th>Own purchase</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => {
                const market = snapshot.markets.find((m) => m.id === p.id);
                const active =
                  market &&
                  snapshot.trades.some(
                    (t) =>
                      t.poolId === p.id &&
                      t.timestamp >= snapshot.toTimestamp - 86400,
                  );
                const audit = audits[p.id];
                const bought = audit?.executions.some(
                  (e) =>
                    e.trade.trader.toLowerCase() === address.toLowerCase() &&
                    e.trade.side === "buy" &&
                    !e.flags.length,
                );
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={poolHref(p)}>
                        <strong>{p.symbol}</strong>
                        <small className="cell-sub">{p.name}</small>
                      </Link>
                    </td>
                    <td>{utc(p.launchedAt)}</td>
                    <td>
                      {market ? (
                        <span className="badge">
                          {active ? "Active" : "No swap observed"}
                        </span>
                      ) : (
                        <Unavailable reason="Activity has not been collected" />
                      )}
                    </td>
                    <td>
                      <Eth wei={market?.volumeWei} />
                    </td>
                    <td>
                      {bought ? (
                        <span className="badge lavender">BOUGHT OWN</span>
                      ) : (
                        <Unavailable reason="No supported own purchase established" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <h3>No launches in current coverage</h3>
          <p>A launch outside this catalog may not appear yet.</p>
        </div>
      )}
      <p className="panel-footnote">
        Grouped by launch transaction sender. Active means an observed swap in
        the 24 hours before the captured cutoff. This is a covered launch
        record, not a complete creator identity or allocation audit.
      </p>
    </section>
  );
}
