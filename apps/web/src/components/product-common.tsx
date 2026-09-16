"use client";

/** Pending values occupy the same line box as resolved values, without fake data. */
export function PendingValue({
  pending = false,
  children,
}: {
  pending?: boolean;
  children: React.ReactNode;
}) {
  return <span data-pending={pending}>{pending ? "Pending" : children}</span>;
}

export function ProductPagination({
  offset,
  total,
  nextOffset,
  onPage,
  loading,
}: {
  offset: number;
  total: number;
  nextOffset: number | null;
  onPage: (offset: number) => void;
  loading: boolean;
}) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${offset + 1}-${Math.min(offset + 25, total)} of ${total.toLocaleString()}`
          : "0 results"}
      </span>
      <button
        className="button secondary"
        disabled={!offset || loading}
        onClick={() => onPage(Math.max(0, offset - 25))}
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
  );
}
