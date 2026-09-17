"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalyticsExploreResponse,
  AnalyticsPoolRow,
  CreatorsResponse,
} from "@pools/core";
import { useProduct, type Delivered } from "@/lib/use-product";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress } from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
import { useLive } from "./live-provider";
import { Eth, Unavailable, useWindow, utc, WindowTabs } from "./live-ui";
import { useQuery } from "./state";
import { AddressChip, AddressLabel } from "./ui";

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

/** A top-100 leaderboard revealed 25 rows at a click, like the trader leaderboard's own list control. */
const SHOW_STEP = 25;
const SHOW_CAP = 100;
const SHOW_STEPS = [25, 50, 75, 100] as const;
type ShowCount = (typeof SHOW_STEPS)[number];

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
          throw Error("The saved creator catalog is temporarily unavailable.");
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
                  : "Saved catalog unavailable",
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

function CreatorDirectory() {
  const { params, set } = useQuery();
  const { window, setWindow } = useWindow("All");
  const rawSort = params.get("sort");
  const sort: CreatorSort = CREATOR_SORTS.some(([key]) => key === rawSort)
    ? (rawSort as CreatorSort)
    : "launches";
  const rawShown = Number(params.get("limit"));
  const shown: ShowCount = SHOW_STEPS.includes(rawShown as ShowCount)
    ? (rawShown as ShowCount)
    : SHOW_STEP;
  const query = new URLSearchParams({ window, sort, limit: String(shown) });
  const { data, loading, stale, error } = useProduct<CreatorsResponse>(
    `creators?${query}`,
  );
  const rows = data?.items ?? [];
  const total = Math.min(data?.total ?? 0, SHOW_CAP);
  const canShowMore = shown < SHOW_CAP && data?.nextOffset !== null;

  // Set by a "Show more" click to the first newly revealed row's index; a
  // sort or window reset clears it so a stale click never steals focus later.
  const focusRow = useRef<number | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  useEffect(() => {
    const index = focusRow.current;
    if (index === null || loading) return;
    focusRow.current = null;
    rowRefs.current[index]?.focus();
  }, [loading]);

  function resort(updates: Record<string, string | null>) {
    focusRow.current = null;
    set({ ...updates, limit: null });
  }
  function showMore() {
    focusRow.current = shown;
    set({
      limit: String(Math.min(shown + SHOW_STEP, SHOW_CAP)),
    });
  }

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
                  resort({ sort: key === "launches" ? null : key })
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
              resort({});
            }}
          />
        </div>
      </div>
      <section className="panel creators-panel">
        {error && (
          <p role="alert" className="panel-footnote">
            {error}
          </p>
        )}
        <div
          className="table-scroll"
          aria-busy={stale}
          data-stale-rows={stale}
        >
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
              {Array.from({ length: shown }, (_, index) => rows[index]).map(
                (r, index) => (
                  <tr
                    key={index}
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    tabIndex={-1}
                    aria-hidden={!r}
                    data-row={r ? "resolved" : "reserved"}
                  >
                    <td className="rank-number" data-pending={!r && !data}>
                      {r ? index + 1 : data ? " " : "Pending"}
                    </td>
                    <td data-pending={!r && !data}>
                      {r ? (
                        <AddressChip
                          address={r.address}
                          href={`/creators/${r.address}/`}
                          badge={
                            r.boughtOwnLaunch === true ? (
                              <span className="badge lavender">BOUGHT OWN</span>
                            ) : undefined
                          }
                        />
                      ) : data ? (
                        " "
                      ) : (
                        "Creator pending"
                      )}
                    </td>
                    <td data-pending={!r && !data}>
                      {r ? r.launches : data ? " " : "Pending"}
                    </td>
                    <td data-pending={!r && !data}>
                      {r ? (
                        r.measured ? (
                          `${r.traded}/${r.measured}`
                        ) : (
                          <Unavailable reason="No measured launch" />
                        )
                      ) : data ? (
                        " "
                      ) : (
                        "Pending"
                      )}
                    </td>
                    <td data-pending={!r && !data}>
                      <Eth wei={r?.volumeWei} pending={!data} />
                    </td>
                    <td data-pending={!r && !data}>
                      <Eth wei={r?.medianVolumeWei} pending={!data} />
                    </td>
                    <td data-pending={!r && !data}>
                      {r ? (
                        r.bestLaunch ? (
                          <Link href={poolHref(r.bestLaunch)}>
                            {r.bestLaunch.symbol}
                          </Link>
                        ) : (
                          <Unavailable />
                        )
                      ) : data ? (
                        " "
                      ) : (
                        "Pending"
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        {data && !rows.length && (
          <div className="empty-state">
            <h3>No creators in this window</h3>
            <p>Switch the window or sort to find launches to group.</p>
          </div>
        )}
        <div className="pagination">
          <span className="pagination-count">
            {data && total
              ? `Showing ${rows.length} of ${total.toLocaleString()}`
              : "0 results"}
          </span>
          {(!data || canShowMore) && (
            <button
              type="button"
              className="button secondary"
              disabled={!data || loading}
              onClick={showMore}
            >
              Show {SHOW_STEP} more
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function CreatorProfile({ address }: { address: string }) {
  const catalog = useCatalog(address);
  const pools = useMemo(
    () =>
      catalog.items.filter((p) => p.launchSender.toLowerCase() === address),
    [catalog.items, address],
  );
  const pending = !pools.length && catalog.streaming;
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
      {catalog.error && (
        <p role="alert" className="coverage-notice">
          {catalog.error}
        </p>
      )}
      <section className="panel live-section">
        <div className="panel-heading">
          <h2>
            Launches{" "}
            <span className="badge" data-pending={pending}>
              {pending ? "count pending" : `${pools.length} covered`}
            </span>
          </h2>
          <Link href={`/wallet/${address}/?window=All`}>
            View wallet profile ↗
          </Link>
        </div>
        {pools.length || pending ? (
          <div className="table-scroll">
            <table className="data-table">
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
                {(pools.length ? pools : [undefined]).map((p, index) => (
                  <tr key={p?.id ?? index} aria-hidden={!p}>
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
                      {p
                        ? (p.stats.trades ?? 0) > 0
                          ? "Active"
                          : p.processed
                            ? "No swap observed"
                            : "Processing"
                        : "Pending"}
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
