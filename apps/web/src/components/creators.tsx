"use client";
import Link from "next/link";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AnalyticsExploreResponse,
  AnalyticsPoolRow,
  CreatorRow,
  CreatorsResponse,
} from "@pools/core";
import {
  DATA_UNAVAILABLE,
  OUTSIDE_COVERAGE,
  fetchProduct,
  type Delivered,
} from "@/lib/use-product";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress } from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
import { useLive } from "./live-provider";
import { Eth, Unavailable, useWindow, utc, WindowTabs } from "./live-ui";
import { useQuery } from "./state";
import { AddressChip, AddressLabel, UnavailableState } from "./ui";
import { SHOW_MORE_STEP, ShowMore } from "./product-common";

/** The explore API pages at most 100 rows; one batch streams 20 pages before pausing on Load more. */
const PAGE_SIZE = 100;
const BATCH = 20 * PAGE_SIZE;

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
    percentage it represents. Left-aligned text never moves its start when
    the digits change, so this needs no shift-avoidance keying. */
function StillTrading({
  traded,
  measured,
}: {
  traded: number;
  measured: number;
}) {
  const pct = Math.round((traded / measured) * 100);
  return (
    <span className="still-trading">
      <span className="still-trading-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="still-trading-label">
        {traded} of {measured} · {pct}%
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
            {r.measured ? (
              <StillTrading traded={r.traded} measured={r.measured} />
            ) : (
              <Unavailable reason="No measured launch" />
            )}
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

type Catalog = {
  items: AnalyticsPoolRow[];
  total: number | null;
  /** Offset of the next unfetched page; null once the catalog is exhausted. */
  nextOffset: number | null;
  error?: string;
};

/** Streams a single creator's saved launches one page per effect run, pausing at the current batch budget. */
function useCatalog(address: string) {
  const [state, setState] = useState<Catalog>({
    items: [],
    total: null,
    nextOffset: 0,
  });
  const [budget, setBudget] = useState(BATCH);
  useEffect(() => {
    const offset = state.nextOffset;
    if (offset === null || offset >= budget || state.error) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/product/explore/?window=24h&sort=launch&limit=${PAGE_SIZE}&offset=${offset}&q=${encodeURIComponent(address)}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(12000),
            ]),
          },
        );
        if (!response.ok)
          throw Error(
            response.status === 503 ? DATA_UNAVAILABLE : OUTSIDE_COVERAGE,
          );
        const page =
          (await response.json()) as Delivered<AnalyticsExploreResponse>;
        if (controller.signal.aborted) return;
        if (page.nextOffset !== null && page.nextOffset <= offset)
          throw Error("The saved creator catalog stopped paging.");
        setState((prior) => ({
          items: [...prior.items, ...page.items],
          total: page.total,
          nextOffset: page.nextOffset,
        }));
      } catch (error) {
        if (!controller.signal.aborted)
          setState((prior) => ({
            ...prior,
            error:
              error instanceof DOMException
                ? "The saved creator catalog is responding slowly."
                : error instanceof Error
                  ? error.message
                  : DATA_UNAVAILABLE,
          }));
      }
    })();
    return () => controller.abort();
  }, [address, budget, state.nextOffset, state.error]);
  return {
    ...state,
    streaming:
      state.nextOffset !== null && state.nextOffset < budget && !state.error,
    loadMore: () => setBudget((prior) => prior + BATCH),
    retry: () => setState((prior) => ({ ...prior, error: undefined })),
  };
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
                        r.measured ? (
                          <StillTrading
                            traded={r.traded}
                            measured={r.measured}
                          />
                        ) : (
                          <Unavailable reason="No measured launch" />
                        )
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
 * The header cells are fixed by `.creator-launches-table`'s colgroup, and
 * each row keeps its DOM node across the pending-to-resolved swap (keyed by
 * position, not pool id) rather than remounting under a shift-scoring swap.
 * A creator with more than one matching launch still grows the panel as
 * later pages of the scan resolve, since nothing here knows the eventual
 * row count before first paint; closing that fully needs the same
 * shown-count-plus-reserved-height pattern the leaderboards use, which is
 * follow-up work, not part of this pass.
 */
function CreatorProfile({ address }: { address: string }) {
  const catalog = useCatalog(address);
  const pools = useMemo(
    () => catalog.items.filter((p) => p.launchSender.toLowerCase() === address),
    [catalog.items, address],
  );
  const pending = !pools.length && catalog.streaming;
  const failed = !!catalog.error && !pools.length;
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
      {catalog.error && !failed && (
        <p role="alert" className="coverage-notice">
          {catalog.error}
        </p>
      )}
      <section className="panel live-section creator-launches">
        <div className="panel-heading">
          <h2>
            Launches{" "}
            {/* The count the read names, and only that: a launch with no
                market figure is still a launch. */}
            <span className="badge" data-pending={pending}>
              {failed
                ? "unavailable"
                : pending
                  ? "count pending"
                  : (catalog.total ?? pools.length).toLocaleString()}
            </span>
          </h2>
          <Link href={`/wallet/${address}/?window=All`}>
            View wallet profile ↗
          </Link>
        </div>
        {failed ? (
          <UnavailableState subject="Launches" onRetry={catalog.retry} />
        ) : pools.length || pending ? (
          <>
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
                  {/* Keyed by position, not pool id: `pools` only ever grows by
                    appending later pages, so the row already on screen keeps
                    its node (and the single pending row becomes the first
                    real one) instead of remounting under a shift-scoring
                    swap. */}
                  {(pools.length ? pools : [undefined]).map((p, index) => (
                    <tr
                      key={index}
                      aria-hidden={!p}
                      data-row={p ? "resolved" : "skeleton"}
                    >
                      <td data-pending={!p}>
                        {p ? (
                          <Link href={poolHref(p)}>
                            {p.name} ({p.symbol})
                          </Link>
                        ) : (
                          "Token pending"
                        )}
                      </td>
                      <td data-pending={!p}>
                        {p ? utc(p.launchedAt) : "Launch pending"}
                      </td>
                      <td data-pending={!p}>
                        {p ? launchActivity(p) : "Pending"}
                      </td>
                      <td>
                        <Eth wei={p?.stats.volumeWei} pending={!p} />
                      </td>
                      <td data-pending={!p}>
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
                        ) : (
                          "Pending"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Below 768px: the token with its 24h volume at the right, then
              the launch time and activity; creator fees stay out, as the
              table drops that column first. */}
            <div className="mobile-launches">
              {(pools.length ? pools : [undefined]).map((p, index) => (
                <div
                  className="mobile-launch"
                  key={index}
                  aria-hidden={!p}
                  data-row={p ? "resolved" : "skeleton"}
                >
                  <div className="mobile-launch-top">
                    {p ? (
                      <Link href={poolHref(p)}>
                        {p.name} ({p.symbol})
                      </Link>
                    ) : (
                      <span data-pending="true">Token pending</span>
                    )}
                    <Eth wei={p?.stats.volumeWei} pending={!p} />
                  </div>
                  <div className="mobile-launch-stats" data-pending={!p}>
                    {p ? (
                      <>
                        {utc(p.launchedAt)}
                        {p.stats.trades !== null && <> · {launchActivity(p)}</>}
                      </>
                    ) : (
                      "Launch pending"
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h3>No launches in current coverage</h3>
            <p>This does not establish the address’s full launch history.</p>
          </div>
        )}
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
