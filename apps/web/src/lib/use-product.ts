"use client";
import { useCallback, useEffect, useState } from "react";
import { normalizePoolLaunch, validatePoolResponse } from "./pool-response";
export type ProductDelivery = {
  source: "indexer" | "preloaded";
  notice: string | null;
};
export type Delivered<T> = T & { delivery: ProductDelivery };
/** The endpoint identity: the same list or entity under different query parameters. */
const resource = (path: string) => path.split("?")[0];
/** Request the trailing-slash form the app serves, rather than paying its 308. */
const productUrl = (path: string) =>
  `/api/product/${resource(path)}/${path.slice(resource(path).length)}`;
/** One product read through the app's own proxy, on a 12s budget the caller can cut short. */
export async function fetchProduct<T>(path: string, signal: AbortSignal) {
  const response = await fetch(productUrl(path), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    cache: "no-store",
  });
  if (!response.ok) throw Error("Saved data is temporarily unavailable.");
  const data = (await response.json()) as Delivered<T>;
  if (path.startsWith("pools/")) {
    const url = new URL(path, "http://localhost");
    validatePoolResponse(
      data,
      url.pathname.slice(7),
      url.searchParams.get("window") ?? "24h",
    );
    normalizePoolLaunch(data);
  }
  return data;
}
/**
 * Keep the last rows of the same resource while a re-query runs, marked stale;
 * never show another entity's rows.
 */
export function useProduct<T>(path: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    path: string;
    data?: Delivered<T>;
    error?: string;
    pending: boolean;
  }>({ path, pending: true });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setState((prior) => ({
        path,
        data: resource(prior.path) === resource(path) ? prior.data : undefined,
        pending: true,
      }));
      try {
        const data = await fetchProduct<T>(path, controller.signal);
        if (!controller.signal.aborted)
          setState({ path, data, pending: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((prior) => ({
            path,
            data: prior.path === path ? prior.data : undefined,
            pending: false,
            error:
              error instanceof Error
                ? error.message
                : "Saved data is unavailable.",
          }));
      }
    });
    return () => controller.abort();
  }, [path, attempt]);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const current = state.path === path,
    data = resource(state.path) === resource(path) ? state.data : undefined,
    loading = !current || state.pending;
  return {
    data,
    error: current ? state.error : undefined,
    loading,
    /** Rows on screen belong to the previous query of this resource. */
    stale: loading && data !== undefined,
    refresh,
  };
}
