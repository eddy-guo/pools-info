"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  visualTheme,
  type ChainMarket,
  type ChainSnapshot,
  type ObservedMarket,
  type Candle,
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
const noHydrationUpdates = () => () => {};
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
function chartValue(
  value: bigint,
  market: ChainMarket | null,
  metric: "Price" | "FDV",
) {
  return market ? candleValue(value, market, metric) : value;
}
function observedBars(observed: ObservedMarket, interval: number): Candle[] {
  const bars = new Map<number, Candle>();
  for (const c of observed.history.candles) {
    const time = Math.floor(c.time / interval) * interval;
    const next = {
      time,
      open: BigInt(c.open),
      high: BigInt(c.high),
      low: BigInt(c.low),
      close: BigInt(c.close),
      volume: BigInt(c.volume),
    };
    const old = bars.get(time);
    if (old) {
      old.high = old.high > next.high ? old.high : next.high;
      old.low = old.low < next.low ? old.low : next.low;
      old.close = next.close;
      old.volume += next.volume;
    } else bars.set(time, next);
  }
  return [...bars.values()];
}
export function Candles(
  props:
    | { market: ChainMarket; snapshot: ChainSnapshot }
    | { observed: ObservedMarket },
) {
  const market = "market" in props ? props.market : null;
  const snapshot = "snapshot" in props ? props.snapshot : null;
  const observed = "observed" in props ? props.observed : null;
  const id = market?.id ?? observed!.poolId;
  const toTimestamp =
    snapshot?.toTimestamp ?? observed!.coverage.cutoff?.asOf ?? 0;
  // The server preview must not accept selections before React can retain them.
  const hydrated = useSyncExternalStore(
    noHydrationUpdates,
    () => true,
    () => false,
  );
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
    () =>
      market && snapshot
        ? buildCandles(market, snapshot, candleIntervals[interval])
        : observedBars(observed!, candleIntervals[interval]),
    [market, snapshot, observed, interval],
  );
  const active = bars.find((b) => b.time === focused) ?? bars.at(-1);
  const viewKey = `${id}:${range}:${interval}`;
  const previousView = useRef("");
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: visualTheme.panel },
        textColor: visualTheme.muted,
        fontFamily: "Geist, system-ui",
        fontSize: 11,
        attributionLogo: true,
        panes: {
          separatorColor: visualTheme.line,
          separatorHoverColor: visualTheme.lineHover,
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: visualTheme.surface4 },
        horzLines: { color: visualTheme.surface4 },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: visualTheme.line },
      timeScale: {
        borderColor: visualTheme.line,
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
      upColor: visualTheme.up,
      downColor: visualTheme.down,
      wickUpColor: visualTheme.up,
      wickDownColor: visualTheme.down,
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
        open: Number(chartValue(b.open, market, metric)),
        high: Number(chartValue(b.high, market, metric)),
        low: Number(chartValue(b.low, market, metric)),
        close: Number(chartValue(b.close, market, metric)),
      })),
    );
    a.volume.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: Number(b.volume) / 1e18,
        color:
          b.close >= b.open ? visualTheme.upVolume : visualTheme.downVolume,
      })),
    );
    a.chart.applyOptions({ timeScale: { secondsVisible: interval === "1s" } });
    if (bars.length) {
      if (previousView.current !== viewKey) {
        if (range === "All") {
          a.chart.timeScale().fitContent();
          if (bars.length < 40)
            a.chart.timeScale().setVisibleLogicalRange({
              from: bars.length - 40,
              to: bars.length + 3,
            });
        } else
          a.chart.timeScale().setVisibleRange({
            from: Math.max(
              bars[0].time,
              toTimestamp - ranges[range],
            ) as UTCTimestamp,
            to: Math.max(bars[0].time + 1, toTimestamp) as UTCTimestamp,
          });
      } else if (previous) a.chart.timeScale().setVisibleLogicalRange(previous);
    }
    previousView.current = viewKey;
  }, [bars, metric, market, range, interval, toTimestamp, viewKey]);
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
              disabled={!hydrated || !market}
              value={metric}
              onChange={(e) => setMetric(e.target.value as typeof metric)}
            >
              <option>Price</option>
              {market && <option>FDV</option>}
            </select>
          </label>
          <label>
            Candle interval
            <select
              aria-label="Candle interval"
              disabled={!hydrated}
              value={interval}
              onChange={(e) => {
                setInterval(e.target.value as typeof interval);
                setFocused(undefined);
              }}
            >
              {Object.keys(candleIntervals)
                .filter((i) => !observed || i !== "1s")
                .map((i) => (
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
                  <Eth wei={chartValue(value, market, metric).toString()} />
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
        aria-busy={!hydrated}
        aria-label={`${metric} candle chart with ETH volume. Drag to pan, scroll to zoom, arrow keys to inspect.`}
        tabIndex={hydrated ? 0 : -1}
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
              Number(chartValue(b.close, market, metric)),
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
              disabled={!hydrated}
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
          disabled={!hydrated}
          onClick={() => {
            api.current?.chart.timeScale().fitContent();
            if (bars.length < 40)
              api.current?.chart.timeScale().setVisibleLogicalRange({
                from: bars.length - 40,
                to: bars.length + 3,
              });
          }}
        >
          Fit loaded history
        </button>
      </div>
      <p className="panel-footnote">
        {observed
          ? `${interval} candles in declared cutoff token units`
          : `${interval} candles from observed post-swap prices`}{" "}
        · volume in ETH · UTC. Gaps contain no invented trades.{" "}
        {metric === "FDV" &&
          "FDV uses contract total supply at the capture cutoff. "}
        {observed &&
          "Historical price states use the declared cutoff decimals; decimals were not independently observed at each swap. "}
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
