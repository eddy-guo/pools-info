"use client";
import { useId, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Search,
  Star,
} from "lucide-react";
import {
  compact,
  displayEth,
  shortAddress,
  visualTheme,
  type PricePoint,
} from "@pools/core";
import { useWatchlist } from "./state";

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
export function Avatar({
  address,
  color = visualTheme.accent,
  small = false,
}: {
  address: string;
  color?: string;
  small?: boolean;
}) {
  const bits = address
    .slice(2, 11)
    .split("")
    .map((x) => parseInt(x, 16) % 2 === 0);
  return (
    <span
      aria-hidden="true"
      className={`avatar ${small ? "small" : ""}`}
      style={{ "--token": color } as React.CSSProperties}
    >
      <svg viewBox="0 0 5 5">
        {Array.from({ length: 25 }, (_, i) => {
          const col = i % 5;
          const row = Math.floor(i / 5);
          return bits[(row * 3 + Math.min(col, 4 - col)) % bits.length] ? (
            <rect
              key={i}
              x={col}
              y={row}
              width="1"
              height="1"
              fill="currentColor"
            />
          ) : null;
        })}
      </svg>
    </span>
  );
}
export function CopyButton({
  value,
  label = "Copy address",
}: {
  value: string;
  label?: string;
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
        {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
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
export function AddressLabel({
  address,
  full = false,
  kind = "address",
}: {
  address: string;
  full?: boolean;
  /** Transactions live under a different explorer path than accounts do. */
  kind?: "address" | "tx";
}) {
  const subject = kind === "tx" ? "transaction" : "address";
  return (
    <span className="address-label">
      <span className="mono">{full ? address : shortAddress(address)}</span>
      <CopyButton value={address} label={`Copy ${subject}`} />
      {
        <a
          aria-label={`Open ${subject} on explorer`}
          href={`https://robinhoodchain.blockscout.com/${kind}/${address}`}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={14} />
        </a>
      }
    </span>
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
  if (wei == null)
    return (
      <span
        className={`number muted unavailable ${className}`}
        data-pending={pending}
      >
        {pending ? "Pending" : "N/A"}
      </span>
    );
  return (
    <span
      className={`number ${signed ? (BigInt(wei) > 0n ? "positive" : BigInt(wei) < 0n ? "negative" : "muted") : ""} ${className}`}
      title={`${wei} wei`}
    >
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
  if (wei == null)
    return (
      <span
        className="number price muted unavailable"
        data-pending={pending}
        title="No observed swap price"
        aria-label={pending ? undefined : "Unavailable: No observed swap price"}
      >
        {pending ? "Pending" : "N/A"}
      </span>
    );
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
export function Change({
  value,
  pending = false,
  digits = 2,
}: {
  value?: number | null;
  pending?: boolean;
  digits?: number;
}) {
  if (value == null)
    return (
      <span
        className="number change muted unavailable"
        data-pending={pending}
        title="No opening price observation"
        aria-label={
          pending ? undefined : "Unavailable: No opening price observation"
        }
      >
        {pending ? "Pending" : "N/A"}
      </span>
    );
  const displayed = Number(value.toFixed(digits));
  return (
    <span
      className={`number change ${displayed > 0 ? "positive" : displayed < 0 ? "negative" : "muted"}`}
    >
      {displayed > 0 ? "+" : ""}
      {displayed.toFixed(digits)}%
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
}: {
  title?: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">
        <Search size={25} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
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
) {
  const values = points.map((p) => displayEth(p.wei));
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
export function Sparkline({
  points,
  positive = true,
}: {
  points: PricePoint[];
  positive?: boolean;
}) {
  const limited = points.filter(
    (_, i) => i % Math.max(1, Math.floor(points.length / 24)) === 0,
  );
  const g = geometry(limited, 100, 32, 2);
  const neutral = limited.length < 2 || limited[0].wei === limited.at(-1)?.wei;
  return (
    <svg
      className={`sparkline ${neutral ? "muted" : positive ? "positive" : "negative"}`}
      viewBox="0 0 100 32"
      role="img"
      aria-label={
        neutral
          ? "No price movement observed"
          : `${positive ? "Rising" : "Falling"} price trend`
      }
    >
      <path
        d={g.path}
        stroke="currentColor"
        strokeWidth="1.7"
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function Chart({
  points,
  label = "Price",
  profit = false,
  pending = false,
}: {
  points: PricePoint[];
  label?: string;
  profit?: boolean;
  pending?: boolean;
}) {
  const gradient = useId().replace(/:/g, "");
  const last = BigInt(points.at(-1)?.wei ?? "0");
  const chartColor = profit
    ? last > 0n
      ? "var(--green)"
      : last < 0n
        ? "var(--red)"
        : "var(--muted)"
    : "var(--accent)";
  const [hover, setHover] = useState<number | null>(null);
  const g = geometry(points, 820, 230, 8, profit);
  const index =
    hover === null ? points.length - 1 : Math.min(hover, points.length - 1);
  const point = points[Math.max(0, index)];
  const dates = [
    points[0],
    points[Math.floor(points.length / 3)],
    points[Math.floor((points.length * 2) / 3)],
    points.at(-1)!,
  ];
  return (
    <div className="chart" aria-busy={pending}>
      <div className="chart-readout">
        <span className="muted">{label}</span>
        <strong>
          {profit ? (
            <Money wei={point?.wei} signed pending={pending} />
          ) : (
            <Price wei={point?.wei} pending={pending} />
          )}
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
        <div className="chart-axis">
          {[g.max, (g.max + g.min) / 2, g.min].map((v, i) => (
            <span key={i} data-pending={pending}>
              {points.length ? compact(v) : pending ? "Pending" : "N/A"}
            </span>
          ))}
        </div>
      </div>
      <div className="chart-dates">
        {dates.map((p, i) => (
          <span key={i}>
            {p
              ? new Date(p.time * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })
              : pending
                ? "Pending"
                : "N/A"}
          </span>
        ))}
      </div>
      <p className="chart-empty-note" data-pending={pending}>
        {point
          ? "\u00a0"
          : pending
            ? "Loading saved PnL observations"
            : "No realized PnL in this window."}
      </p>
    </div>
  );
}
