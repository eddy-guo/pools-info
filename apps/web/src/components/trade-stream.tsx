"use client";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { shortAddress, type LiveTradeFeedResponse } from "@pools/core";
import { validateLiveFeed } from "@/lib/live-feed";
import { Eth, explorer, utc } from "./live-ui";
import styles from "./trade-stream.module.css";
const subscribeClock = (notify: () => void) => {
  const timer = setInterval(notify, 15000);
  return () => clearInterval(timer);
};
const nowSeconds = () => Math.floor(Date.now() / 1000);
const serverSeconds = () => 0;
const slideMs = 450;
/** Painted top of each row inside the scroll surface, keyed by trade id. */
function rowOffsets(list: HTMLElement | null) {
  const offsets = new Map<string, number>();
  if (!list) return offsets;
  const origin = list.getBoundingClientRect().top;
  for (const row of list.querySelectorAll<HTMLElement>("[data-event-id]"))
    offsets.set(row.dataset.eventId!, row.getBoundingClientRect().top - origin);
  return offsets;
}
function age(timestamp: number, now: number) {
  if (!now) return utc(timestamp);
  // A device clock behind the trade reports the freshest age it can rather
  // than a sentence.
  const seconds = Math.max(0, now - timestamp);
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
}
export function TradeStream({ poolId }: { poolId?: string }) {
  const scope = poolId?.toLowerCase() ?? "all";
  const now = useSyncExternalStore(subscribeClock, nowSeconds, serverSeconds);
  const [enabled, setEnabled] = useState(true),
    [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    data?: LiveTradeFeedResponse;
    error: boolean;
    fresh: Set<string>;
  }>({ scope, error: false, fresh: new Set() });
  const current = state.scope === scope ? state : undefined;
  const history = useRef({
    scope,
    seen: new Set<string>(),
    initialized: false,
  });
  const list = useRef<HTMLDivElement>(null);
  const offsets = useRef<Map<string, number>>(null);
  useEffect(() => {
    if (!enabled) return;
    if (history.current.scope !== scope)
      history.current = { scope, seen: new Set(), initialized: false };
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      active: AbortController | null = null;
    // Retain identities across pause/retry, with a fixed memory bound.
    const remembered = history.current,
      seen = remembered.seen;
    async function tick() {
      if (stopped || document.hidden || active) return;
      const controller = new AbortController();
      active = controller;
      try {
        const response = await fetch(
          `/api/live-trades/${scope === "all" ? "" : `?poolId=${scope}`}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
            cache: "no-store",
          },
        );
        if (!response.ok) throw Error("Unavailable");
        const data = validateLiveFeed(
          await response.json(),
          scope === "all" ? undefined : scope,
        );
        if (stopped || controller.signal.aborted) return;
        const events = [
          ...new Map(data.events.map((event) => [event.id, event])).values(),
        ]
          .sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
          .slice(0, 50);
        const fresh = new Set(
          remembered.initialized
            ? events
                .filter((event) => !seen.has(event.id))
                .map((event) => event.id)
            : [],
        );
        for (const event of events) seen.add(event.id);
        while (seen.size > 1000) seen.delete(seen.values().next().value!);
        // Only windows after the first population animate into place.
        offsets.current = remembered.initialized
          ? rowOffsets(list.current)
          : null;
        remembered.initialized = true;
        // This is the entire canonical recent window, including rollback/removal.
        setState({ scope, data: { ...data, events }, error: false, fresh });
      } catch {
        if (!stopped && !controller.signal.aborted)
          setState((previous) =>
            previous.scope === scope
              ? { ...previous, error: true, fresh: new Set() }
              : { scope, error: true, fresh: new Set() },
          );
      } finally {
        if (active === controller) active = null;
        if (!stopped && !document.hidden) timer = setTimeout(tick, 15000);
      }
    }
    function visibility() {
      clearTimeout(timer);
      if (document.hidden) active?.abort();
      else void tick();
    }
    document.addEventListener("visibilitychange", visibility);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      active?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [scope, enabled, attempt]);
  const data = current?.data,
    coverage = data?.coverage;
  useLayoutEffect(() => {
    const before = offsets.current;
    offsets.current = null;
    if (
      !before ||
      !list.current ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    // Retained rows start where they were painted before this window and
    // slide into their new slot; arriving rows ride down with the row beneath
    // them. Transform only, so the surface below the feed never moves.
    const origin = list.current.getBoundingClientRect().top;
    let carried: number | undefined;
    for (const row of [
      ...list.current.querySelectorAll<HTMLElement>("[data-event-id]"),
    ].reverse()) {
      const previous = before.get(row.dataset.eventId!);
      const shift =
        previous === undefined
          ? (carried ?? -row.offsetHeight)
          : Math.round(previous - (row.getBoundingClientRect().top - origin));
      if (previous !== undefined) carried = shift;
      if (shift)
        row.animate(
          [{ transform: `translateY(${shift}px)` }, { transform: "none" }],
          { duration: slideMs, easing: "ease-out" },
        );
    }
  }, [data]);
  const stale =
    current?.error ||
    coverage?.state === "stale" ||
    (coverage?.asOf && now && now - coverage.asOf > coverage.staleAfterSeconds);
  const status = !enabled
    ? "Paused"
    : stale
      ? data
        ? "Updates delayed · showing last received trades"
        : "Recent trades are temporarily unavailable"
      : coverage?.state === "uninitialized"
        ? "Waiting for the first live capture"
        : data
          ? "Checking every 15s"
          : "Loading recent trades…";
  return (
    <section
      className={`panel trade-stream ${styles.rail}`}
      aria-label="Recent trades"
    >
      <div className="panel-heading">
        <h2>Live trades</h2>
        <button
          className="text-button"
          onClick={() => setEnabled((value) => !value)}
        >
          {enabled ? "Pause feed" : "Resume feed"}
        </button>
      </div>
      <div className={`feed-status ${styles.status}`} role="status">
        <span>{status}</span>
        {current?.error && enabled && (
          <button
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry feed
          </button>
        )}
      </div>
      <div className={`activity-list ${styles.events}`} ref={list}>
        {!data &&
          !current?.error &&
          Array.from({ length: 3 }, (_, index) => (
            <div
              className={`stream-event ${styles.row}`}
              key={index}
              aria-hidden="true"
            >
              <div className={styles.top}>
                <strong data-pending="true">Token pending</strong>
                <span data-pending="true">Side</span>
                <span className="number" data-pending="true">
                  Amount pending
                </span>
              </div>
              <div className={styles.meta}>
                <span data-pending="true">Tx initiator pending</span>
                <time data-pending="true">Time pending</time>
              </div>
            </div>
          ))}
        {data && !data.events.length && (
          <p className={styles.note}>
            {coverage?.state === "uninitialized"
              ? "The collector is starting. Trades appear after the first saved capture."
              : "No swaps in the saved recent window. Checking continues while this page is visible."}
          </p>
        )}
        {data?.events.map((event) => (
          <div
            className={`stream-event ${styles.row}`}
            key={event.id}
            data-event-id={event.id}
            data-new={current?.fresh.has(event.id) ? "true" : "false"}
          >
            <div className={styles.top}>
              <Link
                href={`/pool/${event.poolId}/?launch=${event.launchTx}`}
                title={event.name}
              >
                <strong>{event.symbol}</strong>
              </Link>
              <span className={event.side === "buy" ? "positive" : "negative"}>
                {event.side === "buy" ? "Buy" : "Sell"}
              </span>
              <Eth wei={event.ethWei} />
            </div>
            <div className={styles.meta}>
              <span>
                Tx initiator{" "}
                {event.transactionInitiator ? (
                  <Link
                    className="mono"
                    href={`/wallet/${event.transactionInitiator}/?window=All`}
                  >
                    {shortAddress(event.transactionInitiator)}
                  </Link>
                ) : (
                  "unavailable"
                )}
              </span>
              <a
                href={`${explorer}/tx/${event.transactionHash}`}
                target="_blank"
                rel="noreferrer"
                title={utc(event.timestamp)}
              >
                <time dateTime={new Date(event.timestamp * 1000).toISOString()}>
                  {age(event.timestamp, now)}
                </time>{" "}
                ↗
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
