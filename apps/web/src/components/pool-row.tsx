"use client";
import Link from "next/link";
import {
  shortAddress,
  since,
  windows,
  type AnalyticsPoolRow,
  type LiveWindow,
} from "@pools/core";
import { tokenSubSymbol } from "@/lib/token-identity";
import { countLabel } from "@/lib/plural";
import { Change, CrowdLine } from "./ui";
import { utc } from "./live-ui";
import { launchOnly } from "./product-common";

/*
 * A catalogue row's cells beside `PoolCell` (product-common.tsx), shared by
 * the screener (`product-explore.tsx`) and the You page's watchlist: each
 * keeps the screener's own geometry rules (see the notes on each), so a pool
 * reads the same wherever it is listed.
 */
/**
 * The table row's subtitle, as the export sets it: the symbol in mono, the
 * pool's age and (on desktop) its trade count in the window, separated by
 * middle dots. A launch without market evidence keeps its symbol alone (its
 * launch line carries the age), and a figure the read API does not send is
 * left out rather than marked. The phone row keeps only the age (`trades`
 * false) to hold its identity tile to `SYMBOL · age`.
 *
 * Symbol and age never truncate: PR #141's deliberate 132/112/140/190px
 * right-hand tracks (kept as designed, never narrowed back) leave the Token
 * column under the trade count's own width across roughly 1163-1245px of
 * table width. Rather than let the browser's ellipsis cut the trailing
 * segment off mid-number, `.row-subtitle-trades` drops out there as a whole
 * unit (its leading " · " with it) - the same compact `SYMBOL · age` shape
 * the phone row already uses, not a half-abbreviated count: a pool with a
 * short trade count (page one's actual worst case, a long symbol with a
 * single-digit count) gains nothing from abbreviating "7" to anything
 * shorter, so only dropping the segment is correct for every row, not just
 * the ones with a large count to abbreviate. The full line still reaches
 * assistive tech through its text and a mouse hover through its title, so
 * nothing is lost, only not shown at every width. A crowd launch's line
 * carries the CROWD chip after it (`CrowdLine`), which never truncates.
 */
export function RowSubtitle({
  pool,
  now,
  trades = true,
}: {
  pool: AnalyticsPoolRow;
  now: number | null;
  trades?: boolean;
}) {
  const age =
    launchOnly(pool) || now === null ? null : since(pool.launchedAt, now);
  const tradeCount =
    launchOnly(pool) || !trades || pool.stats.trades === null
      ? null
      : countLabel(pool.stats.trades, "trade");
  const symbol = tokenSubSymbol(pool);
  const full = [symbol, age, tradeCount].filter(Boolean).join(" · ");
  /* Each part after the first carries its own leading separator, so a token
     without a symbol never opens on a dot. While nothing is known yet (a
     nameless token before the age resolves) the line holds its height. */
  return (
    <CrowdLine launchType={pool.launchType}>
      <span className="row-subtitle" title={full}>
        {symbol && <span className="mono">{symbol}</span>}
        {age && (
          <span>
            {symbol && " · "}
            {age}
          </span>
        )}
        {tradeCount && (
          <span className="row-subtitle-trades">
            {(symbol || age) && " · "}
            {tradeCount}
          </span>
        )}
        {!full && <span aria-hidden="true">{"\u00a0"}</span>}
      </span>
    </CrowdLine>
  );
}
export function LaunchLine({
  pool,
  now,
}: {
  pool: AnalyticsPoolRow;
  now: number | null;
}) {
  return (
    <span className="launch-line">
      Launched{" "}
      <time
        data-pending={now === null}
        dateTime={new Date(pool.launchedAt * 1000).toISOString()}
        title={utc(pool.launchedAt)}
      >
        {now === null ? "Pending" : since(pool.launchedAt, now)}
      </time>{" "}
      ago
      <span aria-hidden="true"> · </span>
      <Link
        href={`/wallet/${pool.launchSender.toLowerCase()}/`}
        className="mono"
      >
        {shortAddress(pool.launchSender)}
      </Link>
    </span>
  );
}
/**
 * A missing comparison is only labelled as new when the launch timestamp
 * proves that the pool did not exist at the selected window's baseline.
 * Older rows keep Change's unavailable state because their missing value can
 * have another cause. The API remains the only source of percentage figures.
 */
export function PoolChange({
  pool,
  window,
  now,
}: {
  pool: AnalyticsPoolRow;
  window: LiveWindow;
  now: number | null;
}) {
  if (pool.stats.change !== null) return <Change value={pool.stats.change} />;
  const span = windows[window];
  const asOf = now;
  if (asOf === null || !Number.isFinite(span)) return <Change value={null} />;
  const ageSeconds = asOf - pool.launchedAt;
  if (ageSeconds < 0 || ageSeconds >= span) return <Change value={null} />;
  const age = since(pool.launchedAt, asOf);
  return (
    <span
      className="number change-age muted"
      title={`Launched ${age} ago - no ${window} baseline yet`}
    >
      <span aria-hidden="true">
        new · <span key={age}>{age}</span>
      </span>
      <span className="sr-only">{`No ${window} change yet; launched ${age} ago`}</span>
    </span>
  );
}
