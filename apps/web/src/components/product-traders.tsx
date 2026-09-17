"use client";
import Link from "next/link";
import { shortAddress, type AnalyticsLeaderboardResponse } from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { useQuery } from "./state";
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { AddressChip, Avatar, Change } from "./ui";
import { PAGE_SIZES, ProductPagination, type PageSize } from "./product-common";
export function ProductTraders() {
  const { params, set } = useQuery(),
    { window, setWindow } = useWindow("7d");
  const metric = params.get("metric") ?? "realized",
    offset = Number(params.get("offset") ?? 0);
  const rawLimit = Number(params.get("limit"));
  const limit: PageSize = PAGE_SIZES.includes(rawLimit as PageSize)
    ? (rawLimit as PageSize)
    : 25;
  // The read API applies its own minimum-trade gate; the page exposes no control.
  const query = new URLSearchParams({
    window,
    metric,
    offset: String(offset),
    limit: String(limit),
  });
  const { data, loading, stale, error } =
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
                onClick={() =>
                  set({ metric: key, offset: null, limit: String(limit) })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <WindowTabs
            value={window}
            onChange={(value) => {
              setWindow(value);
              set({ offset: null, limit: String(limit) });
            }}
          />
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
                      {w ? `#${w.rank}` : "Rank"}
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
                  { length: Math.max(limit, data?.items.length ?? 0) },
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
                        <AddressChip
                          address={w.address}
                          href={`/wallet/${w.address}/?window=${window}`}
                        />
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
                          {w.realizedPositionCount ?? w.supportedPositionCount}
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
              { length: Math.max(limit, data?.items.length ?? 0) },
              (_, index) => data?.items[index],
            ).map((w, index) => (
              <div className="mobile-trader" key={index}>
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
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </>
        {data && !data.items.length && !loading && (
          <div className="empty-state">
            <h3>No qualifying traders in this window</h3>
            <p>Try a wider window.</p>
          </div>
        )}
        <ProductPagination
          offset={offset}
          limit={limit}
          total={data?.total ?? 0}
          nextOffset={data?.nextOffset ?? null}
          onPage={(n) => set({ offset: String(n), limit: String(limit) })}
          onLimit={(size) => set({ limit: String(size), offset: null })}
          loading={loading}
        />
      </section>
    </div>
  );
}
