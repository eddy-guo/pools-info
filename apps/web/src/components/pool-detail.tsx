"use client";
import Link from "next/link";
import styles from "./detail-design.module.css";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  poolWindow,
  type AnalyticsPoolDetail,
  type ObservedMarket,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { useRememberedPoolRow } from "@/lib/pool-row-memory";
import { useQuery } from "./state";
import { useLive } from "./live-provider";
import { WatchButton } from "./ui";
import { Eth, Stat, explorer, useMarket } from "./live-ui";
import { Candles, type ChartRange } from "./candles";
import {
  ObservedPoolDetail,
  PoolChartHead,
  PoolHeading,
  windowChanges,
  type ObservedPoolIdentity,
} from "./observed-pool-detail";
/** `renderedAt` is the server's clock at render, the basis of the launch age. */
export function PoolDetail({
  id,
  renderedAt,
}: {
  id: string;
  renderedAt: number;
}) {
  const { params } = useQuery();
  const {
    market: loadedMarket,
    snapshot: loadedSnapshot,
    loading,
    refresh,
    refreshing,
  } = useMarket(id, params.get("launch"));
  const { audits, snapshot: initialSnapshot } = useLive();
  const [preloadedIds] = useState(
    () => new Set(initialSnapshot.markets.map((market) => market.id)),
  );
  const saved = useProduct<{
    name: string;
    symbol: string;
    token: string;
    imageUrl?: string | null;
    pool?: {
      poolId: string;
      name: string;
      symbol: string;
      token: string;
      imageUrl?: string | null;
    };
    analytics: AnalyticsPoolDetail | null;
    market?: ObservedMarket;
  }>(`pools/${id}`);
  const remembered = useRememberedPoolRow(id);
  /* Hydration paints the server's markup, which never sees a remembered row, so
     only an arrival from a row can size the chart region before the first
     paint. Reading it once keeps that region's height fixed from then on. */
  const [expectChart] = useState(() => remembered?.measured !== false);
  const savedIdentity = saved.data?.pool ?? saved.data;
  const publication = saved.data?.analytics;
  const publishedMarket = publication?.snapshot.markets.find(
    (m) => m.id === id && m.accounting?.executions,
  );
  const usePublished =
    publishedMarket &&
    (!loadedMarket?.accounting?.executions ||
      // useMarket already prefers its refreshed response at the same cutoff.
      // A matching publication must not replace that response with old data.
      publication!.snapshot.toBlock > loadedSnapshot.toBlock);
  const m = usePublished ? publishedMarket : loadedMarket;
  const s = usePublished ? publication!.snapshot : loadedSnapshot;
  const [range, setRange] = useState<ChartRange>("All");
  if (!preloadedIds.has(id)) {
    const pool =
      savedIdentity || m || remembered
        ? {
            poolId: id,
            name: savedIdentity?.name ?? m?.name ?? remembered?.name,
            symbol: savedIdentity?.symbol ?? m?.symbol ?? remembered?.symbol,
            token: savedIdentity?.token ?? m?.token ?? remembered?.token,
            imageUrl: savedIdentity?.imageUrl ?? remembered?.imageUrl,
            launch:
              "launch" in (savedIdentity ?? {})
                ? (savedIdentity as ObservedPoolIdentity).launch
                : m
                  ? {
                      timestamp: m.launchedAt,
                      transactionHash: m.launchTx,
                      transactionInitiator: m.launchSender,
                    }
                  : remembered?.launch,
          }
        : undefined;
    return (
      <ObservedPoolDetail
        id={id}
        pool={pool}
        market={saved.data?.market}
        accountedMarket={m}
        snapshot={m ? s : undefined}
        chart={expectChart}
        refresh={() => {
          refresh();
          saved.refresh();
        }}
        loading={loading || saved.loading || refreshing}
        pending={!saved.data && !m && saved.loading}
        renderedAt={renderedAt}
      />
    );
  }
  if (
    saved.data?.market &&
    saved.data.pool &&
    !m?.accounting?.executions &&
    !audits[id]
  )
    return (
      <ObservedPoolDetail
        id={id}
        pool={saved.data.pool as ObservedPoolIdentity}
        market={saved.data.market}
        refresh={saved.refresh}
        loading={saved.loading}
        renderedAt={renderedAt}
      />
    );
  if (!m)
    return (
      <div className={`page ${styles.page}`}>
        <h1>
          {savedIdentity?.name ??
            remembered?.name ??
            (loading ? "Loading saved pool…" : "Pool name unavailable")}
        </h1>
        <Link className="button" href="/">
          Explore pools
        </Link>
      </div>
    );
  const stats = poolWindow(m, s, "24h"),
    fdv =
      m.priceWei === null
        ? null
        : (
            (BigInt(m.priceWei) * BigInt(m.supply)) /
            10n ** BigInt(m.decimals)
          ).toString();
  return (
    <div className={`page pool-page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Pools</Link>
        <span>/</span>
        <span>{m.symbol}</span>
      </nav>
      <PoolHeading
        id={m.id}
        pool={{
          poolId: m.id,
          name: m.name,
          symbol: m.symbol,
          token: m.token,
          imageUrl: savedIdentity?.imageUrl,
          launch: {
            timestamp: m.launchedAt,
            transactionHash: m.launchTx,
            transactionInitiator: m.launchSender,
          },
        }}
        renderedAt={renderedAt}
      >
        <WatchButton id={m.id} />
        <button
          className="icon-button"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => {
            refresh();
            saved.refresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw size={14} />
        </button>
        <a
          className="button secondary"
          href={`${explorer}/token/${m.token}`}
          target="_blank"
          rel="noreferrer"
        >
          Explorer ↗
        </a>
        <a
          className="button"
          href={`https://pools.xyz/t/robinhood/${m.token}`}
          target="_blank"
          rel="noreferrer"
        >
          Trade on Pools ↗
        </a>
      </PoolHeading>
      <section className="panel pool-chart-panel">
        <PoolChartHead
          price={m.priceWei}
          change={stats.change}
          windows={windowChanges(m, s, undefined)}
          range={range}
          onRange={setRange}
        />
        <div className="pool-chart-region" data-chart="reserved">
          <Candles range={range} market={m} snapshot={s} />
        </div>
      </section>
      <div className="stats-grid live-six-stats">
        <Stat label="FDV">
          <Eth wei={fdv} digits={5} />
        </Stat>
        <Stat
          label="Volume 24h"
          note={`${stats.trades.length.toLocaleString("en-US")} trades`}
        >
          <Eth wei={stats.volumeWei} digits={5} />
        </Stat>
        <Stat label="Creator fee">
          {m.creatorFees ? "Enabled" : "Disabled"}
        </Stat>
      </div>
    </div>
  );
}
