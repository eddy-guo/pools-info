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
  visualTheme,
  type ChainMarket,
  type ChainSnapshot,
  type ObservedMarket,
  type Candle,
} from "@pools/core";
import { Price } from "./ui";
import { Eth, utc } from "./live-ui";
export const chartRanges = {
  "5m": 300,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "1W": 604800,
  All: Infinity,
};
export type ChartRange = keyof typeof chartRanges;
const noHydrationUpdates = () => () => {};
/** The server preview must not accept selections before React can retain them. */
export function useHydrated() {
  return useSyncExternalStore(
    noHydrationUpdates,
    () => true,
    () => false,
  );
}
/** The range control of the chart panel's head: one segmented control. */
export function ChartRangeControl({
  value,
  onChange,
  disabled = false,
}: {
  value: ChartRange;
  onChange: (range: ChartRange) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" aria-label="Chart range">
      {(Object.keys(chartRanges) as ChartRange[]).map((range) => (
        <button
          key={range}
          disabled={disabled}
          aria-pressed={value === range}
          onClick={() => onChange(range)}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
/* The candle follows the range, as on the token pages the site is modelled on:
   about sixty to three hundred bars across the panel. A market observed from
   its swap history carries candles of its served interval (a minute, or an
   hour from the aggregate ledger) and nothing finer. */
function intervalFor(
  range: ChartRange,
  span: number,
  observedSeconds: number | null,
): keyof typeof candleIntervals {
  const seconds = range === "All" ? span : chartRanges[range];
  const interval: keyof typeof candleIntervals =
    seconds <= 600
      ? observedSeconds === null
        ? "1s"
        : "1m"
      : seconds <= 7200
        ? "1m"
        : seconds <= 86400
          ? "5m"
          : seconds <= 14 * 86400
            ? "1h"
            : "4h";
  return observedSeconds !== null && candleIntervals[interval] < observedSeconds
    ? (Object.keys(candleIntervals) as (keyof typeof candleIntervals)[]).find(
        (name) => candleIntervals[name] >= observedSeconds,
      )!
    : interval;
}
function axisPrice(value: number) {
  if (!Number.isFinite(value)) return "";
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
/* The tooltip's box, so it can flip to the crosshair's other side before it
   would leave the chart. */
const tooltipWidth = 196;
export function Candles(
  props: { range: ChartRange } & (
    | { market: ChainMarket; snapshot: ChainSnapshot }
    | { observed: ObservedMarket }
    | { poolId: string; pending: boolean }
  ),
) {
  const { range } = props;
  const market = "market" in props ? props.market : null;
  const snapshot = "snapshot" in props ? props.snapshot : null;
  const observed = "observed" in props ? props.observed : null;
  const pending = "pending" in props && props.pending;
  const id =
    market?.id ?? observed?.poolId ?? ("poolId" in props ? props.poolId : "");
  const toTimestamp =
    snapshot?.toTimestamp ?? observed?.coverage.cutoff?.asOf ?? 0;
  const hydrated = useHydrated();
  /* The bar under the crosshair and where the crosshair is, for the tooltip. */
  const [focus, setFocus] = useState<{
    time: number;
    x: number;
    width: number;
  }>();
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<{
    chart: IChartApi;
    price: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
  } | null>(null);
  const span =
    (market && snapshot
      ? toTimestamp -
        Math.min(market.launchedAt, market.series[0]?.time ?? toTimestamp)
      : observed?.history.fromTimestamp != null
        ? toTimestamp - observed.history.fromTimestamp
        : 0) || 0;
  const interval = intervalFor(
    range,
    span,
    observed ? observed.history.intervalSeconds : null,
  );
  const bars = useMemo(
    () =>
      market && snapshot
        ? buildCandles(market, snapshot, candleIntervals[interval])
        : observed
          ? observedBars(observed, candleIntervals[interval])
          : [],
    [market, snapshot, observed, interval],
  );
  const active = focus && bars.find((b) => b.time === focus.time);
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
      /* A tick label is drawn centred on its tick and, by default, allowed
         to run past the scale's edge, which cut the topmost price label in
         half; an edge tick is dropped instead. Chart-level scale options
         seed every pane's own scale, so the volume pane gets the same. */
      rightPriceScale: {
        borderColor: visualTheme.line,
        minimumWidth: 80,
        entireTextOnly: true,
      },
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
    chart.panes()[1].setHeight(70);
    chart.subscribeCrosshairMove((p) =>
      setFocus(
        typeof p.time === "number" && p.point && container.current
          ? {
              time: p.time,
              x: p.point.x,
              width: container.current.clientWidth,
            }
          : undefined,
      ),
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
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
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
              toTimestamp - chartRanges[range],
            ) as UTCTimestamp,
            to: Math.max(bars[0].time + 1, toTimestamp) as UTCTimestamp,
          });
      } else if (previous) a.chart.timeScale().setVisibleLogicalRange(previous);
    }
    previousView.current = viewKey;
  }, [bars, range, interval, toTimestamp, viewKey]);
  return (
    <div
      className="interactive-chart"
      role="img"
      aria-busy={!hydrated || pending}
      aria-label="Price candle chart with ETH volume. Drag to pan, scroll to zoom, arrow keys to inspect."
      tabIndex={hydrated ? 0 : -1}
      onKeyDown={(e) => {
        if ((e.key !== "ArrowRight" && e.key !== "ArrowLeft") || !bars.length)
          return;
        e.preventDefault();
        const i = Math.max(
          0,
          bars.findIndex((b) => b.time === (focus?.time ?? bars.at(-1)?.time)),
        );
        const b =
          bars[
            Math.min(
              bars.length - 1,
              Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
            )
          ];
        const a = api.current;
        if (!a || !container.current) return;
        a.chart.setCrosshairPosition(
          Number(b.close),
          b.time as UTCTimestamp,
          a.price,
        );
        setFocus({
          time: b.time,
          x: a.chart.timeScale().timeToCoordinate(b.time as UTCTimestamp) ?? 0,
          width: container.current.clientWidth,
        });
      }}
    >
      <div className="chart-surface" ref={container} />
      {/* The OHLC readout follows the crosshair instead of holding a row. */}
      {active && (
        <div
          className="chart-tooltip"
          style={{
            left:
              focus.x + 16 + tooltipWidth > focus.width
                ? Math.max(0, focus.x - 16 - tooltipWidth)
                : focus.x + 16,
          }}
        >
          <time dateTime={new Date(active.time * 1000).toISOString()}>
            {utc(active.time)}
          </time>
          {(
            [
              ["O", active.open],
              ["H", active.high],
              ["L", active.low],
              ["C", active.close],
            ] as const
          ).map(([name, value]) => (
            <span key={name}>
              <b>{name}</b>
              <Price wei={value.toString()} />
            </span>
          ))}
          <span>
            <b>V</b>
            <Eth wei={active.volume.toString()} />
          </span>
        </div>
      )}
    </div>
  );
}
