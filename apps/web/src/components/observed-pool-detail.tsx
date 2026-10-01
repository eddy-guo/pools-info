"use client";
import Link from "next/link";
import { Fragment, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  poolWindow,
  shortAddress,
  since,
  type ChainMarket,
  type ChainSnapshot,
  type LiveWindow,
  type ObservedMarket,
} from "@pools/core";
import styles from "./detail-design.module.css";
import { AddressLabel, Change, NewTabNotice, Price, WatchButton } from "./ui";
import { Eth, Stat, Unavailable, explorer, utc } from "./live-ui";
import { PendingValue } from "./product-common";
import { PoolImage } from "./pool-image";
import { tokenLabel, tokenSubSymbol, tokenText } from "@/lib/token-identity";
import {
  Candles,
  ChartRangeControl,
  type ChartRange,
} from "./candles";
import { useHydrated } from "@/lib/use-hydrated";
import { countLabel } from "@/lib/plural";

export interface ObservedPoolIdentity {
  poolId: string;
  token: string;
  name: string;
  symbol: string;
  imageUrl?: string | null;
  /** The read API's launch type; absent while it is not known. */
  launchType?: "instant" | "crowd";
  launch: {
    block: number;
    timestamp: number;
    transactionHash: string;
    transactionInitiator: string;
  };
}
type NullableIdentity = Partial<Omit<ObservedPoolIdentity, "launch">> & {
  launch?: Partial<ObservedPoolIdentity["launch"]>;
};
/**
 * The 56px header of the export: the 54px identity image, the name with its
 * mono symbol and launch mode chip, then the short address beside
 * `launched <age> by <sender>`. `renderedAt` is the server's clock, so the
 * age it paints is the age the client hydrates.
 */
export function PoolHeading({
  id,
  pool,
  pending = false,
  renderedAt,
  children,
}: {
  id: string;
  pool?: NullableIdentity;
  pending?: boolean;
  renderedAt: number;
  children: React.ReactNode;
}) {
  const launch = pool?.launch;
  /* A served name reads through the token fallback; an unserved one keeps
     the page's own pending and unavailable wording. */
  const label = pool?.name !== undefined ? tokenLabel(pool) : undefined;
  /* Undefined while the symbol is not served; null when there is none to
     show beside the title (blank, or already the title itself). */
  const symbol =
    pool?.symbol === undefined
      ? undefined
      : pool.name === undefined
        ? tokenText(pool.symbol)
        : tokenSubSymbol(pool);
  return (
    <div className="page-heading">
      <div className={styles.identity}>
        <span className="pool-image-slot">
          {pool?.token ? (
            <PoolImage
              poolId={id}
              token={pool.token}
              symbol={pool.symbol}
              hasImage={!!pool.imageUrl}
              size="large"
            />
          ) : (
            <span className={styles.avatar} data-pending={pending}>
              Pool
            </span>
          )}
        </span>
        <div className="pool-heading-copy">
          <div className={`${styles.title} pool-identity-title`}>
            <h1 data-pending={pending && !label} title={label}>
              {label ??
                (pending ? "Loading saved pool" : "Pool name unavailable")}
            </h1>
            {/* The name's width settles with the response; the symbol and
                chip after it are new nodes then, not moved ones. A nameless
                token's symbol is already its title, so it is not repeated. */}
            <Fragment key={pending ? "pending" : "resolved"}>
              {symbol !== null && (
                <span
                  className={styles.symbol}
                  data-pending={pending && !symbol}
                >
                  {symbol ?? (pending ? "Pending" : <Unavailable />)}
                </span>
              )}
              {/* The launch mode as the read API names it, never assumed:
                  a pending read holds the chip's place, and a pool whose
                  launch type was not served shows none. */}
              {pool?.launchType ? (
                <span
                  className={`${styles.mode} ${pool.launchType === "crowd" ? styles.crowd : ""}`}
                >
                  {pool.launchType === "crowd" ? "CROWD" : "INSTANT"}
                </span>
              ) : (
                pending && (
                  <span className={styles.mode} data-pending="true">
                    INSTANT
                  </span>
                )
              )}
            </Fragment>
          </div>
          <div className="pool-meta">
            <span className="pool-address-slot">
              {pool?.token ? (
                <AddressLabel address={pool.token} />
              ) : pending ? (
                /* The skeleton has the short address's shape, so the line
                   after it stands still when the address lands. */
                <span className="address-label" data-pending="true">
                  <span className="sr-only">Token address pending</span>
                  <span className="mono" aria-hidden="true">
                    0x0000…0000
                  </span>
                  <span className="icon-button" />
                  <span className="icon-button" />
                </span>
              ) : (
                <span className="address-label mono">
                  Token address unavailable
                </span>
              )}
            </span>
            {/* What follows the address is remounted with it, never moved. */}
            <span
              key={pending ? "pending" : "resolved"}
              className="pool-launch-meta"
            >
              <PendingValue pending={pending && !launch}>
                {launch?.timestamp != null ? (
                  <>
                    launched{" "}
                    <time
                      dateTime={new Date(launch.timestamp * 1000).toISOString()}
                      title={utc(launch.timestamp)}
                    >
                      {since(launch.timestamp, renderedAt)}
                    </time>{" "}
                    ago
                  </>
                ) : (
                  "launch unavailable"
                )}
                {launch?.transactionInitiator && (
                  <>
                    {" "}
                    by{" "}
                    <Link
                      href={`/creators/${launch.transactionInitiator.toLowerCase()}/`}
                    >
                      {shortAddress(launch.transactionInitiator)}
                    </Link>
                  </>
                )}
              </PendingValue>
            </span>
          </div>
        </div>
      </div>
      <div className={styles.actions}>{children}</div>
    </div>
  );
}
/**
 * The chart panel's head: the price with its unit, the explicitly labelled
 * window changes the read API sent, and the range control on the same row.
 */
export function PoolChartHead({
  price,
  windows,
  pending = false,
  range,
  onRange,
}: {
  price?: string | null;
  windows: { window: LiveWindow; change: number }[];
  pending?: boolean;
  range: ChartRange;
  /** Absent when the panel holds no chart to range over. */
  onRange?: (range: ChartRange) => void;
}) {
  const hydrated = useHydrated();
  return (
    <div className="pool-chart-head">
      <div>
        <div className="live-price-heading">
          <Price wei={price} pending={pending} />
        </div>
        <div className="live-changes">
          {pending ? (
            <span key="pending" data-pending="true">
              24h pending
            </span>
          ) : (
            windows.map((w) => (
              <span key={w.window}>
                <b>{w.window}</b> <Change value={w.change} />
              </span>
            ))
          )}
        </div>
      </div>
      {onRange && (
        <ChartRangeControl
          value={range}
          onChange={onRange}
          disabled={!hydrated || pending}
        />
      )}
    </div>
  );
}
/** The changes the evidence supports, in the export's order; none is invented. */
export function windowChanges(
  market: ChainMarket | undefined,
  snapshot: ChainSnapshot | undefined,
  observed: ObservedMarket | undefined,
): { window: LiveWindow; change: number }[] {
  if (market && snapshot)
    return (["1h", "6h", "24h", "7d"] as const).flatMap((window) => {
      const { change } = poolWindow(market, snapshot, window);
      return change === null ? [] : [{ window, change }];
    });
  return observed?.change != null
    ? [{ window: observed.window, change: observed.change }]
    : [];
}
/** One nullable page persists while saved launch, market and accounting publications resolve. */
export function ObservedPoolDetail({
  id,
  pool,
  market,
  accountedMarket,
  snapshot,
  refresh,
  loading,
  pending = false,
  notice,
  chart = true,
  renderedAt,
}: {
  id: string;
  pool?: NullableIdentity;
  market?: ObservedMarket;
  accountedMarket?: ChainMarket;
  snapshot?: ChainSnapshot;
  refresh: () => void;
  loading: boolean;
  pending?: boolean;
  /** Why this page has no market to show, in place of the chart. */
  notice?: string;
  /** A chart can still arrive, so its region holds that height from first paint. */
  chart?: boolean;
  renderedAt: number;
}) {
  const [range, setRange] = useState<ChartRange>("All");
  const candles =
    !!(accountedMarket && snapshot) || !!market?.history.candles.length;
  const stat =
    accountedMarket && snapshot
      ? poolWindow(accountedMarket, snapshot, "24h")
      : null;
  const price = accountedMarket ? accountedMarket.priceWei : market?.priceWei;
  /* The volume and the trade count under it come from one source: the
     observed market's window when there is one, else the accounted cut. */
  const volume = market ? market.volumeWei : stat?.volumeWei;
  const trades = market ? market.trades : stat?.trades.length;
  const fdv =
    accountedMarket?.priceWei != null
      ? (
          (BigInt(accountedMarket.priceWei) * BigInt(accountedMarket.supply)) /
          10n ** BigInt(accountedMarket.decimals)
        ).toString()
      : (market?.fdvWei ?? undefined);
  /* The accounted cut knows the setting; the ledger's market carries it when
     known. Only a real boolean is a setting, so an absent flag stays
     unavailable rather than reading as Disabled. */
  const creatorFees = accountedMarket?.creatorFees ?? market?.creatorFees;
  const showChart = candles || (chart && pending);
  return (
    <div
      className={`page pool-page nullable-pool-page ${styles.page}`}
      aria-busy={pending}
    >
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Pools</Link>
        <span>/</span>
        <span data-pending={pending && !pool?.symbol}>
          {(pool?.symbol !== undefined &&
            (tokenText(pool.symbol) ?? tokenLabel(pool))) ||
            (pending ? "Pool pending" : "Pool")}
        </span>
      </nav>
      <PoolHeading
        id={id}
        pool={pool}
        pending={pending}
        renderedAt={renderedAt}
      >
        <WatchButton id={id} />
        <button
          className="icon-button"
          title="Refresh"
          aria-label="Refresh"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw size={14} />
        </button>
        <a
          className="button secondary"
          href={pool?.token ? `${explorer}/token/${pool.token}` : undefined}
          aria-disabled={!pool?.token}
          target="_blank"
          rel="noopener noreferrer"
        >
          Explorer ↗
          <NewTabNotice />
        </a>
        <a
          className="button"
          href={
            pool?.token
              ? `https://pools.xyz/t/robinhood/${pool.token}`
              : undefined
          }
          aria-disabled={!pool?.token}
          target="_blank"
          rel="noopener noreferrer"
        >
          Trade on Pools ↗
          <NewTabNotice />
        </a>
      </PoolHeading>
      <section className="panel pool-chart-panel">
        {/* A row with no market evidence has no price to head the panel
            with; its panel is the empty state alone. */}
        {(candles || chart) && (
          <PoolChartHead
            price={price}
            windows={windowChanges(accountedMarket, snapshot, market)}
            pending={pending}
            range={range}
            onRange={showChart ? setRange : undefined}
          />
        )}
        {/* The height is settled at first paint and never moves after it:
            a chart that can still arrive holds its full region, and a row
            with no market evidence opens on the empty state. */}
        <div
          className="pool-chart-region"
          data-chart={candles || chart ? "reserved" : "empty"}
        >
          {showChart ? (
            <Candles
              range={range}
              {...(accountedMarket && snapshot
                ? { market: accountedMarket, snapshot }
                : market
                  ? { observed: market }
                  : { poolId: id, pending })}
            />
          ) : (
            /* The reserved region is where the page says what it has, so a
               read that failed reports itself here rather than leaving a
               chart-shaped hole or, worse, a stored chart. */
            <div className="empty-state" role={notice ? "alert" : undefined}>
              <h2>{notice ?? "Price chart unavailable"}</h2>
            </div>
          )}
        </div>
      </section>
      <div className="stats-grid live-six-stats">
        <Stat label="FDV" pending={pending}>
          <Eth wei={fdv} pending={pending} />
        </Stat>
        <Stat
          label={`Volume ${market?.window ?? "24h"}`}
          pending={pending}
          note={trades == null ? undefined : countLabel(trades, "trade")}
        >
          <Eth wei={volume} pending={pending} />
        </Stat>
        <Stat label="Creator fee" pending={pending}>
          {creatorFees === true ? (
            "Enabled"
          ) : creatorFees === false ? (
            "Disabled"
          ) : (
            <Unavailable />
          )}
        </Stat>
      </div>
    </div>
  );
}
