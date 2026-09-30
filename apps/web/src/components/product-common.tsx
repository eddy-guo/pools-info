"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { poolHref, type AnalyticsPoolRow } from "@pools/core";
import { useBelowListKey } from "@/lib/list-release";
import { rememberPoolRow } from "@/lib/pool-row-memory";
import { showMoreCount } from "@/lib/show-more-count";
import { tokenLabel, tokenSubSymbol } from "@/lib/token-identity";
import { PoolImage } from "./pool-image";

/**
 * Pending values occupy the same line box as resolved values, without fake
 * data. The skeleton and the value are separate nodes: a text run that changes
 * width inside one right-aligned node moves its start, which Chrome reports as
 * a layout shift even when the box around it holds still.
 */
export function PendingValue({
  pending = false,
  children,
}: {
  pending?: boolean;
  children: React.ReactNode;
}) {
  return pending ? (
    <span key="pending" data-pending="true">
      Pending
    </span>
  ) : (
    <span key="value" data-pending="false">
      {children}
    </span>
  );
}

/**
 * The rows a growable list reserves right now: the pending or already-
 * resolved count while a first read could still land or already has, and
 * zero once that read has failed with nothing on screen. A pending list
 * reserves its target row count for CLS 0; a failed one collapses that
 * reservation entirely rather than holding a screen (or several, on a
 * narrow viewport) of blank rows behind the retry control its
 * `UnavailableState` renders in their place. The trader leaderboard, the
 * Following activity and the wallet's Trades tab keep this shape; the lists
 * over one counted answer use `answeredRowCount` below.
 */
export function reservedRowCount(shown: number, failed: boolean) {
  return failed ? 0 : shown;
}

/** The rows an empty answer keeps, for its EmptyState to sit in. */
export const EMPTY_SLOT_ROWS = 3;

/**
 * The rows a list over one counted answer (the creators board, a creator's
 * launches, the screener, a wallet's positions) reserves: every row its URL
 * names until the current query's answer lands, a failed read included, so
 * nothing under the list moves while the retry control overlays the top of
 * the region; then only the rows that answer fills, or a short slot for its
 * EmptyState. `answered` is that answer's total, null while it is pending,
 * stale or failed. The release happens under the rows already on show, so
 * nothing above the cut moves; the list reports it to `useListRelease` so
 * the nodes under it remount rather than shift.
 */
export function answeredRowCount(shown: number, answered: number | null) {
  if (answered === null) return shown;
  return answered === 0 ? EMPTY_SLOT_ROWS : Math.min(shown, answered);
}

/** The running-total step every "Show more" list grows by. */
export const SHOW_MORE_STEP = 25;
/** The most rows a list over the explore read shows at once: forty pages of
    Show more, and the most a hand-edited or stale URL can make a page read
    and render. */
export const EXPLORE_ROWS_CAP = 1000;

/**
 * Gmail-inbox style growth, not classic paging: a "Showing N of M" readout
 * plus one button that loads the next `step` rows, disabled while a fetch is
 * in flight and gone once `shown` reaches `total` or the caller's `cap` (a
 * hard ceiling the list never requests past, independent of `total`).
 *
 * `total` is `null` before the first response names a real count; the button
 * then stays reserved (optimistic, up to `cap`) rather than popping in once
 * the count resolves, which would shift everything below the control.
 */
export function ShowMore({
  shown,
  total,
  step = SHOW_MORE_STEP,
  cap,
  loading,
  onMore,
  note,
}: {
  shown: number;
  total: number | null;
  step?: number;
  cap?: number;
  loading: boolean;
  onMore: () => void;
  /** A Show more whose read failed: the count's own slot says so, in the
      foot the reader asked from, and the button stays to ask again. */
  note?: string;
}) {
  const known = total !== null;
  const ceiling = known
    ? cap === undefined
      ? total
      : Math.min(total, cap)
    : (cap ?? Infinity);
  const remaining = Math.max(0, ceiling - shown);
  const releaseKey = useBelowListKey();
  return (
    <div className="pagination" key={releaseKey}>
      <span className="pagination-count" role={note ? "alert" : undefined}>
        {note ?? showMoreCount(shown, total)}
      </span>
      {remaining > 0 && (
        <button
          type="button"
          className="button secondary"
          disabled={loading}
          onClick={onMore}
        >
          Show {known ? Math.min(step, remaining) : step} more
        </button>
      )}
    </div>
  );
}

const subscribeClock = (notify: () => void) => {
  const id = setInterval(notify, 30000);
  return () => clearInterval(id);
};
const currentSeconds = () => Math.floor(Date.now() / 1000);
const serverSeconds = () => null;
/** The wall clock in seconds, ticking every 30 s; null on the server and
    through hydration, so a relative age paints only once the client knows
    the time. */
export function useClockSeconds() {
  return useSyncExternalStore<number | null>(
    subscribeClock,
    currentSeconds,
    serverSeconds,
  );
}
/**
 * A pool with neither a deep publication nor a broad rollup has no market
 * evidence at all; it reads as a launch rather than as a row of N/A.
 */
export const launchOnly = (pool: AnalyticsPoolRow) =>
  !pool.processed && !pool.marketCoverage;
/** A pool's token tile: its image, its name and a subtitle (by default the
    symbol and launch date), opening the pool's page. The screener's rows
    and a creator's launches share it. */
export function PoolCell({
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
        symbol={pool.symbol}
        hasImage={!!pool.imageUrl}
      />
      <span>
        <strong>{tokenLabel(pool)}</strong>
        <small>
          {subtitle ??
            ([
              tokenSubSymbol(pool),
              launchOnly(pool)
                ? null
                : new Date(pool.launchedAt * 1000).toLocaleDateString("en-US", {
                    timeZone: "UTC",
                  }),
            ]
              .filter(Boolean)
              .join(" · ") ||
              "\u00a0")}
        </small>
      </span>
    </Link>
  );
}
