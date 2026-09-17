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

/** Gmail-style paging: 25 / 50 / 100 rows, chosen only where `onLimit` is wired up. */
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export function ProductPagination({
  offset,
  total,
  nextOffset,
  onPage,
  loading,
  limit = 25,
  onLimit,
}: {
  offset: number;
  total: number;
  nextOffset: number | null;
  onPage: (offset: number) => void;
  loading: boolean;
  limit?: PageSize;
  onLimit?: (limit: PageSize) => void;
}) {
  return (
    <div className="pagination">
      <span className={onLimit ? "pagination-count" : undefined}>
        {total
          ? `${offset + 1}-${Math.min(offset + limit, total)} of ${total.toLocaleString()}`
          : "0 results"}
      </span>
      {onLimit ? (
        <>
          <div className="segmented" aria-label="Rows per page">
            {PAGE_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={limit === size}
                disabled={loading}
                onClick={() => onLimit(size)}
              >
                {size}
              </button>
            ))}
          </div>
          <div>
            <button
              className="button secondary"
              disabled={!offset || loading}
              onClick={() => onPage(Math.max(0, offset - limit))}
            >
              Previous
            </button>
            <button
              className="button secondary"
              disabled={nextOffset === null || loading}
              onClick={() => nextOffset !== null && onPage(nextOffset)}
            >
              Next
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            className="button secondary"
            disabled={!offset || loading}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            Previous
          </button>
          <button
            className="button secondary"
            disabled={nextOffset === null || loading}
            onClick={() => nextOffset !== null && onPage(nextOffset)}
          >
            Next
          </button>
        </>
      )}
    </div>
  );
}
