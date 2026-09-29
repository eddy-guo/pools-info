"use client";
import { Fragment } from "react";
import { since } from "@pools/core";
import { useNowSeconds } from "@/lib/clock";
import {
  freshnessStamp,
  stampBlock,
  stampLag,
  useFreshnessCut,
} from "@/lib/freshness";
import { utc } from "./live-ui";

/**
 * The site-wide freshness stamp in the header's network strip: the page's
 * own read cut as `block N · indexed Ns ago` (the block, set in mono as the
 * export draws it, only where the read names one), blank while no mounted
 * page has reported a cut. Its slot reserves the widest form's width from
 * first paint and every reading mounts as new nodes inside it, so neither
 * the stamp's arrival nor a later tick moves anything: Chrome scores a
 * rewritten text node whose start moves, never a freshly inserted one. The
 * divider before it hides with it, keeping its width, so no page paints
 * `v4 · Robinhood Chain |` with nothing after the bar.
 */
export function SubnavFreshness() {
  const cut = useFreshnessCut();
  const now = useNowSeconds();
  const reading = cut !== null && now !== null ? { cut, now } : null;
  return (
    <>
      <span
        className="subnav-divider subnav-freshness-divider"
        aria-hidden="true"
        style={{ visibility: reading ? "visible" : "hidden" }}
      />
      <span className="subnav-freshness">
        {reading && (
          <Fragment key={freshnessStamp(reading.cut, reading.now)}>
            {reading.cut.block !== null && (
              <>
                <span className="subnav-block">
                  {stampBlock(reading.cut.block)}
                </span>
                {" · "}
              </>
            )}
            <time
              dateTime={new Date(reading.cut.asOf * 1000).toISOString()}
              title={utc(reading.cut.asOf)}
            >
              {stampLag(reading.cut.asOf, reading.now)}
            </time>
          </Fragment>
        )}
      </span>
    </>
  );
}

/**
 * A panel's own stamp, for a surface whose cut is not the page's: the
 * Following activity feed (its explorer read's generation time) and the
 * wallet's Trades tab (its explorer page's fetch time). `at` is that read's
 * own timestamp in Unix seconds, null until it answers; `failed` leaves the
 * row wordless once nothing was served, never an as-of line, while its
 * label keeps its box so nothing beside it moves. The figure is read
 * against the shared clock and keyed by its text, so each new reading
 * mounts as a new node inside the slot's fixed width rather than moving
 * the right-aligned text's start.
 */
export function UpdatedStamp({
  at,
  failed = false,
  status,
  className,
}: {
  at: number | null;
  failed?: boolean;
  /** A note the panel shows at the row's left, such as a refresh failure. */
  status?: React.ReactNode;
  className?: string;
}) {
  const now = useNowSeconds();
  const ago = at === null || now === null ? null : since(at, now);
  return (
    <div
      className={
        className
          ? `wallet-positions-context ${className}`
          : "wallet-positions-context"
      }
    >
      {status}
      <span
        style={{ visibility: failed && at === null ? "hidden" : undefined }}
      >
        Updated
      </span>
      <strong data-pending={ago === null && !failed}>
        {at === null || ago === null ? (
          failed ? (
            " "
          ) : (
            "Pending"
          )
        ) : (
          <Fragment key={`${at}:${ago}`}>
            <time dateTime={new Date(at * 1000).toISOString()} title={utc(at)}>
              {ago}
            </time>{" "}
            ago
          </Fragment>
        )}
      </strong>
    </div>
  );
}
