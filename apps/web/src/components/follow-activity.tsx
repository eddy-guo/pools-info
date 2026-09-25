"use client";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import {
  shortAddress,
  type FollowingTrade,
  type FollowingTradesResponse,
  type FollowingWalletCoverage,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { AddressChip, EmptyState, UnavailableState } from "./ui";
import { utc } from "./live-ui";
import { reservedRowCount } from "./product-common";
import {
  RowFiller,
  TradeAmount,
  TradeSide,
  TradeTime,
  TradeTransaction,
} from "./trade-cells";
import styles from "./following.module.css";

/** The panel lists the newest trades across the follow list in a fixed run
    of row slots; more of one wallet's history is on its own page. */
export const FOLLOWING_ROWS = 25;

export type FollowActivityFeed = ReturnType<typeof useFollowActivity>;

/** The follow list's trade feed, read every 30 seconds while the page is
    visible and updates are not paused. Polls wait for the previous read. */
export function useFollowActivity(addresses: string[]) {
  const params = new URLSearchParams({
    wallets: [...addresses].sort().join(","),
    limit: String(FOLLOWING_ROWS),
  });
  const { data, error, loading, refresh } = useProduct<FollowingTradesResponse>(
    `following?${params}`,
  );
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || loading) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) refresh();
    };
    if (!document.hidden)
      timer = setTimeout(() => {
        if (!document.hidden) refresh();
      }, 30000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [paused, loading, refresh]);
  /* A list change keeps the previous answer on screen while the new one
     loads; it never shows a wallet that is no longer followed, and a wallet
     the answer has not covered yet reads as loading. */
  const followed = new Set(addresses.map((a) => a.toLowerCase()));
  const coverage = new Map(
    data?.coverage.wallets.map((c) => [c.wallet, c.status]) ?? [],
  );
  const status = (wallet: string): FollowingWalletCoverage["status"] | null =>
    coverage.get(wallet.toLowerCase()) ?? (loading ? "pending" : null);
  return {
    data,
    items: data?.items.filter((t) => followed.has(t.wallet)) ?? [],
    pending: loading || addresses.some((a) => status(a) === "pending"),
    error,
    loading,
    refresh,
    paused,
    setPaused,
    status,
  };
}

/** A followed wallet's own read state beside its name: loading until the feed
    has read it, and a plain mark where its read failed. A wallet whose last
    refresh failed keeps its rows and reads like any other. */
export function FollowStatus({
  status,
}: {
  status: FollowingWalletCoverage["status"] | null;
}) {
  return (
    <span className={styles.status}>
      {status === "pending" ? (
        <span key="pending" data-pending="true">
          Loading
        </span>
      ) : status === "unavailable" ? (
        <span key="unavailable">Unavailable</span>
      ) : null}
    </span>
  );
}

function TokenLink({ trade }: { trade: FollowingTrade }) {
  const label = trade.symbol ?? shortAddress(trade.token);
  return trade.poolId ? (
    <Link href={`/pool/${trade.poolId}/`} title={trade.name ?? trade.token}>
      {label}
    </Link>
  ) : (
    <span title={trade.name ?? trade.token}>{label}</span>
  );
}

export function FollowActivity({ feed }: { feed: FollowActivityFeed }) {
  const { data, items, error, loading, refresh, paused, setPaused } = feed;
  const failed = !!error && !data;
  const loaded = !!data && !feed.pending;
  const rows = Array.from(
    { length: reservedRowCount(FOLLOWING_ROWS, failed) },
    (_, index) => items[index],
  );
  const generatedAt = data
    ? Math.floor(Date.parse(data.coverage.generatedAt) / 1000)
    : null;
  return (
    <section
      className={`${styles.activity} following-activity`}
      aria-label="Following activity"
      id="following-activity"
    >
      <div className={styles.activityHeading}>
        <h2>Following activity</h2>
        <div className={styles.activityControls}>
          <button
            className="button secondary"
            onClick={() => setPaused(!paused)}
          >
            {paused ? "Resume updates" : "Pause updates"}
          </button>
          <button
            className="button secondary"
            onClick={refresh}
            disabled={loading}
          >
            Refresh activity
          </button>
        </div>
      </div>
      <p>
        Recent trades from wallets you follow. Informational, not advice. Trades
        are never executed here.
      </p>
      <div className={`wallet-positions-context ${styles.context}`}>
        <span role={error && data ? "alert" : undefined}>
          {error && data ? (
            <Fragment key="failed">Update failed</Fragment>
          ) : paused ? (
            <Fragment key="paused">Updates paused</Fragment>
          ) : null}
        </span>
        <span>Updated</span>
        <strong data-pending={generatedAt === null && !failed}>
          {generatedAt === null ? (
            failed ? (
              " "
            ) : (
              "Pending"
            )
          ) : (
            <time
              key={generatedAt}
              dateTime={new Date(generatedAt * 1000).toISOString()}
            >
              {utc(generatedAt)}
            </time>
          )}
        </strong>
      </div>
      <div className="table-region" data-empty={loaded && !items.length}>
        <div
          className="table-scroll wallet-list-region"
          data-failed={failed}
          aria-busy={feed.pending}
          data-stale-rows={false}
        >
          <table className="data-table following-trades-table">
            <colgroup>
              <col style={{ width: "180px" }} />
              <col />
              <col style={{ width: "170px" }} />
              <col style={{ width: "170px" }} />
              <col style={{ width: "80px" }} />
              <col style={{ width: "150px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Token</th>
                <th>Amount</th>
                <th>Time (UTC)</th>
                <th>Side</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, index) => (
                <tr
                  key={index}
                  aria-hidden={!t}
                  data-row={t ? "resolved" : "reserved"}
                  data-row-index={index}
                >
                  {t ? (
                    <Fragment key={t.id}>
                      <td>
                        <AddressChip
                          address={t.wallet}
                          href={`/wallet/${t.wallet}/`}
                        />
                      </td>
                      <td className="following-token">
                        <TokenLink trade={t} />
                      </td>
                      <td>
                        <span className="number">
                          <TradeAmount raw={t.tokenRaw} decimals={t.decimals} />
                        </span>
                      </td>
                      <td>
                        <TradeTime timestamp={t.timestamp} />
                      </td>
                      <td>
                        <TradeSide side={t.side} />
                      </td>
                      <td>
                        <TradeTransaction hash={t.txHash} />
                      </td>
                    </Fragment>
                  ) : (
                    <Fragment key="reserved">
                      {Array.from({ length: 6 }, (_, cell) => (
                        <td key={cell} data-pending={!loaded}>
                          <RowFiller blank={loaded} />
                        </td>
                      ))}
                    </Fragment>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div
          className="mobile-wallet-rows"
          aria-busy={feed.pending}
          data-stale-rows={false}
        >
          {rows.map((t, index) => (
            <div
              className="mobile-wallet-row"
              key={index}
              aria-hidden={!t}
              data-row={t ? "resolved" : "reserved"}
              data-row-index={index}
            >
              {t ? (
                <Fragment key={t.id}>
                  <div className="mobile-wallet-row-top">
                    <AddressChip
                      address={t.wallet}
                      href={`/wallet/${t.wallet}/`}
                    />
                    <TradeSide side={t.side} />
                  </div>
                  <div className="mobile-wallet-row-stats">
                    <TradeAmount raw={t.tokenRaw} decimals={t.decimals} />{" "}
                    <TokenLink trade={t} />
                  </div>
                  <div className="mobile-wallet-row-stats">
                    {t.timestamp !== null && (
                      <>
                        <TradeTime timestamp={t.timestamp} /> ·{" "}
                      </>
                    )}
                    <TradeTransaction hash={t.txHash} />
                  </div>
                </Fragment>
              ) : (
                <Fragment key={loaded ? "blank" : "pending"}>
                  <div className="mobile-wallet-row-top">
                    <span data-pending="true">
                      {loaded ? " " : "Trade pending"}
                    </span>
                  </div>
                  <div className="mobile-wallet-row-stats" data-pending="true">
                    {loaded ? " " : "Pending"}
                  </div>
                </Fragment>
              )}
            </div>
          ))}
        </div>
        {loaded && !items.length && (
          <EmptyState
            title="No recent trades"
            description="Trades from wallets you follow will appear here."
          />
        )}
      </div>
      {failed && (
        <UnavailableState subject="Following activity" onRetry={refresh} />
      )}
      {!failed && (
        <div className="pagination">
          <span className="pagination-count">
            {data?.hasMore ? (
              <Fragment key="more">
                Newest {FOLLOWING_ROWS} shown. Open a wallet for more.
              </Fragment>
            ) : (
              " "
            )}
          </span>
        </div>
      )}
    </section>
  );
}
