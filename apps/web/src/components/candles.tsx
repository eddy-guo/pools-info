"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type Time,
} from "lightweight-charts";
import {
  buildCandles,
  candleIntervals,
  candleValue,
  type ChainMarket,
  type ChainSnapshot,
} from "@pools/core";
import { Price } from "./ui";
import { Eth, utc } from "./live-ui";
const ranges = {
  "5m": 300,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "1W": 604800,
  All: Infinity,
};
function axisPrice(value: number) {
  if (!Number.isFinite(value)) return "N/A";
  if (value === 0) return "0";
  if (Math.abs(value) >= 0.001)
    return new Intl.NumberFormat("en-US", {
      maximumSignificantDigits: 5,
      notation: Math.abs(value) >= 1000 ? "compact" : "standard",
    }).format(value);
  const zeros = Math.max(0, -Math.floor(Math.log10(Math.abs(value))) - 1);
  const digits = (Math.abs(value) * 10 ** (zeros + 1))
    .toPrecision(4)
    .replace(".", "");
  return `${value < 0 ? "-" : ""}0.0${String(zeros)
    .split("")
    .map((n) => "₀₁₂₃₄₅₆₇₈₉"[Number(n)])
    .join("")}${digits}`;
}
export function Candles({
  market,
  snapshot,
}: {
  market: ChainMarket;
  snapshot: ChainSnapshot;
}) {
  const [interval, setInterval] = useState<keyof typeof candleIntervals>("1m"),
    [metric, setMetric] = useState<"Price" | "FDV">("Price"),
    [range, setRange] = useState<keyof typeof ranges>("All"),
    [focused, setFocused] = useState<number>();
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<{
    chart: IChartApi;
    price: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
  } | null>(null);
  const bars = useMemo(
    () => buildCandles(market, snapshot, candleIntervals[interval]),
    [market, snapshot, interval],
  );
  const active = bars.find((b) => b.time === focused) ?? bars.at(-1);
  const viewKey = `${market.id}:${range}:${interval}`;
  const previousView = useRef("");
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#171719" },
        textColor: "#a3a0aa",
        fontFamily: "system-ui",
        fontSize: 11,
        attributionLogo: true,
        panes: {
          separatorColor: "#2a292e",
          separatorHoverColor: "#51434c",
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: "#242329" },
        horzLines: { color: "#242329" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a292e" },
      timeScale: {
        borderColor: "#2a292e",
        timeVisible: true,
        secondsVisible: true,
      },
      localization: {
        locale: "en-US",
        timeFormatter: (t: Time) =>
          typeof t === "number" ? utc(t) : String(t),
      },
      handleScroll: { vertTouchDrag: false },
    });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: "#8bddb6",
      downColor: "#ed8e9f",
      wickUpColor: "#8bddb6",
      wickDownColor: "#ed8e9f",
      borderVisible: false,
      priceFormat: {
        type: "custom",
        minMove: 1,
        formatter: (v: number) => axisPrice(v / 1e18),
      },
    });
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    chart.panes()[1].setHeight(90);
    chart.subscribeCrosshairMove((p) =>
      setFocused(typeof p.time === "number" ? p.time : undefined),
    );
    api.current = { chart, price, volume };
    return () => {
      api.current = null;
      previousView.current = "";
      chart.remove();
    };
  }, []);
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const previous = a.chart.timeScale().getVisibleLogicalRange();
    a.price.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        open: Number(candleValue(b.open, market, metric)),
        high: Number(candleValue(b.high, market, metric)),
        low: Number(candleValue(b.low, market, metric)),
        close: Number(candleValue(b.close, market, metric)),
      })),
    );
    a.volume.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: Number(b.volume) / 1e18,
        color: b.close >= b.open ? "#8bddb655" : "#ed8e9f55",
      })),
    );
    a.chart.applyOptions({ timeScale: { secondsVisible: interval === "1s" } });
    if (bars.length) {
      if (previousView.current !== viewKey) {
        if (range === "All") {
          a.chart.timeScale().fitContent();
          if (bars.length < 40)
            a.chart
              .timeScale()
              .setVisibleLogicalRange({
                from: bars.length - 40,
                to: bars.length + 3,
              });
        } else
          a.chart.timeScale().setVisibleRange({
            from: Math.max(
              bars[0].time,
              snapshot.toTimestamp - ranges[range],
            ) as UTCTimestamp,
            to: Math.max(
              bars[0].time + 1,
              snapshot.toTimestamp,
            ) as UTCTimestamp,
          });
      } else if (previous) a.chart.timeScale().setVisibleLogicalRange(previous);
    }
    previousView.current = viewKey;
  }, [bars, metric, market, range, interval, snapshot.toTimestamp, viewKey]);
  return (
    <div className="live-candles">
      <div className="live-controls chart-toolbar">
        <strong>
          {metric} <small>ETH</small>
        </strong>
        <div className="chart-selects">
          <label>
            Display
            <select
              aria-label="Chart display"
              value={metric}
              onChange={(e) => setMetric(e.target.value as typeof metric)}
            >
              <option>Price</option>
              <option>FDV</option>
            </select>
          </label>
          <label>
            Candle interval
            <select
              aria-label="Candle interval"
              value={interval}
              onChange={(e) => {
                setInterval(e.target.value as typeof interval);
                setFocused(undefined);
              }}
            >
              {Object.keys(candleIntervals).map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="candle-readout" aria-live="off">
        {active ? (
          <>
            <span>{utc(active.time)}</span>
            {(
              [
                ["O", active.open],
                ["H", active.high],
                ["L", active.low],
                ["C", active.close],
              ] as const
            ).map(([name, value]) => (
              <span key={name}>
                {name}{" "}
                {metric === "Price" ? (
                  <Price wei={value.toString()} />
                ) : (
                  <Eth wei={candleValue(value, market, metric).toString()} />
                )}
              </span>
            ))}
            <span>
              V <Eth wei={active.volume.toString()} />
            </span>
          </>
        ) : (
          <span>No observed candles in the loaded history</span>
        )}
      </div>
      <div
        className="interactive-chart"
        ref={container}
        role="img"
        aria-label={`${metric} candle chart with ETH volume. Drag to pan, scroll to zoom, arrow keys to inspect.`}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key !== "ArrowRight" && e.key !== "ArrowLeft") || !bars.length)
            return;
          e.preventDefault();
          const i = Math.max(
            0,
            bars.findIndex((b) => b.time === (focused ?? bars.at(-1)?.time)),
          );
          const b =
            bars[
              Math.min(
                bars.length - 1,
                Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
              )
            ];
          setFocused(b.time);
          if (api.current)
            api.current.chart.setCrosshairPosition(
              Number(candleValue(b.close, market, metric)),
              b.time as UTCTimestamp,
              api.current.price,
            );
        }}
      />
      <div className="chart-bottom">
        <div className="segmented" aria-label="Chart range">
          {Object.keys(ranges).map((r) => (
            <button
              key={r}
              aria-pressed={range === r}
              onClick={() => {
                setRange(r as keyof typeof ranges);
                setFocused(undefined);
              }}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          className="text-button"
          onClick={() => {
            api.current?.chart.timeScale().fitContent();
            if (bars.length < 40)
              api.current?.chart
                .timeScale()
                .setVisibleLogicalRange({
                  from: bars.length - 40,
                  to: bars.length + 3,
                });
          }}
        >
          Fit loaded history
        </button>
      </div>
      <p className="panel-footnote">
        {interval} candles from observed post-swap prices · volume in ETH · UTC.
        Gaps contain no invented trades.{" "}
        {metric === "FDV" &&
          "FDV uses contract total supply at the capture cutoff. "}
        Panning does not fetch older history yet.
      </p>
      <p className="chart-credit">
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™
        </a>{" "}
        · Copyright (c) 2026 TradingView, Inc.
      </p>
    </div>
  );
}
