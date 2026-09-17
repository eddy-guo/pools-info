"use client";
import { useState } from "react";
import { type AnalyticsPoolDetail, type ObservedMarket } from "@pools/core";
import { DATA_UNAVAILABLE, useProduct } from "@/lib/use-product";
import { useRememberedPoolRow } from "@/lib/pool-row-memory";
import { useQuery } from "./state";
import { useMarket } from "./live-ui";
import {
  ObservedPoolDetail,
  type ObservedPoolIdentity,
} from "./observed-pool-detail";
/**
 * The pool page, served by the read API through the app's own proxy.
 *
 * There is one page here rather than two. The committed snapshot in this
 * bundle used to render a second, complete page for the handful of pools it
 * happens to contain, which meant an outage left those pools showing days-old
 * prices and volumes as if they were current. Every pool now reads from the
 * proxy, and a read that cannot be served leaves the page on its unavailable
 * state with no figures at all.
 *
 * `renderedAt` is the server's clock at render, the basis of the launch age.
 */
export function PoolDetail({
  id,
  renderedAt,
}: {
  id: string;
  renderedAt: number;
}) {
  const { params } = useQuery();
  const saved = useProduct<{
    name: string;
    symbol: string;
    token: string;
    imageUrl?: string | null;
    launch?: ObservedPoolIdentity["launch"];
    pool?: {
      poolId: string;
      name: string;
      symbol: string;
      token: string;
      imageUrl?: string | null;
      launch?: ObservedPoolIdentity["launch"];
    };
    analytics: AnalyticsPoolDetail | null;
    market?: ObservedMarket;
  }>(`pools/${id}`);
  const savedIdentity = saved.data?.pool ?? saved.data;
  /* The accounted cut is a second read, and only a link that already names
     the launch asks for it: this pool's own read carries its publication, so
     a bare URL costs the read API one request, as it did before. */
  const launch = params.get("launch");
  const {
    market: loadedMarket,
    snapshot: loadedSnapshot,
    refresh,
    refreshing,
    loading,
  } = useMarket(id, launch);
  const remembered = useRememberedPoolRow(id);
  /* Hydration paints the server's markup, which never sees a remembered row, so
     only an arrival from a row can size the chart region before the first
     paint. Reading it once keeps that region's height fixed from then on. */
  const [expectChart] = useState(() => remembered?.measured !== false);
  const publication = saved.data?.analytics;
  const publishedMarket = publication?.snapshot.markets.find(
    (m) => m.id === id && m.accounting?.executions,
  );
  const usePublished =
    publishedMarket &&
    (!loadedMarket?.accounting?.executions ||
      !loadedSnapshot ||
      // useMarket already prefers its refreshed response at the same cutoff.
      // A matching publication must not replace that response with old data.
      publication!.snapshot.toBlock > loadedSnapshot.toBlock);
  const m = usePublished ? publishedMarket : loadedMarket;
  const s = usePublished ? publication!.snapshot : loadedSnapshot;
  const pending = !saved.data && !m && saved.loading;
  /* Nothing was served, so nothing is shown: the page keeps its reserved
     shape and says why in place of the chart. A read the API answered, saying
     this pool has no published detail, is not that: the page keeps its own
     "Price chart unavailable" for it. */
  const notice =
    saved.error === DATA_UNAVAILABLE && !saved.data && !m
      ? DATA_UNAVAILABLE
      : undefined;
  const pool =
    savedIdentity || m || remembered
      ? {
          poolId: id,
          name: savedIdentity?.name ?? m?.name ?? remembered?.name,
          symbol: savedIdentity?.symbol ?? m?.symbol ?? remembered?.symbol,
          token: savedIdentity?.token ?? m?.token ?? remembered?.token,
          imageUrl: savedIdentity?.imageUrl ?? remembered?.imageUrl,
          launch:
            savedIdentity?.launch ??
            (m
              ? {
                  block: m.launchBlock,
                  timestamp: m.launchedAt,
                  transactionHash: m.launchTx,
                  transactionInitiator: m.launchSender,
                }
              : remembered?.launch),
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
      pending={pending}
      notice={notice}
      renderedAt={renderedAt}
    />
  );
}
