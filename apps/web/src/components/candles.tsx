"use client";
import { useState } from "react";
import type { ChainMarket, ChainSnapshot } from "@pools/core";
import { Price } from "./ui";
import { Eth, utc } from "./live-ui";
const ranges = {
  "5m": 300,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "1W": 604800,
};
export function Candles({
  market,
  snapshot,
}: {
  market: ChainMarket;
  snapshot: ChainSnapshot;
}) {
  const [range, setRange] = useState<keyof typeof ranges>("1h");
  const [focused, setFocused] = useState<number | null>(null);
  const from = snapshot.toTimestamp - ranges[range],
    interval = Math.max(5, Math.ceil(ranges[range] / 60));
  const buckets = new Map<
    number,
    {
      time: number;
      open: bigint;
      close: bigint;
      high: bigint;
      low: bigint;
      volume: bigint;
    }
  >();
  for (const p of market.series.filter((p) => p.time >= from)) {
    const time = Math.floor(p.time / interval) * interval,
      value = BigInt(p.wei),
      old = buckets.get(time);
    if (old) {
      old.close = value;
      old.high = old.high > value ? old.high : value;
      old.low = old.low < value ? old.low : value;
    } else
      buckets.set(time, {
        time,
        open: value,
        close: value,
        high: value,
        low: value,
        volume: 0n,
      });
  }
  for (const t of snapshot.trades.filter(
    (t) => t.poolId === market.id && t.timestamp >= from,
  )) {
    const bucket = buckets.get(Math.floor(t.timestamp / interval) * interval);
    if (bucket) bucket.volume += BigInt(t.ethWei);
  }
  const bars = [...buckets.values()].sort((a, b) => a.time - b.time),
    max = Math.max(...bars.map((b) => Number(b.high)), 1),
    min = Math.min(...bars.map((b) => Number(b.low)), max),
    span = max - min || max * 0.05 || 1,
    maxVol = Math.max(...bars.map((b) => Number(b.volume)), 1);
  const y = (v: bigint) => 14 + (1 - (Number(v) - min) / span) * 185,
    step = 720 / Math.max(bars.length, 1);
  const active =
    bars[
      focused === null ? bars.length - 1 : Math.min(focused, bars.length - 1)
    ];
  return (
    <div className="live-candles">
      <div className="live-controls">
        <strong>Observed spot-price candles</strong>
        <div className="segmented" aria-label="Chart range">
          {Object.keys(ranges).map((r) => (
            <button
              key={r}
              aria-pressed={range === r}
              onClick={() => {
                setRange(r as keyof typeof ranges);
                setFocused(null);
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {active ? (
        <>
          <div className="candle-readout">
            <span>{utc(active.time)}</span>
            <span>
              O <Price wei={active.open.toString()} />
            </span>
            <span>
              H <Price wei={active.high.toString()} />
            </span>
            <span>
              L <Price wei={active.low.toString()} />
            </span>
            <span>
              C <Price wei={active.close.toString()} />
            </span>
            <span>
              Volume <Eth wei={active.volume.toString()} />
            </span>
          </div>
          <div className="candle-frame">
            <svg
              viewBox="0 0 740 280"
              role="img"
              aria-label="Observed spot-price candle chart with ETH volume bars. Arrow keys inspect candles."
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  setFocused(
                    Math.min(
                      bars.length - 1,
                      Math.max(
                        0,
                        (focused ?? bars.length - 1) +
                          (e.key === "ArrowRight" ? 1 : -1),
                      ),
                    ),
                  );
                }
              }}
            >
              {[14, 76, 138, 200].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="740"
                  y1={y}
                  y2={y}
                  stroke="var(--line)"
                  strokeDasharray="3 5"
                />
              ))}
              {bars.map((b, i) => {
                const color = b.close >= b.open ? "var(--green)" : "var(--red)",
                  x = 10 + step * (i + 0.5);
                return (
                  <g key={b.time} onPointerEnter={() => setFocused(i)}>
                    <title>
                      {`${utc(b.time)} · close ${Number(b.close) / 1e18} ETH`}
                    </title>
                    <rect
                      x={x - step / 2}
                      y="0"
                      width={step}
                      height="280"
                      fill="transparent"
                    />
                    <line
                      x1={x}
                      x2={x}
                      y1={y(b.high)}
                      y2={y(b.low)}
                      stroke={color}
                    />
                    <rect
                      x={x - Math.min(step * 0.6, 18) / 2}
                      width={Math.min(step * 0.6, 18)}
                      y={Math.min(y(b.open), y(b.close))}
                      height={Math.max(2, Math.abs(y(b.open) - y(b.close)))}
                      fill={color}
                    />
                    <rect
                      x={x - Math.min(step * 0.6, 18) / 2}
                      width={Math.min(step * 0.6, 18)}
                      y={275 - (Number(b.volume) / maxVol) * 55}
                      height={Math.max(1, (Number(b.volume) / maxVol) * 55)}
                      fill={color}
                      opacity="0.4"
                    />
                  </g>
                );
              })}
            </svg>
            <div className="candle-axis">
              {[max, (max + min) / 2, min].map((v, i) => (
                <Price key={i} wei={BigInt(Math.round(v)).toString()} />
              ))}
            </div>
          </div>
          <p className="panel-footnote">
            {interval}s buckets from post-swap spot observations. Empty buckets
            are omitted; no price movement is invented between swaps.
          </p>
        </>
      ) : (
        <div className="empty-state">
          <h3>No price observations in this range</h3>
          <p>
            Choose a longer range. This does not mean the token price is zero.
          </p>
        </div>
      )}
    </div>
  );
}
