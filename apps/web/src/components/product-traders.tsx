"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  shortAddress,
  type AnalyticsLeaderboardResponse,
  type AnalyticsWalletSummary,
} from "@pools/core";
import { fetchProduct } from "@/lib/use-product";
import { useQuery } from "./state";
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { AddressChip, Avatar, Change } from "./ui";
import { SHOW_MORE_STEP, ShowMore } from "./product-common";

/** The leaderboard never requests past its top 100, whatever the API allows. */
const CAP = 100;

type LeaderboardState = {
  key: string;
  items: AnalyticsWalletSummary[];
  total: number;
  loadedShown: number;
  loading: boolean;
  settled: boolean;
  error?: string;
};

/**
 * Grows a leaderboard window/metric pair page by page: a metric or window
 * change (a new `key`) replaces the list from scratch, while a growing
 * `shown` target on the same key fetches only the rows not already held and
 * appends them, so an already-loaded row is never requested twice.
 */
function useLeaderboard(
  key: string,
  window: string,
  metric: string,
  shown: number,
) {
  const [state, setState] = useState<LeaderboardState>({
    key: "",
    items: [],
    total: 0,
    loadedShown: 0,
    loading: true,
    settled: false,
  });
  useEffect(() => {
    const isReset = state.key !== key;
    if (!isReset && shown <= state.loadedShown) return;
    const baseItems = isReset ? [] : state.items;
    const baseLoaded = isReset ? 0 : state.loadedShown;
    const fetchLimit = shown - baseLoaded;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const query = new URLSearchParams({
      window,
      metric,
      offset: String(baseLoaded),
      limit: String(fetchLimit),
    });
    void (async () => {
      try {
        const data = await fetchProduct<AnalyticsLeaderboardResponse>(
          `leaderboard?${query}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setState({
          key,
          items: [...baseItems, ...data.items],
          total: data.total,
          loadedShown: baseLoaded + data.items.length,
          loading: false,
          settled: true,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          key,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Saved data is unavailable.",
        }));
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, window, metric, shown]);
  return state;
}

export function ProductTraders() {
  const { params, set } = useQuery(),
    { window, setWindow } = useWindow("7d");
  const metric = params.get("metric") ?? "realized";
  const rawShown = Number(params.get("limit"));
  const shown =
    Number.isInteger(rawShown) && rawShown > 0 && rawShown <= CAP
      ? rawShown
      : 25;
  const key = `${window}:${metric}`;
  const state = useLeaderboard(key, window, metric, shown);
  const forKey = state.key === key;
  const settled = forKey && state.settled;
  const items = forKey ? state.items.slice(0, shown) : [];
  const total = settled ? state.total : null;
  const knownAbsent = (index: number) => settled && index >= state.total;

  const focusFromRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const handleMore = useCallback(() => {
    focusFromRef.current = shown;
    const ceiling = total === null ? CAP : Math.min(CAP, total);
    set({ limit: String(Math.min(shown + SHOW_MORE_STEP, ceiling)) });
  }, [shown, set, total]);
  useEffect(() => {
    const index = focusFromRef.current;
    if (index === null || state.loading) return;
    if (state.items.length <= index) return;
    focusFromRef.current = null;
    const container = panelRef.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>(
      `[data-row-index="${index}"]`,
    );
    for (const row of rows) {
      if (row.offsetParent === null) continue;
      const target =
        row.querySelector<HTMLElement>(".address-chip-link") ?? row;
      target.focus();
      break;
    }
  }, [state.items.length, state.loading]);

  return (
    <div className="page traders-page">
      <div className="page-heading">
        <h1>
          Trader leaderboard<span className="title-dot">.</span>
        </h1>
        <div className="traders-controls">
          <div className="segmented" aria-label="Ranking metric">
            {[
              ["realized", "Realized PnL"],
              ["net", "Net ETH"],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={metric === key}
                onClick={() => set({ metric: key, limit: null })}
              >
                {label}
              </button>
            ))}
          </div>
          <WindowTabs
            value={window}
            onChange={(value) => {
              setWindow(value);
              set({ limit: null });
            }}
          />
        </div>
      </div>
      <section className="panel leaderboard-panel" ref={panelRef}>
        {state.loading && items.length > 0 && (
          <span className="sr-only" role="status">
            Updating saved rankings
          </span>
        )}
        {state.error && (
          <p role="alert" className="panel-footnote">
            {state.error}
          </p>
        )}
        <>
          <div className="live-podium">
            {Array.from({ length: 3 }, (_, index) => items[index]).map(
              (w, index) => (
                <Link
                  href={
                    w ? `/wallet/${w.address}/?window=${window}` : "/traders/"
                  }
                  key={index}
                  prefetch={!!w}
                  aria-disabled={!w}
                  tabIndex={w ? undefined : -1}
                  onClick={(event) => {
                    if (!w) event.preventDefault();
                  }}
                >
                  <small data-pending={!w && !knownAbsent(index)}>
                    {w ? `#${w.rank}` : "Rank"}
                  </small>
                  {w ? (
                    <Avatar address={w.address} />
                  ) : (
                    <span
                      className="avatar"
                      data-pending={!w && !knownAbsent(index)}
                    >
                      Wallet
                    </span>
                  )}
                  <strong data-pending={!w && !knownAbsent(index)}>
                    {w ? shortAddress(w.address) : "Wallet pending"}
                  </strong>
                  <Eth
                    wei={metric === "realized" ? w?.realizedWei : w?.netWei}
                    signed
                    pending={!w && !knownAbsent(index)}
                  />
                </Link>
              ),
            )}
          </div>
          <div className="table-scroll desktop-traders">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Trader</th>
                  <th>{metric === "realized" ? "Realized PnL" : "Net ETH"}</th>
                  <th>ROI</th>
                  <th>W / L</th>
                  <th>Trades</th>
                  <th>Volume</th>
                  <th>Positions</th>
                  <th>Best sale</th>
                  <th>Last (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: shown }, (_, index) => items[index]).map(
                  (w, index) => {
                    const absent = knownAbsent(index);
                    const pending = !w && !absent;
                    return (
                      <tr
                        key={index}
                        data-row-index={index}
                        aria-hidden={!w}
                        data-row={w ? "resolved" : "reserved"}
                      >
                        <td data-pending={pending}>
                          {w ? <>#{w.rank}</> : pending ? "Pending" : "\u00a0"}
                        </td>
                        <td data-pending={pending}>
                          {w ? (
                            <AddressChip
                              address={w.address}
                              href={`/wallet/${w.address}/?window=${window}`}
                            />
                          ) : pending ? (
                            "Pending"
                          ) : (
                            "\u00a0"
                          )}
                        </td>
                        <td data-pending={pending}>
                          <Eth
                            pending={pending}
                            wei={
                              metric === "realized" ? w?.realizedWei : w?.netWei
                            }
                            signed
                          />
                        </td>
                        <td data-pending={pending}>
                          {w ? (
                            <>
                              {w.roi === null ? (
                                <Unavailable />
                              ) : (
                                <Change value={w.roi} />
                              )}
                            </>
                          ) : pending ? (
                            "Pending"
                          ) : (
                            "\u00a0"
                          )}
                        </td>
                        <td data-pending={pending}>
                          {w ? (
                            <>
                              {w.wins} / {w.losses}
                            </>
                          ) : pending ? (
                            "Pending"
                          ) : (
                            "\u00a0"
                          )}
                        </td>
                        <td data-pending={pending}>
                          {w ? (
                            <>{w.rankingTradeCount ?? w.supportedTradeCount}</>
                          ) : pending ? (
                            "Pending"
                          ) : (
                            "\u00a0"
                          )}
                        </td>
                        <td data-pending={pending}>
                          <Eth pending={pending} wei={w?.volumeWei} />
                        </td>
                        <td data-pending={pending}>
                          {w ? (
                            <>
                              {w.realizedPositionCount ??
                                w.supportedPositionCount}
                            </>
                          ) : pending ? (
                            "Pending"
                          ) : (
                            "\u00a0"
                          )}
                        </td>
                        <td data-pending={pending}>
                          <Eth pending={pending} wei={w?.bestWei} signed />
                        </td>
                        <td data-pending={pending}>
                          {w ? (
                            <>{w.last ? utc(w.last) : <Unavailable />}</>
                          ) : pending ? (
                            "Pending"
                          ) : (
                            "\u00a0"
                          )}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
          <div className="mobile-traders">
            {Array.from({ length: shown }, (_, index) => items[index]).map(
              (w, index) => {
                const absent = knownAbsent(index);
                const pending = !w && !absent;
                return (
                  <div
                    className="mobile-trader"
                    key={index}
                    data-row-index={index}
                  >
                    {w ? (
                      <>
                        <div className="mobile-trader-heading">
                          <span className="rank-number">#{w.rank}</span>
                          <AddressChip
                            address={w.address}
                            href={`/wallet/${w.address}/?window=${window}`}
                          />
                        </div>
                        <div className="mobile-trader-value">
                          <Eth
                            wei={
                              metric === "realized" ? w.realizedWei : w.netWei
                            }
                            signed
                          />
                          <span>
                            {metric === "realized" ? "realized" : "net flow"}
                          </span>
                        </div>
                        <div className="mobile-trader-key">
                          <span>
                            ROI
                            <strong>
                              {w.roi === null ? (
                                <Unavailable />
                              ) : (
                                <Change value={w.roi} />
                              )}
                            </strong>
                          </span>
                          <span>
                            W / L
                            <strong className="number">
                              {w.wins} / {w.losses}
                            </strong>
                          </span>
                        </div>
                        <div className="mobile-trader-stats">
                          <span>
                            Trades
                            <strong className="number">
                              {w.rankingTradeCount ?? w.supportedTradeCount}
                            </strong>
                          </span>
                          <span>
                            Volume
                            <strong>
                              <Eth wei={w.volumeWei} />
                            </strong>
                          </span>
                          <span>
                            Best sale
                            <strong>
                              <Eth wei={w.bestWei} signed />
                            </strong>
                          </span>
                        </div>
                      </>
                    ) : pending ? (
                      <>
                        <div className="mobile-trader-heading">
                          <span className="rank-number" data-pending="true">
                            Rank
                          </span>
                          <span className="trader-identity" data-pending="true">
                            Wallet pending
                          </span>
                        </div>
                        <div className="mobile-trader-value">
                          <span className="number" data-pending="true">
                            PnL pending
                          </span>
                        </div>
                        <div className="mobile-trader-key">
                          {["ROI", "W / L"].map((label) => (
                            <span key={label}>
                              {label}
                              <strong data-pending="true">Pending</strong>
                            </span>
                          ))}
                        </div>
                        <div className="mobile-trader-stats">
                          {["Trades", "Volume", "Best sale"].map((label) => (
                            <span key={label}>
                              {label}
                              <strong data-pending="true">Pending</strong>
                            </span>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              },
            )}
          </div>
        </>
        {settled && total === 0 && (
          <div className="empty-state">
            <h3>No qualifying traders in this window</h3>
            <p>Try a wider window.</p>
          </div>
        )}
        <ShowMore
          shown={shown}
          total={total}
          cap={CAP}
          loading={state.loading}
          onMore={handleMore}
        />
      </section>
    </div>
  );
}
