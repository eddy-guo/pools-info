"use client";
import Link from "next/link";
import type { AnalyticsCoverage } from "@pools/core";
import type { ProductDelivery } from "@/lib/use-product";
export function ProductCoverage({
  coverage,
  delivery,
}: {
  coverage?: AnalyticsCoverage;
  delivery?: ProductDelivery;
}) {
  return (
    <div
      className="coverage-notice product-coverage"
      role="status"
      aria-busy={!coverage}
    >
      <strong data-pending={!coverage}>
        {coverage ? (
          <>
            {coverage.catalogPools.toLocaleString()} discovered pools ·{" "}
            {coverage.processedPools.toLocaleString()} with saved analytics
          </>
        ) : (
          "Loading saved analytics coverage"
        )}
      </strong>
      <p data-pending={!coverage}>
        {coverage ? (
          <>
            {coverage.processedPools > 0 && coverage.asOf > 0 ? (
              <>
                Latest captured data{" "}
                {new Date(coverage.asOf * 1000).toLocaleString("en-US", {
                  timeZone: "UTC",
                })}{" "}
                UTC. Pool cutoffs vary.
              </>
            ) : (
              "Analytics processing has not completed yet."
            )}{" "}
            {coverage.pnlScope === "observed_initiator_and_verified_positions"
              ? "PnL combines flagged initiator estimates and transfer-verified positions. Unknown basis stays excluded."
              : "PnL covers supported pool positions, not all wallet activity."}
            {delivery?.notice ? ` ${delivery.notice}` : ""}{" "}
            <Link href="/methodology/">Coverage and methodology ↗</Link>
          </>
        ) : (
          "Coverage and dated capture details are pending."
        )}
      </p>
    </div>
  );
}

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
