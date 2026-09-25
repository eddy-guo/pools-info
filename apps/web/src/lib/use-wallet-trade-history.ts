"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DATA_UNAVAILABLE, OUTSIDE_COVERAGE, retryAfterMilliseconds } from "./use-product";
import {
  validateWalletTradeHistoryResponse,
  type WalletHistoryTrade,
  type WalletTradeHistoryResponse,
} from "./wallet-trade-history-response";

/**
 * The rows revealed per "Load more" click, and the desktop/mobile row area's
 * fixed reservation while the first page is pending. Every other growable
 * list in the app sizes its reservation against a known `total`; this one
 * never learns one (a response reads exactly one 50-transfer explorer page,
 * so it holds 0 to 50 trades beside its own `nextCursor`), so growth always
 * keys off rows already on hand and `nextCursor`, never a count, and the
 * reservation never exceeds this step until the caller has actually revealed
 * more than it.
 */
export const REVEAL_STEP = 25;
/** A page crowded with other transfers or off-registry trades can read empty
    with real trades still behind it (docs/WALLET-TRADE-HISTORY.md): the first
    load chains through empty pages on its own, up to this many beyond the
    first, rather than showing a wall of blank reserved rows over an
    unexplained "Load more" for what is really still loading. Bounded so a
    wallet with no trades in the registry at all still settles in one page
    load's worth of explorer credits, not an unbounded chain. */
const MAX_EMPTY_CONTINUATIONS = 3;

function historyUrl(address: string, cursor: string | null) {
  const url = new URL(
    `/api/product/wallets/${address}/history/`,
    window.location.origin,
  );
  url.searchParams.set("kind", "trades");
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

type PageResult =
  | { ok: true; data: WalletTradeHistoryResponse }
  | { ok: false; error: string; retryAfterMs: number | null };

async function fetchPage(
  address: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<PageResult> {
  let response: Response;
  try {
    response = await fetch(historyUrl(address, cursor), {
      signal,
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: DATA_UNAVAILABLE, retryAfterMs: null };
  }
  if (!response.ok)
    return {
      ok: false,
      error: response.status === 503 ? DATA_UNAVAILABLE : OUTSIDE_COVERAGE,
      retryAfterMs:
        response.status === 503
          ? retryAfterMilliseconds(response.headers.get("retry-after"))
          : null,
    };
  const body: unknown = await response.json().catch(() => null);
  try {
    validateWalletTradeHistoryResponse(body, address);
  } catch {
    return { ok: false, error: DATA_UNAVAILABLE, retryAfterMs: null };
  }
  return { ok: true, data: body };
}

export interface WalletTradeHistoryState {
  /** Rows revealed so far; grows through `loadMore`. */
  trades: WalletHistoryTrade[];
  /** The first page is in flight and nothing is on hand yet. */
  loading: boolean;
  /** A further page is in flight to satisfy a `loadMore` call. */
  loadingMore: boolean;
  /** The first page failed: nothing to show, in place of the reserved rows. */
  failed: boolean;
  /** A later page's fetch failed; the rows already on hand stay on screen. */
  moreFailed: boolean;
  /** Whether `loadMore` can currently reveal or fetch anything further. */
  hasMore: boolean;
  /** Withheld until the server's own Retry-After delay on a 503 has passed. */
  canRetry: boolean;
  /** Unix seconds the most recent page was fetched, for the freshness stamp. */
  fetchedAt: number | null;
  loadMore: () => void;
  retry: () => void;
}

/**
 * On-demand only: the read this backs (`wallets/:address/history?kind=trades`)
 * is Blockscout PRO data billed per call, so `enabled` keeps it from firing
 * until the caller's Trades tab is actually open, and it fetches at most once
 * per mount past that regardless of how often the tab is revisited.
 */
export function useWalletTradeHistory(
  address: string,
  enabled: boolean,
): WalletTradeHistoryState {
  const [shown, setShown] = useState(REVEAL_STEP);
  const [held, setHeld] = useState<WalletHistoryTrade[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Whether the retry control may act right now: derived state kept in a
  // state variable (rather than compared against Date.now() at render time,
  // which the render-purity lint rule forbids) and flipped by the timer
  // below once the server's own delay has actually elapsed.
  const [canRetry, setCanRetry] = useState(true);
  const cursorRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const initialController = useRef<AbortController | null>(null);
  const moreControllerRef = useRef<AbortController | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  const runInitial = useCallback(() => {
    initialController.current?.abort();
    const controller = new AbortController();
    initialController.current = controller;
    clearRetryTimer();
    setLoading(true);
    setFailed(false);
    setMoreFailed(false);
    setHeld([]);
    setShown(REVEAL_STEP);
    setCanRetry(true);
    cursorRef.current = null;
    setNextCursor(null);
    void (async () => {
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        const result = await fetchPage(address, cursor, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setLoading(false);
          setFailed(true);
          if (result.retryAfterMs && result.retryAfterMs > 0) {
            setCanRetry(false);
            retryTimer.current = setTimeout(
              () => setCanRetry(true),
              result.retryAfterMs,
            );
          } else {
            setCanRetry(true);
          }
          return;
        }
        setFetchedAt(Math.floor(Date.parse(result.data.fetchedAt) / 1000));
        // An empty page with more behind it is still loading, not the wallet's
        // answer: chain forward rather than surfacing a blank, unexplained gap.
        if (
          result.data.items.length === 0 &&
          result.data.nextCursor !== null &&
          page < MAX_EMPTY_CONTINUATIONS
        ) {
          cursor = result.data.nextCursor;
          continue;
        }
        setLoading(false);
        setHeld(result.data.items);
        cursorRef.current = result.data.nextCursor;
        setNextCursor(result.data.nextCursor);
        return;
      }
    })();
  }, [address, clearRetryTimer]);

  useEffect(() => {
    startedRef.current = false;
  }, [address]);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    runInitial();
  }, [enabled, runInitial]);

  useEffect(
    () => () => {
      initialController.current?.abort();
      moreControllerRef.current?.abort();
      clearRetryTimer();
    },
    [clearRetryTimer],
  );

  const loadMore = useCallback(() => {
    if (shown < held.length) {
      setShown((s) => Math.min(s + REVEAL_STEP, held.length));
      return;
    }
    const cursor = cursorRef.current;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const controller = new AbortController();
    moreControllerRef.current = controller;
    const heldCount = held.length;
    void (async () => {
      let next: string | null = cursor;
      for (let page = 0; ; page++) {
        const result = await fetchPage(address, next, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setLoadingMore(false);
          setMoreFailed(true);
          return;
        }
        setFetchedAt(Math.floor(Date.parse(result.data.fetchedAt) / 1000));
        // Same chain-through-empty-pages rule the first load uses: an empty
        // page with more behind it is not this click's answer yet.
        if (
          result.data.items.length === 0 &&
          result.data.nextCursor !== null &&
          page < MAX_EMPTY_CONTINUATIONS
        ) {
          next = result.data.nextCursor;
          continue;
        }
        setLoadingMore(false);
        setHeld((prior) => [...prior, ...result.data.items]);
        setShown((s) =>
          Math.min(s + REVEAL_STEP, heldCount + result.data.items.length),
        );
        cursorRef.current = result.data.nextCursor;
        setNextCursor(result.data.nextCursor);
        return;
      }
    })();
  }, [address, held.length, shown, loadingMore]);

  const retry = useCallback(() => runInitial(), [runInitial]);

  return {
    trades: held.slice(0, shown),
    loading,
    loadingMore,
    failed,
    moreFailed,
    hasMore: shown < held.length || nextCursor !== null,
    canRetry,
    fetchedAt,
    loadMore,
    retry,
  };
}
