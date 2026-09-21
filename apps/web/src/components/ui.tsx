"use client";
import { createContext, useContext, useId, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronLeft,
  CloudOff,
  ChevronRight,
  Copy,
  ExternalLink,
  Search,
  Star,
} from "lucide-react";
import {
  compact,
  displayEth,
  formatMoney,
  identityTint,
  shortAddress,
  type PricePoint,
} from "@pools/core";
import { useEthPrice } from "./eth-price-provider";
import { useUnit, useWatchlist } from "./state";

export function TokenIcon({
  pool,
  size = "normal",
}: {
  pool: { color: string; mark: string; name: string };
  size?: "normal" | "large" | "small";
}) {
  return (
    <span
      aria-hidden="true"
      className={`token-icon ${size}`}
      style={{ "--token": pool.color } as React.CSSProperties}
    >
      {pool.mark}
    </span>
  );
}
/**
 * The identity tile where no image exists: the export's two-character
 * monogram on the address's own tint, so no row carries the accent. The
 * letters are decoration drawn by the stylesheet from `data-initials`, so a
 * cell's text stays the address and nothing else.
 */
export function Avatar({
  address,
  small = false,
  large = false,
}: {
  address: string;
  small?: boolean;
  large?: boolean;
}) {
  const tint = identityTint(address);
  return (
    <span
      aria-hidden="true"
      className={`avatar ${small ? "small" : ""} ${large ? "large" : ""}`}
      data-initials={address.slice(2, 4).toUpperCase()}
      style={
        {
          "--avatar-bg": tint.background,
          "--avatar-fg": tint.foreground,
        } as React.CSSProperties
      }
    />
  );
}
export function CopyButton({
  value,
  label = "Copy address",
  size = 14,
}: {
  value: string;
  label?: string;
  size?: number;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    setTimeout(() => setStatus("idle"), 1800);
  }
  return (
    <span className="copy-wrap">
      <button
        type="button"
        className="icon-button"
        title={status === "copied" ? "Copied" : label}
        aria-label={label}
        onClick={copy}
      >
        {status === "copied" ? <Check size={size} /> : <Copy size={size} />}
      </button>
      <span
        role="status"
        className={status === "idle" ? "sr-only" : "copy-status"}
      >
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy unavailable"
            : ""}
      </span>
    </span>
  );
}
/** Transactions live under a different explorer path than accounts do. */
type ExplorerKind = "address" | "tx";
function ExplorerLink({
  address,
  kind = "address",
  size = 14,
  className,
}: {
  address: string;
  kind?: ExplorerKind;
  size?: number;
  className?: string;
}) {
  return (
    <a
      className={className}
      aria-label={`Open ${kind === "tx" ? "transaction" : "address"} on explorer`}
      href={`https://robinhoodchain.blockscout.com/${kind}/${address}`}
      target="_blank"
      rel="noreferrer"
    >
      <ExternalLink size={size} />
    </a>
  );
}
export function AddressLabel({
  address,
  full = false,
  kind = "address",
}: {
  address: string;
  full?: boolean;
  kind?: ExplorerKind;
}) {
  const subject = kind === "tx" ? "transaction" : "address";
  return (
    <span className="address-label">
      {full ? (
        /* Both forms are in the markup; the stylesheet shows the short one
           only where the full one cannot fit (the wallet header on a phone),
           so the copy control keeps the whole address in either case. */
        <>
          <span className="mono address-full">{address}</span>
          <span className="mono address-short">{shortAddress(address)}</span>
        </>
      ) : (
        <span className="mono">{shortAddress(address)}</span>
      )}
      <CopyButton value={address} label={`Copy ${subject}`} />
      <ExplorerLink address={address} kind={kind} />
    </span>
  );
}
/** An address in a table cell: identicon and both-end truncation opening
    `href`, then copy and explorer, at the row's own height. `stacked` puts
    the two actions under the address for a column too narrow to hold them
    beside it. `badge` sits inline after the address, inside the same
    single-line row height, rather than adding a second line. `size="large"`
    is the export's 28px identity tile: no name field exists anywhere in this
    app, so the short address fills both the primary and secondary line, the
    same fallback the export itself uses for an address without an ENS name.
    Its badge follows the secondary line, as the export sets it, and stacks
    beneath it in a column too narrow to hold both. `avatarSize="monogram"`
    keeps the one-line chip but promotes its shared Avatar to a readable 30px
    monogram. */
export function AddressChip({
  address,
  href,
  stacked = false,
  size = "small",
  avatarSize = "compact",
  badge,
}: {
  address: string;
  href: string;
  stacked?: boolean;
  size?: "small" | "large";
  avatarSize?: "compact" | "monogram";
  badge?: React.ReactNode;
}) {
  return (
    <span
      className="address-chip"
      data-stacked={stacked || undefined}
      data-size={size === "large" ? "large" : undefined}
      data-avatar-size={avatarSize === "monogram" ? "monogram" : undefined}
    >
      <Link className="address-chip-link" href={href} title={address}>
        <Avatar address={address} />
        {size === "large" ? (
          <span className="address-chip-lines">
            <span className="address-chip-name">{shortAddress(address)}</span>
            <span className="address-chip-meta">
              <span className="mono">{shortAddress(address)}</span>
              {badge}
            </span>
          </span>
        ) : (
          <span className="mono">{shortAddress(address)}</span>
        )}
      </Link>
      {size !== "large" && badge}
      <span className="address-chip-actions">
        <CopyButton value={address} size={12} />
        <ExplorerLink address={address} size={12} className="icon-button" />
      </span>
    </span>
  );
}
/**
 * How an unknown datum reads. A table cell stays empty, as the export leaves
 * one; a stat card's value slot carries a quiet mark so its label does not
 * float over nothing. Either way the reason travels in the accessible name.
 */
const UnavailableMark = createContext<"empty" | "quiet">("empty");
export const QuietUnavailable = UnavailableMark.Provider;
/**
 * The attributes of an unavailable slot. A value component spreads them on
 * the same `span` it renders a value into, so the node a skeleton painted is
 * the node the value resolves into and nothing is remounted.
 */
export function useUnavailable(reason: string, pending: boolean) {
  const mark = useContext(UnavailableMark);
  return {
    "data-pending": pending,
    title: pending ? undefined : reason,
    "aria-label": pending ? undefined : `Unavailable: ${reason}`,
    children: pending ? "Pending" : mark === "quiet" ? "\u2013" : "",
  };
}
export function Unavailable({
  reason = "Not collected yet",
  className = "",
  pending = false,
}: {
  reason?: string;
  className?: string;
  pending?: boolean;
}) {
  return (
    <span
      className={`unavailable ${className}`}
      {...useUnavailable(reason, pending)}
    />
  );
}
export function Money({
  wei,
  signed = false,
  className = "",
  pending = false,
}: {
  wei?: string | null;
  signed?: boolean;
  className?: string;
  pending?: boolean;
}) {
  const unavailable = useUnavailable("Not collected yet", pending);
  const { unit } = useUnit();
  const usdPerEth = useEthPrice();
  if (wei == null)
    return (
      <span className={`number unavailable ${className}`} {...unavailable} />
    );
  const colorClass = signed
    ? BigInt(wei) > 0n
      ? "positive"
      : BigInt(wei) < 0n
        ? "negative"
        : "muted"
    : "";
  if (unit === "USD" && usdPerEth !== null)
    return (
      <span
        className={`number ${colorClass} ${className}`}
        title={`${wei} wei`}
      >
        {formatMoney(wei, "USD", usdPerEth, signed)}
      </span>
    );
  return (
    <span className={`number ${colorClass} ${className}`} title={`${wei} wei`}>
      {signed && BigInt(wei) > 0n ? "+" : ""}
      {new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(
        displayEth(wei),
      )}{" "}
      ETH
    </span>
  );
}
export function Price({
  wei,
  pending = false,
}: {
  wei?: string | null;
  pending?: boolean;
}) {
  const unavailable = useUnavailable("No observed swap price", pending);
  const { unit } = useUnit();
  const usdPerEth = useEthPrice();
  if (wei == null)
    return <span className="number price unavailable" {...unavailable} />;
  if (unit === "USD" && usdPerEth !== null) {
    const usd = displayEth(wei) * usdPerEth;
    // Most catalog prices are sub-cent; the same leading-zero notation the
    // ETH form uses below keeps them legible instead of an all-zero column.
    if (usd > 0 && usd < 0.0001) {
      const frac = usd.toFixed(18).slice(2);
      const zeros = frac.match(/^0+/)?.[0].length ?? 0;
      return (
        <span className="number price" title={`$${usd.toPrecision(4)}`}>
          $0.0<sub>{zeros}</sub>
          {frac.slice(zeros, zeros + 4)}
        </span>
      );
    }
    return (
      <span className="number price" title={`${wei} wei`}>
        {formatMoney(wei, "USD", usdPerEth)}
      </span>
    );
  }
  const currency = "ETH";
  const value = displayEth(wei);
  const prefix = "";
  if (value > 0 && value < 0.0001) {
    const str = BigInt(wei).toString().padStart(18, "0");
    const zeros = str.match(/^0+/)?.[0].length ?? 0;
    return (
      <span
        className="number price"
        title={`${value.toPrecision(8)} ${currency}`}
      >
        {prefix}0.0<sub>{zeros}</sub>
        {str.slice(zeros, zeros + 4)}
        {currency === "ETH" && <small> ETH</small>}
      </span>
    );
  }
  return (
    <span className="number price" title={`${value} ${currency}`}>
      {prefix}
      {value.toLocaleString("en-US", { maximumSignificantDigits: 4 })}
      {currency === "ETH" && <small> ETH</small>}
    </span>
  );
}
/** Four integer digits ("+9999.99%") are the widest fixed figure the trader
    leaderboard's 104px ROI column holds; from here the abbreviated form
    takes over where a surface asks for it. */
const ABBREVIATE_CHANGE_FROM = 10_000;

export function Change({
  value,
  pending = false,
  digits = 2,
  abbreviate = false,
}: {
  value?: number | null;
  pending?: boolean;
  digits?: number;
  /** Render a figure of 10,000% and over in the site's K/M notation
      (`+457.3M%`), sign, colour and unit kept, with the exact fixed figure
      in the element's `title`; a smaller figure renders as it would
      without it. */
  abbreviate?: boolean;
}) {
  const unavailable = useUnavailable("No opening price observation", pending);
  if (value == null)
    return <span className="number change unavailable" {...unavailable} />;
  const displayed = Number(value.toFixed(digits));
  const sign = displayed > 0 ? "+" : "";
  const exact = displayed.toFixed(digits);
  const abbreviated =
    abbreviate && Math.abs(displayed) >= ABBREVIATE_CHANGE_FROM;
  // The figure stays split into sign, digits and unit rather than one
  // string: the pending state above is a lone "Pending" text node, and a
  // lone string here would make React rewrite that node in place, which
  // Chrome scores as a layout shift in every right-aligned cell; separate
  // children mount as new nodes instead, which it never scores.
  return (
    <span
      className={`number change ${displayed > 0 ? "positive" : displayed < 0 ? "negative" : "muted"}`}
      title={abbreviated ? `${sign}${exact}%` : undefined}
    >
      {sign}
      {abbreviated ? compact(value, 1) : exact}%
    </span>
  );
}
export function ModeBadge({ mode }: { mode: "instant" | "crowd" }) {
  return (
    <span className={`badge ${mode === "crowd" ? "lavender" : ""}`}>
      {mode === "crowd" ? "Crowd" : "Instant"}
    </span>
  );
}
export function WatchButton({ id }: { id: string }) {
  const { ids, toggle } = useWatchlist();
  const active = ids.includes(id);
  return (
    <button
      className={`icon-button watch ${active ? "active" : ""}`}
      aria-label={active ? "Remove from watchlist" : "Add to watchlist"}
      aria-pressed={active}
      onClick={() => toggle(id)}
    >
      <Star size={16} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
export function PeriodTabs({
  value,
  onChange,
}: {
  value: "24h" | "7d";
  onChange: (value: "24h" | "7d") => void;
}) {
  return (
    <div className="segmented" aria-label="Time period">
      {(["24h", "7d"] as const).map((w) => (
        <button
          key={w}
          onClick={() => onChange(w)}
          aria-pressed={w === value}
          className={w === value ? "selected" : ""}
        >
          {w === "7d" ? "7D" : "24H"}
        </button>
      ))}
    </div>
  );
}
export function EmptyState({
  title = "No results found",
  description,
  action,
  symbol,
  alert = false,
}: {
  title?: string;
  description: string;
  action?: React.ReactNode;
  /** The magnifier suits a search that found nothing; an outage has its own. */
  symbol?: React.ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="empty-state" role={alert ? "alert" : undefined}>
      <span className="empty-symbol">{symbol ?? <Search size={25} />}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
/**
 * What a list shows when its read could not be served: its own name, one line
 * telling the reader to come back, and not a single figure. It never stands in
 * a stored or preloaded number for the one the read API owes, and it carries
 * no as-of line to make an old number acceptable.
 */
export function UnavailableState({
  subject,
  onRetry,
}: {
  /** The thing that is unavailable, capitalised: "Pools", "Leaderboard". */
  subject: string;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      alert
      symbol={<CloudOff size={25} />}
      title={`${subject} unavailable`}
      description="Try again shortly."
      action={
        onRetry && (
          <button type="button" className="button secondary" onClick={onRetry}>
            Try again
          </button>
        )
      }
    />
  );
}
export function Pagination({
  total,
  page,
  pageSize,
  onChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>
        {total
          ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}`
          : "0 results"}
      </span>
      <div>
        <button
          className="icon-button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span>
          {page} / {pages}
        </span>
        <button
          className="icon-button"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
function geometry(
  points: PricePoint[],
  width: number,
  height: number,
  padding = 0,
  stepped = false,
  usdPerEth?: number,
) {
  const values = points.map((p) => displayEth(p.wei) * (usdPerEth ?? 1));
  const min = Math.min(...values),
    max = Math.max(...values);
  const span = max - min || Math.abs(max) * 0.1 || 1;
  const firstTime = points[0]?.time ?? 0;
  const lastTime = points.at(-1)?.time ?? firstTime + 1;
  const x = (i: number) =>
    padding +
    (((points[i]?.time ?? firstTime) - firstTime) /
      Math.max(1, lastTime - firstTime)) *
      (width - padding * 2);
  const y = (v: number) =>
    height - padding - ((v - min) / span) * (height - padding * 2);
  return {
    values,
    min,
    max,
    x,
    y,
    path: values
      .map((v, i) =>
        i > 0 && stepped
          ? `H${x(i).toFixed(2)}V${y(v).toFixed(2)}`
          : `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`,
      )
      .join(" "),
  };
}
export function Chart({
  points,
  label = "Price",
  profit = false,
  pending = false,
  emptyNote = "No realized PnL in this window.",
}: {
  points: PricePoint[];
  label?: string;
  profit?: boolean;
  pending?: boolean;
  /** The line under an empty chart once its read has resolved. */
  emptyNote?: string;
}) {
  const gradient = useId().replace(/:/g, "");
  const { unit } = useUnit();
  const usdPerEth = useEthPrice();
  const showUsd = unit === "USD" && usdPerEth !== null;
  const last = BigInt(points.at(-1)?.wei ?? "0");
  const chartColor = profit
    ? last > 0n
      ? "var(--green)"
      : last < 0n
        ? "var(--red)"
        : "var(--muted)"
    : "var(--accent)";
  const [hover, setHover] = useState<number | null>(null);
  const g = geometry(
    points,
    820,
    230,
    8,
    profit,
    showUsd ? usdPerEth : undefined,
  );
  const axisLabel = (v: number) =>
    showUsd ? `${v < 0 ? "-" : ""}$${compact(Math.abs(v))}` : compact(v);
  const index =
    hover === null ? points.length - 1 : Math.min(hover, points.length - 1);
  const point = points[Math.max(0, index)];
  const dates = [
    points[0],
    points[Math.floor(points.length / 3)],
    points[Math.floor((points.length * 2) / 3)],
    points.at(-1)!,
  ];
  const known = dates.filter((p): p is PricePoint => !!p);
  // A tick reads as a date so a viewer can place it in time; once every tick
  // already falls on the same UTC day, the date says nothing new and the
  // time is the informative part instead.
  const oneDay =
    known.length > 1 &&
    known.every(
      (p) => Math.floor(p.time / 86400) === Math.floor(known[0].time / 86400),
    );
  return (
    <div className="chart" aria-busy={pending}>
      <div className="chart-readout">
        <span className="muted">{label}</span>
        <strong>
          {/* The quiet mark, as a stat card's value slot: an empty slot has
              no line box, and the row's baseline-aligned label and date
              would move up once "Pending" resolves to nothing. */}
          <QuietUnavailable value="quiet">
            {profit ? (
              <Money wei={point?.wei} signed pending={pending} />
            ) : (
              <Price wei={point?.wei} pending={pending} />
            )}
          </QuietUnavailable>
        </strong>
        <time>
          {point
            ? new Date(point.time * 1000).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
              }) + " UTC"
            : pending
              ? "Observation pending"
              : "No observations"}
        </time>
      </div>
      <div className="chart-frame">
        <svg
          viewBox="0 0 820 230"
          preserveAspectRatio="none"
          tabIndex={0}
          role="img"
          aria-label={`${label} chart. Use left and right arrow keys to inspect observations.`}
          onKeyDown={(e) => {
            if (
              points.length &&
              (e.key === "ArrowLeft" || e.key === "ArrowRight")
            ) {
              e.preventDefault();
              setHover(
                Math.max(
                  0,
                  Math.min(
                    points.length - 1,
                    index + (e.key === "ArrowRight" ? 1 : -1),
                  ),
                ),
              );
            }
          }}
          onPointerMove={(e) => {
            if (!points.length) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const fraction = Math.max(
              0,
              Math.min(1, (e.clientX - rect.left) / rect.width),
            );
            const targetTime =
              points[0].time +
              fraction * (points.at(-1)!.time - points[0].time);
            let nearest = 0;
            for (let i = 1; i < points.length; i++)
              if (
                Math.abs(points[i].time - targetTime) <
                Math.abs(points[nearest].time - targetTime)
              )
                nearest = i;
            setHover(nearest);
          }}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chartColor} stopOpacity="0.16" />
              <stop offset="100%" stopColor={chartColor} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3].map((n) => (
            <line
              key={n}
              x1="0"
              x2="820"
              y1={8 + n * 71}
              y2={8 + n * 71}
              stroke="var(--line)"
              strokeDasharray="3 5"
            />
          ))}
          <path
            d={points.length ? `${g.path} L812,230 L8,230 Z` : ""}
            fill={`url(#${gradient})`}
          />
          <path
            d={g.path}
            fill="none"
            stroke={chartColor}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null && !!point && (
            <>
              <line
                x1={g.x(index)}
                x2={g.x(index)}
                y1="0"
                y2="230"
                stroke="var(--muted)"
                strokeDasharray="4 4"
              />
              <circle
                cx={g.x(index)}
                cy={g.y(g.values[index])}
                r="4"
                fill={chartColor}
              />
            </>
          )}
        </svg>
        {/* A tick names a figure the series holds, or nothing: a series with
            no points has no scale to label, and the note under the chart
            already says so, so the ticks keep their line boxes and stay
            blank rather than printing a stand-in. */}
        <div className="chart-axis">
          {[g.max, (g.max + g.min) / 2, g.min].map((v, i) => (
            <span key={i} data-pending={pending}>
              {points.length ? axisLabel(v) : pending ? "Pending" : "\u00a0"}
            </span>
          ))}
        </div>
      </div>
      <div className="chart-dates">
        {dates.map((p, i) => (
          <span key={i}>
            {p
              ? oneDay
                ? new Date(p.time * 1000).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: "UTC",
                  })
                : new Date(p.time * 1000).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })
              : pending
                ? "Pending"
                : "\u00a0"}
          </span>
        ))}
      </div>
      <p className="chart-empty-note" data-pending={pending}>
        {point
          ? "\u00a0"
          : pending
            ? "Loading saved PnL observations"
            : emptyNote}
      </p>
    </div>
  );
}
