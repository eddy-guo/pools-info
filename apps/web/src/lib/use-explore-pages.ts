"use client";
import { useEffect, useState } from "react";
import type { AnalyticsExploreResponse, AnalyticsPoolRow } from "@pools/core";
import { fetchProduct, type Delivered } from "./use-product";

/** The read API's screener page; every request here asks for exactly this many rows. */
export const PAGE_SIZE = 25;

/** The rows a list has on screen, first and last index inclusive. */
export type RowSpan = { start: number; end: number };

type ExplorePage = Delivered<AnalyticsExploreResponse>;

type Loaded = {
  /** The explore query these pages answer, without its offset. */
  query: string;
  /** The refresh that last answered; pages from an earlier one read again. */
  generation: number;
  /** Rows by the offset the read API served them at. */
  pages: ReadonlyMap<
    number,
    { generation: number; rows: readonly AnalyticsPoolRow[] }
  >;
  /** The page that arrived first for this refresh: its total sizes the list
      and its rows decide the list's shape, so no later page can resize or
      reshape it. */
  head: ExplorePage;
};

type Wanted = { query: string; generation: number; offset: number };
/** The pages of one refresh that did not answer, and the last reason. */
type Failure = {
  query: string;
  generation: number;
  offsets: ReadonlySet<number>;
  message: string;
};

const pageOffset = (index: number) => index - (index % PAGE_SIZE);

/**
 * The screener's rows, read one 25-row page at a time for the rows on screen:
 * `reach` names the rows a list is showing, and the first page among them
 * that has not arrived is requested. A query change keeps the previous list,
 * marked stale, until the new query's first page lands; a refresh keeps every
 * row in place and reads the pages on screen again.
 */
export function useExplorePages(query: string) {
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const [wanted, setWanted] = useState<Wanted | null>(null);
  const [failure, setFailure] = useState<Failure>();
  const current = loaded?.query === query ? loaded : undefined;
  /* A page that failed stays failed, and its rows blank, until a refresh
     reads it again; the pages around it still read as the span reaches them,
     and the failure stays on view until a refresh answers. */
  const failed =
    failure?.query === query && failure.generation === generation
      ? failure.offsets
      : undefined;
  const error = failure?.query === query ? failure.message : undefined;
  const offset =
    wanted?.query === query &&
    wanted.generation === generation &&
    !failed?.has(wanted.offset)
      ? wanted.offset
      : null;
  useEffect(() => {
    if (
      offset === null ||
      current?.pages.get(offset)?.generation === generation
    )
      return;
    /* A page from another source than this refresh's first page is the
       proxy's outage fallback, whose rows belong to another catalog: it reads
       as unavailable instead of joining the list. */
    const source =
      current?.generation === generation
        ? current.head.delivery.source
        : undefined;
    const fail = (message: string) =>
      setFailure((prior) => ({
        query,
        generation,
        offsets: new Set(
          prior?.query === query && prior.generation === generation
            ? prior.offsets
            : [],
        ).add(offset),
        message,
      }));
    const controller = new AbortController();
    void fetchProduct<AnalyticsExploreResponse>(
      `explore?${query}&limit=${PAGE_SIZE}&offset=${offset}`,
      controller.signal,
    ).then(
      (page) => {
        if (controller.signal.aborted) return;
        if (source !== undefined && page.delivery.source !== source) {
          fail("Saved data is temporarily unavailable.");
          return;
        }
        setFailure((prior) =>
          prior?.query === query && prior.generation === generation
            ? prior
            : undefined,
        );
        setLoaded((prior) => ({
          query,
          generation,
          pages: new Map(prior?.query === query ? prior.pages : []).set(
            offset,
            { generation, rows: page.items },
          ),
          head:
            prior?.query === query && prior.generation === generation
              ? prior.head
              : page,
        }));
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
    return () => controller.abort();
  }, [query, generation, offset, current]);
  return {
    /** The row at `index` of the list on screen; undefined until its page arrives. */
    row: (index: number) =>
      loaded?.pages.get(pageOffset(index))?.rows[index % PAGE_SIZE],
    /** The list on screen: this query's, or the previous one while stale. */
    list: loaded,
    /** Rows on screen answer an earlier query or an earlier refresh. */
    stale:
      loaded !== undefined &&
      (loaded.query !== query || loaded.generation !== generation),
    /** This query has answered, so an empty list is a real empty list. */
    settled: current !== undefined,
    loading: offset !== null,
    error,
    /* The first page the span needs that this refresh has not answered or
       failed; with no list yet, the page the span starts on. An empty list
       still reads its first page again on refresh. */
    reach(span: RowSpan | null) {
      const start = pageOffset(Math.max(0, span?.start ?? 0));
      let next: number | null = current ? null : start;
      if (current && span) {
        const last = Math.max(
          start,
          Math.min(span.end, current.head.total - 1),
        );
        for (let at = start; at <= last; at += PAGE_SIZE)
          if (
            !failed?.has(at) &&
            current.pages.get(at)?.generation !== generation
          ) {
            next = at;
            break;
          }
      }
      setWanted((prior) =>
        next === null
          ? null
          : prior?.query === query &&
              prior.generation === generation &&
              prior.offset === next
            ? prior
            : { query, generation, offset: next },
      );
    },
    refresh: () => setGeneration((n) => n + 1),
  };
}
