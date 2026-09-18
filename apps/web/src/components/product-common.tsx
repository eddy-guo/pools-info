"use client";

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
}: {
  shown: number;
  total: number | null;
  step?: number;
  cap?: number;
  loading: boolean;
  onMore: () => void;
}) {
  const known = total !== null;
  const ceiling = known
    ? cap === undefined
      ? total
      : Math.min(total, cap)
    : (cap ?? Infinity);
  const remaining = Math.max(0, ceiling - shown);
  return (
    <div className="pagination">
      <span className="pagination-count">
        {known && total
          ? `Showing ${Math.min(shown, total).toLocaleString()} of ${total.toLocaleString()}`
          : "0 results"}
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
