"use client";
import Link from "next/link";
import { CoverageSkeleton, LeaderboardSkeleton } from "./skeletons";
import { shortAddress, type AnalyticsLeaderboardResponse } from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { useQuery } from "./state";
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { Avatar, Change } from "./ui";
import { PersonalRankPreview } from "./feature-preview";
import { ProductCoverage, ProductPagination } from "./product-common";
export function ProductTraders() {
  const { params, set } = useQuery(),
    { window, setWindow } = useWindow("All");
  const minimum = Number(params.get("minTrades") ?? 10),
    metric = params.get("metric") ?? "realized",
    offset = Number(params.get("offset") ?? 0);
  const query = new URLSearchParams({
    window,
    minTrades: String(minimum),
    metric,
    offset: String(offset),
    limit: "25",
  });
  const { data, loading, error, refresh } =
    useProduct<AnalyticsLeaderboardResponse>(`leaderboard?${query}`);
  return (
    <div className="page traders-page">
      <div className="page-heading">
        <div>
          <h1>
            Trader leaderboard<span className="title-dot">.</span>
          </h1>
          <p>Follow the wallets. Understand the performance.</p>
        </div>
        <Link className="button secondary" href="/wallet/">
          Look up your wallet ↗
        </Link>
      </div>
      <PersonalRankPreview />
      {loading && !data && <CoverageSkeleton />}
      {data && (
        <ProductCoverage coverage={data.coverage} delivery={data.delivery} />
      )}
      <section className="panel leaderboard-panel">
        <div className="live-controls">
          <label>
            Minimum swaps
            <select
              aria-label="Minimum swaps"
              value={minimum}
              onChange={(e) => set({ minTrades: e.target.value, offset: null })}
            >
              {[1, 10, 25, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <div className="segmented">
            {[
              ["realized", "Realized PnL"],
              ["net", "Net ETH"],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={metric === key}
                onClick={() => set({ metric: key, offset: null })}
              >
                {label}
              </button>
            ))}
          </div>
          <WindowTabs
            value={window}
            onChange={(value) => {
              setWindow(value);
              set({ offset: null });
            }}
          />
          <button
            className="button secondary"
            disabled={loading}
            onClick={refresh}
          >
            Refresh saved rankings
          </button>
        </div>
        <p className="panel-footnote">
          Ranked across all processed pools before pagination. Unknown basis and
          unsupported positions are excluded from profit, with excluded position
          counts shown. Net ETH includes purchases of unsold inventory. These
          are supported-position totals, not complete wallet returns.
        </p>
        {loading && data && (
          <span className="sr-only" role="status">
            Updating saved rankings
          </span>
        )}
        {error && (
          <p role="alert" className="panel-footnote">
            {error}
          </p>
        )}
        {loading && !data ? (
          <LeaderboardSkeleton />
        ) : (
          <>
            {!offset && !!data?.items.length && (
              <div className="live-podium">
                {data.items.slice(0, 3).map((w) => (
                  <Link
                    href={`/wallet/${w.address}/?window=${window}`}
                    key={w.address}
                  >
                    <small>#{w.rank} · covered pools</small>
                    <Avatar address={w.address} />
                    <strong>{shortAddress(w.address)}</strong>
                    <Eth
                      wei={metric === "realized" ? w.realizedWei : w.netWei}
                      signed
                    />
                  </Link>
                ))}
              </div>
            )}
            <div className="table-scroll desktop-traders">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Trader</th>
                    <th>
                      {metric === "realized" ? "Realized PnL" : "Net ETH"}
                    </th>
                    <th>ROI</th>
                    <th>W / L</th>
                    <th>Supported trades</th>
                    <th>Volume</th>
                    <th>Positions</th>
                    <th>Best sale</th>
                    <th>Last (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((w) => (
                    <tr key={w.address}>
                      <td>#{w.rank}</td>
                      <td>
                        <Link
                          className="mono"
                          href={`/wallet/${w.address}/?window=${window}`}
                        >
                          {shortAddress(w.address)}
                        </Link>
                      </td>
                      <td>
                        <Eth
                          wei={metric === "realized" ? w.realizedWei : w.netWei}
                          signed
                        />
                      </td>
                      <td>
                        {w.roi === null ? (
                          <Unavailable />
                        ) : (
                          <span
                            className={
                              w.roi > 0
                                ? "positive"
                                : w.roi < 0
                                  ? "negative"
                                  : ""
                            }
                          >
                            {w.roi.toFixed(2)}%
                          </span>
                        )}
                      </td>
                      <td>
                        {w.wins} / {w.losses}
                      </td>
                      <td>{w.supportedTradeCount}</td>
                      <td>
                        <Eth wei={w.volumeWei} />
                      </td>
                      <td>
                        {w.supportedPositionCount} supported
                        <small className="cell-sub">
                          {w.excludedPositionCount} excluded
                        </small>
                      </td>
                      <td>
                        <Eth wei={w.bestWei} signed />
                      </td>
                      <td>{w.last ? utc(w.last) : <Unavailable />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-traders">
              {data?.items.map((w) => (
                <div className="mobile-trader" key={w.address}>
                  <div className="mobile-trader-heading">
                    <span className="rank-number">#{w.rank}</span>
                    <Link
                      className="trader-identity"
                      href={`/wallet/${w.address}/?window=${window}`}
                    >
                      <Avatar address={w.address} small />
                      <span className="mono">{shortAddress(w.address)}</span>
                    </Link>
                  </div>
                  <div className="mobile-trader-value">
                    <Eth
                      wei={metric === "realized" ? w.realizedWei : w.netWei}
                      signed
                    />
                    <span>
                      {metric === "realized" ? "realized" : "net flow"}
                    </span>
                  </div>
                  <div className="mobile-pool-stats">
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
                      Trades<strong>{w.supportedTradeCount}</strong>
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
                  <p className="panel-footnote">
                    {w.supportedPositionCount} supported positions ·{" "}
                    {w.excludedPositionCount} excluded
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
        {data && !data.items.length && !loading && (
          <div className="empty-state">
            <h3>No qualifying traders in this window</h3>
            <p>
              Try the All window or a lower minimum. Only saved, supported
              positions qualify.
            </p>
          </div>
        )}
        {data && (
          <ProductPagination
            offset={offset}
            total={data.total}
            nextOffset={data.nextOffset}
            onPage={(n) => set({ offset: String(n) })}
            loading={loading}
          />
        )}
      </section>
    </div>
  );
}
