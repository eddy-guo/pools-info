"use client";
import { useEffect, useSyncExternalStore } from "react";

/**
 * A read's own cut: the chain timestamp it was answered through and, where
 * the response names it, the block. Never a client clock and never a block
 * taken from another read; a page whose reads carry no cut shows no stamp.
 */
export type FreshnessCut = { block: number | null; asOf: number };

/** Seconds since a cut, as the stamp prints them: exact seconds under a
    minute, then whole minutes, hours and days. */
export function indexedAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The stamp's block part, for a read that named its block. */
export const stampBlock = (block: number) =>
  `block ${block.toLocaleString("en-US")}`;

/** The stamp's lag part: how long before `now` the cut was indexed. */
export const stampLag = (asOf: number, now: number) =>
  `indexed ${indexedAgo(now - asOf)} ago`;

/** The whole stamp for a cut at a clock reading, as the header prints it. */
export function freshnessStamp(cut: FreshnessCut, now: number): string {
  const lag = stampLag(cut.asOf, now);
  return cut.block === null ? lag : `${stampBlock(cut.block)} · ${lag}`;
}

/* One store for the whole app: each page reports the cut of the read that
   answers it under a source name, and the shell's stamp shows the page's
   cut derived from what is reported right now. A page can have two reads
   that both carry a cut (the screener's stats name a block, its explore
   rows only a timestamp); the one naming its block wins, and between two of
   a kind the newer does. */
const reported = new Map<string, FreshnessCut>();
const listeners = new Set<() => void>();
let snapshot: FreshnessCut | null = null;

const same = (a: FreshnessCut | null, b: FreshnessCut | null) =>
  a === b || (!!a && !!b && a.block === b.block && a.asOf === b.asOf);

function derive(): FreshnessCut | null {
  let best: FreshnessCut | null = null;
  for (const cut of reported.values()) {
    if (best === null) best = cut;
    else if ((cut.block !== null) !== (best.block !== null)) {
      if (cut.block !== null) best = cut;
    } else if (cut.asOf > best.asOf) best = cut;
  }
  return best;
}

/** Records one source's cut, or withdraws it with null. */
export function reportCut(source: string, cut: FreshnessCut | null) {
  if (cut === null) {
    if (!reported.delete(source)) return;
  } else {
    if (same(reported.get(source) ?? null, cut)) return;
    reported.set(source, cut);
  }
  const next = derive();
  if (same(next, snapshot)) return;
  snapshot = next;
  for (const notify of listeners) notify();
}

/** The page's cut as the stamp shows it right now; for tests. */
export const currentCut = () => snapshot;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => snapshot;
const getServerSnapshot = () => null;

/** The page's cut, or null while no mounted page has reported one. */
export function useFreshnessCut(): FreshnessCut | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Reports a read's cut under `source` for as long as the caller is mounted:
 * an undefined or null timestamp withdraws it (nothing served, or a read
 * that failed), and unmounting withdraws it too, so a route change never
 * leaves the previous page's cut on the stamp. Each caller names its own
 * source, so two pages never withdraw each other's cut as one replaces the
 * other.
 */
export function useReportCut(
  source: string,
  block: number | null | undefined,
  asOf: number | null | undefined,
) {
  const namedBlock = block ?? null;
  const at = asOf ?? null;
  useEffect(() => {
    reportCut(source, at === null ? null : { block: namedBlock, asOf: at });
  }, [source, namedBlock, at]);
  useEffect(() => () => reportCut(source, null), [source]);
}
