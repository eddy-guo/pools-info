"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shortAddress, type FollowingActivityResponse } from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { Avatar, Price } from "./ui";
import { Eth, Unavailable, utc } from "./live-ui";
import { RowsSkeleton } from "./skeletons";
import styles from "./following.module.css";

export function FollowActivity({ addresses }: { addresses: string[] }) {
  const params = new URLSearchParams({
    wallets: [...addresses].sort().join(","),
    limit: "50",
  });
  const { data, error, loading, refresh } =
    useProduct<FollowingActivityResponse>(`following?${params}`);
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
  return (
    <section
      className={styles.activity}
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
        Verified activity from wallets you follow. Informational, not advice.
        Trades are never executed here.
      </p>
      {data && (
        <p className={styles.freshness}>
          {data.coverage.asOf
            ? `Latest saved cutoff ${utc(data.coverage.asOf)}.`
            : "No saved trades in this selection."}
          {data.coverage.oldestAsOf &&
          data.coverage.oldestAsOf !== data.coverage.asOf
            ? ` Oldest pool cutoff ${utc(data.coverage.oldestAsOf)}.`
            : ""}{" "}
          Partial pool coverage.{" "}
          {paused
            ? "Updates paused."
            : "Checks for saved updates every 30 seconds."}
        </p>
      )}
      {error && (
        <p role="alert">
          {data
            ? "Updates unavailable. Keeping the last saved activity."
            : "Following activity is temporarily unavailable."}
        </p>
      )}
      {loading && !data ? (
        <RowsSkeleton label="Loading following activity" />
      ) : data && !data.items.length ? (
        <div className={styles.empty}>
          No verified trades found for these wallets in saved coverage. This
          does not mean they have never traded.
        </div>
      ) : (
        <ul className={styles.trades}>
          {data?.items.map((row) => (
            <li key={row.id}>
              <div className={styles.tradeIdentity}>
                <Link href={`/wallet/${row.wallet}/`}>
                  <Avatar address={row.wallet} small />
                  <span>{shortAddress(row.wallet)}</span>
                </Link>
                <span className={row.side === "buy" ? "positive" : "negative"}>
                  {row.side === "buy" ? "Bought" : "Sold"}
                </span>
                <Link href={`/pool/${row.poolId}/`}>
                  {row.symbol || shortAddress(row.token)}
                </Link>
              </div>
              <div className={styles.tradeAmounts}>
                <Eth wei={row.ethWei} />
                <span>
                  Avg. execution price{" "}
                  {row.priceWei === null ? (
                    <Unavailable />
                  ) : (
                    <Price wei={row.priceWei} />
                  )}
                </span>
              </div>
              <div className={styles.tradeLinks}>
                <time dateTime={new Date(row.timestamp * 1000).toISOString()}>
                  {utc(row.timestamp)}
                </time>
                <a
                  href={`https://robinhoodchain.blockscout.com/tx/${row.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Transaction ↗
                </a>
                <a
                  href={`https://pools.xyz/t/robinhood/${row.token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="button secondary"
                >
                  Open on Pools ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data?.hasMore && (
        <p>
          Showing the newest 50 verified trades. Open a wallet profile for its
          saved history.
        </p>
      )}
    </section>
  );
}
