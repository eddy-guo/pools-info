"use client";
import { useCallback, useEffect, useState } from "react";
import { validatePoolResponse } from "./pool-response";
export type ProductDelivery = {
  source: "indexer" | "preloaded";
  notice: string | null;
};
export type Delivered<T> = T & { delivery: ProductDelivery };
/** Keep the last matching page while a refresh runs; never show another query's rows. */
export function useProduct<T>(path: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    path: string;
    data?: Delivered<T>;
    error?: string;
    pending: boolean;
  }>({ path, pending: true });
  useEffect(() => {
    const reload = () => setAttempt((n) => n + 1);
    window.addEventListener("product-refresh", reload);
    return () => window.removeEventListener("product-refresh", reload);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setState((prior) => ({
        path,
        data: prior.path === path ? prior.data : undefined,
        pending: true,
      }));
      try {
        const response = await fetch(`/api/product/${path}`, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
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
        }
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
  return {
    data: state.path === path ? state.data : undefined,
    error: state.path === path ? state.error : undefined,
    loading: state.path !== path || state.pending,
    refresh,
  };
}
