"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AnalyticsExploreResponse, AnalyticsPoolRow } from "@pools/core";
import type { Delivered } from "@/lib/use-product";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress } from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
import { useLive } from "./live-provider";
import { Eth, Unavailable, utc } from "./live-ui";
import { useQuery } from "./state";
import { AddressChip, AddressLabel } from "./ui";

/** The explore API pages at most 100 rows; one batch streams 20 pages before pausing on Load more. */
const PAGE_SIZE = 100;
const BATCH = 20 * PAGE_SIZE;
const ROW_HEIGHT = 62;
const HEADER_HEIGHT = 34;
/** Rows the reserved scroll surface shows before any data arrives. */
const RESERVED_ROWS = 11;
const OVERSCAN = 8;
const SCROLL_SNAPSHOT_KEY = "poolsinfo.creators.scroll.v1";
const SORTS = [
  ["volume", "Volume"],
  ["launches", "Launches"],
] as const;
type Sort = (typeof SORTS)[number][0];

type Catalog = {
  items: AnalyticsPoolRow[];
  total: number | null;
  /** Offset of the next unfetched page; null once the catalog is exhausted. */
  nextOffset: number | null;
  error?: string;
};

/** Streams the saved catalog one page per effect run, pausing at the current batch budget. */
function useCatalog(address?: string) {
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
          `/api/product/explore/?window=24h&sort=launch&limit=${PAGE_SIZE}&offset=${offset}${address ? `&q=${encodeURIComponent(address)}` : ""}`,
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

function groupBySender(items: AnalyticsPoolRow[], sort: Sort) {
  const bySender = new Map<string, AnalyticsPoolRow[]>();
  for (const pool of items) {
    const sender = pool.launchSender.toLowerCase();
    const launches = bySender.get(sender);
    if (launches) launches.push(pool);
    else bySender.set(sender, [pool]);
  }
  const compare = (a: bigint | null, b: bigint | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a > b ? -1 : 1;
  return [...bySender]
    .map(([sender, pools]) => {
      const measured = pools.filter((p) => p.stats.volumeWei !== null);
      const volumes = measured
          .map((p) => BigInt(p.stats.volumeWei!))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        mid = Math.floor(volumes.length / 2);
      const volume = volumes.length
        ? volumes.reduce((a, b) => a + b, 0n)
        : null;
      const median = volumes.length
        ? volumes.length % 2
          ? volumes[mid]
          : (volumes[mid - 1] + volumes[mid]) / 2n
        : null;
      const best = [...measured].sort((a, b) =>
        BigInt(a.stats.volumeWei!) > BigInt(b.stats.volumeWei!) ? -1 : 1,
      )[0];
      const active = pools.filter((p) => (p.stats.trades ?? 0) > 0).length;
      const complete = pools.every(
        (p) => p.processed && p.stats.completeWindow,
      );
      return { sender, pools, volume, median, best, active, complete };
    })
    .sort(
      (a, b) =>
        (sort === "launches" ? b.pools.length - a.pools.length : 0) ||
        compare(a.volume, b.volume) ||
        a.sender.localeCompare(b.sender),
    );
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
  const sort: Sort = params.get("sort") === "launches" ? "launches" : "volume";
  const catalog = useCatalog();
  const groups = useMemo(
    () => groupBySender(catalog.items, sort),
    [catalog.items, sort],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // The virtualizer is a live instance by design; the React Compiler is not enabled here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: groups.length || RESERVED_ROWS,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    // Server output paints the reserved rows inside the surface before hydration.
    initialRect: {
      width: 0,
      height: RESERVED_ROWS * ROW_HEIGHT + HEADER_HEIGHT,
    },
  });
  // Restore the last scroll snapshot for this sort once the surface can hold it.
  const restore = useRef<{ sort: Sort; offset: number } | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (restore.current === undefined)
      try {
        restore.current = JSON.parse(
          sessionStorage.getItem(SCROLL_SNAPSHOT_KEY) ?? "null",
        );
      } catch {
        restore.current = null;
      }
    const snapshot = restore.current,
      surface = scrollRef.current;
    if (!snapshot || !surface || !groups.length) return;
    if (
      snapshot.sort === sort &&
      surface.scrollHeight - surface.clientHeight >= snapshot.offset
    )
      virtualizer.scrollToOffset(snapshot.offset);
    else if (snapshot.sort === sort && catalog.streaming) return;
    restore.current = null;
  }, [groups.length, sort, catalog.streaming, virtualizer]);
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(
          SCROLL_SNAPSHOT_KEY,
          JSON.stringify({ sort, offset: virtualizer.scrollOffset ?? 0 }),
        );
      } catch {
        /* Storage may be unavailable in private browsers. */
      }
    };
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [sort, virtualizer]);
  const rows = virtualizer.getVirtualItems();
  const first = rows[0],
    last = rows[rows.length - 1];
  const loaded = catalog.items.length,
    total = catalog.total;
  const pending = !loaded && catalog.streaming;
  return (
    <div className="page creators-page">
      <div className="page-heading">
        <div>
          <h1>
            Creators<span className="title-dot">.</span>
          </h1>
          <p>Who launches pools, how often, and how their launches trade.</p>
        </div>
        <div className="segmented" role="group" aria-label="Sort creators">
          {SORTS.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={sort === key}
              onClick={() => {
                set({ sort: key === "volume" ? null : key });
                virtualizer.scrollToOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <section className="panel creators-panel">
        <div
          className="creators-scroll"
          ref={scrollRef}
          tabIndex={0}
          aria-label="Creators"
          aria-busy={pending}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Creator</th>
                <th>Launches</th>
                <th>Still trading</th>
                <th>24h volume</th>
                <th>Median</th>
                <th>Best launch</th>
              </tr>
            </thead>
            <tbody>
              {first && first.start > 0 && (
                <tr className="spacer" aria-hidden>
                  <td colSpan={7} style={{ height: first.start }} />
                </tr>
              )}
              {rows.map((row) => {
                const g = groups[row.index];
                return (
                  <tr
                    key={row.index}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    aria-hidden={!g}
                    data-row={g ? "resolved" : "reserved"}
                  >
                    <td className="rank-number" data-pending={pending}>
                      {g ? row.index + 1 : pending ? "Rank" : " "}
                    </td>
                    <td data-pending={pending}>
                      {g ? (
                        <AddressChip
                          address={g.sender}
                          href={`/creators/${g.sender}/`}
                        />
                      ) : pending ? (
                        "Creator pending"
                      ) : (
                        " "
                      )}
                    </td>
                    <td data-pending={pending}>
                      {g ? g.pools.length : pending ? "Pending" : " "}
                    </td>
                    <td data-pending={pending}>
                      {g ? (
                        g.complete ? (
                          `${g.active}/${g.pools.length}`
                        ) : (
                          <Unavailable
                            reason={`${g.active} pools have observed swaps; full 24h coverage is incomplete`}
                          />
                        )
                      ) : pending ? (
                        "Pending"
                      ) : (
                        " "
                      )}
                    </td>
                    <td>
                      <Eth wei={g?.volume?.toString()} pending={pending} />
                    </td>
                    <td>
                      <Eth wei={g?.median?.toString()} pending={pending} />
                    </td>
                    <td data-pending={pending}>
                      {g ? (
                        g.best ? (
                          <Link href={poolHref(g.best)}>{g.best.symbol}</Link>
                        ) : (
                          <Unavailable />
                        )
                      ) : pending ? (
                        "Pending"
                      ) : (
                        " "
                      )}
                    </td>
                  </tr>
                );
              })}
              {last && last.end < virtualizer.getTotalSize() && (
                <tr className="spacer" aria-hidden>
                  <td
                    colSpan={7}
                    style={{ height: virtualizer.getTotalSize() - last.end }}
                  />
                </tr>
              )}
            </tbody>
          </table>
          {!groups.length && !catalog.streaming && !catalog.error && (
            <div className="empty-state">
              <h3>No creators in current coverage</h3>
              <p>The saved catalog has no launches to group yet.</p>
            </div>
          )}
        </div>
        <div className="pagination creators-progress">
          {catalog.error ? (
            <span role="alert">{catalog.error}</span>
          ) : (
            <span role="status" data-pending={!total}>
              {total === null
                ? "Loading creators"
                : `${catalog.streaming ? "Loading creators · " : ""}${loaded.toLocaleString()} of ${total.toLocaleString()} pools · ${groups.length.toLocaleString()} creators`}
            </span>
          )}
          {catalog.error ? (
            <button className="button secondary" onClick={catalog.retry}>
              Retry
            </button>
          ) : (
            catalog.nextOffset !== null &&
            !catalog.streaming && (
              <button className="button secondary" onClick={catalog.loadMore}>
                Load more
              </button>
            )
          )}
          {catalog.streaming && total !== null && (
            <span
              className="creators-progress-bar"
              style={{ width: `${(100 * loaded) / total}%` }}
              aria-hidden
            />
          )}
        </div>
      </section>
    </div>
  );
}

function CreatorProfile({ address }: { address: string }) {
  const catalog = useCatalog(address);
  const [group] = useMemo(
    () =>
      groupBySender(
        catalog.items.filter((p) => p.launchSender.toLowerCase() === address),
        "volume",
      ),
    [catalog.items, address],
  );
  const pools = group?.pools ?? [];
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
