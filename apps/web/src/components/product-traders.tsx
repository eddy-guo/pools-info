"use client";
import Link from "next/link";
import { shortAddress, type AnalyticsLeaderboardResponse } from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { useQuery } from "./state";
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { Avatar, Change, TierBadge } from "./ui";
import { ProductPagination } from "./product-common";
export function ProductTraders() {
  const { params, set } = useQuery(),
    { window, setWindow } = useWindow("7d");
  const metric = params.get("metric") ?? "realized",
    offset = Number(params.get("offset") ?? 0);
  // The read API applies its own minimum-trade gate; the page exposes no control.
  const query = new URLSearchParams({
    window,
    metric,
    offset: String(offset),
    limit: "25",
  });
  const { data, loading, stale, error, refresh } =
    useProduct<AnalyticsLeaderboardResponse>(`leaderboard?${query}`);
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
      </div>
      <section className="panel leaderboard-panel">
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
        <>
          {!offset && (
            <div
              className="live-podium"
              aria-busy={stale}
              data-stale-rows={stale}
            >
              {Array.from({ length: 3 }, (_, index) => data?.items[index]).map(
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
                    <small data-pending={!data}>
                      {w ? `#${w.rank} · covered pools` : "Covered pools"}
                    </small>
                    {w ? (
                      <Avatar address={w.address} />
                    ) : (
                      <span className="avatar" data-pending={!data}>
                        Wallet
                      </span>
                    )}
                    <strong data-pending={!data}>
                      {w ? shortAddress(w.address) : "Wallet pending"}
                    </strong>
                    <span>
                      {w ? (
                        <TierBadge tier={w.accountingTier} />
                      ) : (
                        <span className="badge tier-badge" data-pending={!data}>
                          Tier
                        </span>
                      )}
                    </span>
                    <Eth
                      wei={metric === "realized" ? w?.realizedWei : w?.netWei}
                      signed
                      pending={!data}
                    />
                  </Link>
                ),
              )}
            </div>
          )}
          <div
            className="table-scroll desktop-traders"
            aria-busy={stale}
            data-stale-rows={stale}
          >
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
                {Array.from(
                  { length: Math.max(25, data?.items.length ?? 0) },
                  (_, index) => data?.items[index],
                ).map((w, index) => (
                  <tr
                    key={index}
                    aria-hidden={!w}
                    data-row={w ? "resolved" : "reserved"}
                  >
                    <td data-pending={!w && !data}>
                      {w ? <>#{w.rank}</> : data ? "\u00a0" : "Pending"}
                    </td>
                    <td data-pending={!w && !data}>
                      {w ? (
                        <span className="trader-cell">
                          <Link
                            className="mono"
                            href={`/wallet/${w.address}/?window=${window}`}
                          >
                            {shortAddress(w.address)}
                          </Link>
                          <TierBadge tier={w.accountingTier} />
                        </span>
                      ) : data ? (
                        "\u00a0"
                      ) : (
                        "Pending"
                      )}
                    </td>
                    <td data-pending={!w && !data}>
                      <Eth
                        pending={!data}
                        wei={metric === "realized" ? w?.realizedWei : w?.netWei}
                        signed
                      />
                    </td>
                    <td data-pending={!w && !data}>
                      {w ? (
                        <>
                          {w.roi === null ? (
                            <Unavailable />
                          ) : (
                            <Change value={w.roi} />
                          )}
                        </>
                      ) : data ? (
                        "\u00a0"
                      ) : (
                        "Pending"
                      )}
                    </td>
                    <td data-pending={!w && !data}>
                      {w ? (
                        <>
                          {w.wins} / {w.losses}
                        </>
                      ) : data ? (
                        "\u00a0"
                      ) : (
                        "Pending"
                      )}
                    </td>
                    <td data-pending={!w && !data}>
                      {w ? (
                        <>{w.rankingTradeCount ?? w.supportedTradeCount}</>
                      ) : data ? (
                        "\u00a0"
                      ) : (
                        "Pending"
                      )}
                    </td>
                    <td data-pending={!w && !data}>
                      <Eth pending={!data} wei={w?.volumeWei} />
                    </td>
                    <td data-pending={!w && !data}>
                      {w ? (
                        <>
                          {w.realizedPositionCount ?? w.supportedPositionCount}{" "}
                          eligible
                          <small className="cell-sub">
                            {w.excludedPositionCount} excluded
                          </small>
                        </>
                      ) : data ? (
                        "\u00a0"
                      ) : (
                        "Pending"
                      )}
                    </td>
                    <td data-pending={!w && !data}>
                      <Eth pending={!data} wei={w?.bestWei} signed />
                    </td>
                    <td data-pending={!w && !data}>
                      {w ? (
                        <>{w.last ? utc(w.last) : <Unavailable />}</>
                      ) : data ? (
                        "\u00a0"
                      ) : (
                        "Pending"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="mobile-traders"
            aria-busy={stale}
            data-stale-rows={stale}
          >
            {Array.from(
              { length: Math.max(25, data?.items.length ?? 0) },
              (_, index) => data?.items[index],
            ).map((w, index) => (
              <div className="mobile-trader" key={index}>
                {w ? (
                  <>
                    <div className="mobile-trader-heading">
                      <span className="rank-number">#{w.rank}</span>
                      <Link
                        className="trader-identity"
                        href={`/wallet/${w.address}/?window=${window}`}
                      >
                        <Avatar address={w.address} small />
                        <span className="mono">{shortAddress(w.address)}</span>
                      </Link>
                      <TierBadge tier={w.accountingTier} />
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
                    <p className="panel-footnote">
                      {w.realizedPositionCount ?? w.supportedPositionCount}{" "}
                      eligible positions · {w.excludedPositionCount} excluded
                    </p>
                  </>
                ) : !data ? (
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
                    <p className="panel-footnote" data-pending="true">
                      Eligible positions pending
                    </p>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </>
        {data && !data.items.length && !loading && (
          <div className="empty-state">
            <h3>No qualifying traders in this window</h3>
            <p>
              Try a wider window. Realized PnL requires observed purchase basis;
              missing history is not assigned zero cost.
            </p>
          </div>
        )}
        <ProductPagination
          offset={offset}
          total={data?.total ?? 0}
          nextOffset={data?.nextOffset ?? null}
          onPage={(n) => set({ offset: String(n) })}
          loading={loading}
        />
      </section>
    </div>
  );
}
