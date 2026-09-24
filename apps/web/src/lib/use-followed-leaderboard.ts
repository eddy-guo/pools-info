"use client";
import { useEffect, useState } from "react";
import type {
  AnalyticsWalletResponse,
  AnalyticsWalletSummary,
  LiveWindow,
} from "@pools/core";
import { DATA_UNAVAILABLE, fetchProduct } from "./use-product";
/** Followed wallets read one at a time from the leaderboard; this bounds how
    many of those requests are in flight together. */
const CONCURRENCY = 6;
function rank(w: AnalyticsWalletSummary) {
  return w.rank ?? Number.POSITIVE_INFINITY;
}
/**
 * The followed wallets, read individually from the wallet endpoint (the
 * leaderboard endpoint only returns the top-ranked page) and sorted like a
 * leaderboard. All requests settle together, so the list swaps once from its
 * reserved rows to the resolved ranking rather than reordering row by row.
 */
export function useFollowedLeaderboard(
  addresses: readonly string[],
  window: LiveWindow,
  active: boolean,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    items: AnalyticsWalletSummary[];
    error: string;
  }>({ key: "", items: [], error: "" });
  const key = `${window}:${attempt}:${addresses.join(",")}`;
  useEffect(() => {
    if (!active || !addresses.length) return;
    const controller = new AbortController();
    const results = new Array<AnalyticsWalletSummary | null>(
      addresses.length,
    ).fill(null);
    let failures = 0;
    let cursor = 0;
    async function worker() {
      for (;;) {
        const index = cursor++;
        if (index >= addresses.length) return;
        try {
          const { wallet } = await fetchProduct<AnalyticsWalletResponse>(
            `wallets/${addresses[index]}?window=${window}`,
            controller.signal,
          );
          results[index] = wallet;
        } catch {
          failures++;
        }
      }
    }
    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker),
    ).then(() => {
      if (controller.signal.aborted) return;
      const items = results
        .filter((w): w is AnalyticsWalletSummary => w !== null)
        .sort(
          (a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address),
        );
      setState({
        key,
        items,
        error: failures && !items.length ? DATA_UNAVAILABLE : "",
      });
    });
    return () => controller.abort();
  }, [addresses, key, window, active]);
  const hasAddresses = addresses.length > 0;
  const fetched = state.key === key;
  const loading = active && hasAddresses && !fetched;
  return {
    items: hasAddresses && fetched ? state.items : [],
    loading,
    stale: loading && state.items.length > 0,
    error: hasAddresses && fetched ? state.error : "",
    settled: !hasAddresses || fetched,
    /** Reruns every followed wallet's read, for the failed state's retry
        control. */
    refresh: () => setAttempt((n) => n + 1),
  };
}
