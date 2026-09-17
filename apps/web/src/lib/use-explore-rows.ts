"use client";
import { useEffect, useState } from "react";
import type { AnalyticsExploreResponse, AnalyticsPoolRow } from "@pools/core";
import { fetchProduct, type ProductDelivery } from "./use-product";

/** The most rows the read API serves in one request. */
const MAX_REQUEST_ROWS = 100;

type Loaded = {
  /** The explore query these rows answer, without its offset and limit. */
  query: string;
  /** The refresh that answered; rows from an earlier one read again. */
  generation: number;
  /** The rows on hand, in list order from the top. */
  rows: readonly AnalyticsPoolRow[];
  total: number;
  nextOffset: number | null;
  /** Where the first rows came from: a chunk from another source is the
      proxy's outage fallback, whose rows belong to another catalog and
      cannot join the list. */
  source: ProductDelivery["source"];
};
type Failure = { query: string; generation: number; message: string };

/**
 * The screener's rows, read from the top as far as `shown` reaches: one
 * request takes the rows on show (the read API's cap allowing), and each
 * Show more appends the next rows to the ones on hand. A query change drops
 * the previous query's rows, so the list swaps to skeletons until the new
 * query's first rows land; a refresh keeps every row in place and reads
 * them again. A read that fails stays failed, its rows blank, until a
 * refresh.
 */
export function useExploreRows(query: string, shown: number) {
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState<Failure>();
  const onHand = loaded?.query === query ? loaded : undefined;
  const current = onHand?.generation === generation ? onHand : undefined;
  const failed = failure?.query === query && failure.generation === generation;
  /* The next read: the whole shown span while this refresh has not answered,
     otherwise the rows on hand fall short of, until the list ends. */
  const offset = failed
    ? null
    : !current
      ? 0
      : current.rows.length < shown && current.nextOffset !== null
        ? current.rows.length
        : null;
  const limit =
    offset === null ? 0 : Math.min(MAX_REQUEST_ROWS, shown - offset);
  useEffect(() => {
    if (offset === null) return;
    const source = current?.source;
    const controller = new AbortController();
    const fail = (message: string) =>
      setFailure({ query, generation, message });
    /* The read waits a microtask, as `useProduct`'s does: the URL's query
       reaches a hydrating page one synchronous re-render after the default
       it painted with, whose read would otherwise already be on the wire. */
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      await fetchProduct<AnalyticsExploreResponse>(
        `explore?${query}&offset=${offset}&limit=${limit}`,
        controller.signal,
      ).then(
        (page) => {
          if (controller.signal.aborted) return;
          if (offset > 0 && page.delivery.source !== source) {
            fail("Saved data is temporarily unavailable.");
            return;
          }
          setFailure(undefined);
          setLoaded((prior) => {
            if (offset === 0)
              return {
                query,
                generation,
                rows: page.items,
                total: page.total,
                nextOffset: page.nextOffset,
                source: page.delivery.source,
              };
            /* A chunk joins the rows it was read to follow, or nothing. */
            if (prior?.query !== query || prior.generation !== generation)
              return prior;
            return {
              ...prior,
              rows: [...prior.rows, ...page.items],
              total: page.total,
              nextOffset: page.nextOffset,
            };
          });
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          fail(
            reason instanceof Error
              ? reason.message
              : "Saved data is unavailable.",
          );
        },
      );
    });
    return () => controller.abort();
  }, [query, generation, offset, limit, current]);
  return {
    /** This query's rows on hand, from the top, and the total they head;
        undefined until the query's first read lands. */
    list: onHand && { rows: onHand.rows, total: onHand.total },
    /** The rows on hand answer this very query and refresh, so an empty list is a real empty list. */
    settled: current !== undefined,
    loading: offset !== null,
    error: failure?.query === query ? failure.message : undefined,
    refresh: () => setGeneration((n) => n + 1),
  };
}
