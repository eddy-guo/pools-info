"use client";
import { useEffect, useState } from "react";
import type {
  WalletHistoryKind,
  WalletHistoryResponse,
  WalletHistoryTokenTransfer,
  WalletHistoryTransaction,
  WalletHistoryUnavailable,
} from "@pools/core";
import { validateWalletHistoryResponse } from "./wallet-history-response";

export type WalletHistoryFailure = {
  reason: WalletHistoryUnavailable["reason"];
  /** Epoch milliseconds before which the read API says a retry is pointless. */
  retryAt: number;
};
type Items<K extends WalletHistoryKind> = K extends "transactions"
  ? WalletHistoryTransaction[]
  : WalletHistoryTokenTransfer[];
type Target = { key: string; cursor: string | null; attempt: number };

/** The product proxy serves the trailing-slash form; the cursor goes back verbatim. */
const historyUrl = (wallet: string, kind: string, cursor: string | null) =>
  `/api/product/wallets/${wallet}/history/?kind=${kind}` +
  (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

/**
 * One wallet tab's explorer pages, newest first. The first page is requested
 * only once the tab is open, each later page is appended without re-reading
 * the pages already on screen, and a 503 keeps its reason and Retry-After so
 * the panel can say when another attempt is worth making.
 */
export function useWalletHistory<K extends WalletHistoryKind>(
  wallet: string,
  kind: K,
  active: boolean,
) {
  const current = `${wallet}:${kind}`;
  const [seen, setSeen] = useState(current);
  const [pages, setPages] = useState<{
    key: string;
    list: WalletHistoryResponse[];
  }>({ key: current, list: [] });
  const [target, setTarget] = useState<Target | null>(null);
  const [failure, setFailure] = useState<
    (WalletHistoryFailure & Target) | null
  >(null);
  // A different wallet or tab is a different history; never show the old rows.
  if (seen !== current) {
    setSeen(current);
    setPages({ key: current, list: [] });
    setTarget(null);
    setFailure(null);
  } else if (active && !target && !failure && !pages.list.length)
    setTarget({ key: current, cursor: null, attempt: 0 });
  useEffect(() => {
    if (!target || target.key !== current) return;
    const controller = new AbortController();
    const stop = (outcome: WalletHistoryFailure | null) => {
      if (controller.signal.aborted) return false;
      if (outcome) setFailure({ ...target, ...outcome });
      setTarget(null);
      return true;
    };
    void Promise.resolve().then(async () => {
      try {
        const response = await fetch(historyUrl(wallet, kind, target.cursor), {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
          cache: "no-store",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          const seconds = Number(response.headers.get("retry-after"));
          stop({
            reason:
              response.status === 503 &&
              body?.error === "wallet_history_unavailable"
                ? (body.reason as WalletHistoryUnavailable["reason"])
                : "upstream_unavailable",
            retryAt:
              Date.now() +
              1000 *
                (Number.isSafeInteger(seconds) && seconds > 0
                  ? Math.min(seconds, 86400)
                  : 30),
          });
          return;
        }
        const page: unknown = await response.json();
        validateWalletHistoryResponse(page, wallet, kind);
        if (!controller.signal.aborted)
          setPages((prior) =>
            prior.key === target.key
              ? { key: prior.key, list: [...prior.list, page] }
              : prior,
          );
        stop(null);
      } catch {
        stop({ reason: "upstream_unavailable", retryAt: Date.now() + 30000 });
      }
    });
    return () => controller.abort();
  }, [current, wallet, kind, target]);
  const list = pages.key === current ? pages.list : [];
  const open = failure?.key === current ? failure : null;
  const loading = target?.key === current;
  const nextCursor = list.at(-1)?.nextCursor ?? null;
  return {
    // Every page in `list` carries this hook's own `kind`, which fixes the row type.
    items: list.flatMap<unknown>((page) => page.items) as unknown as Items<K>,
    /** A page is in flight: the rows it will fill are reserved below the current ones. */
    loading,
    nextCursor,
    failure: open as WalletHistoryFailure | null,
    loadMore: () => {
      if (!loading && nextCursor)
        setTarget({ key: current, cursor: nextCursor, attempt: 0 });
    },
    retry: () => {
      if (!open) return;
      setFailure(null);
      setTarget({
        key: current,
        cursor: open.cursor,
        attempt: open.attempt + 1,
      });
    },
  };
}
