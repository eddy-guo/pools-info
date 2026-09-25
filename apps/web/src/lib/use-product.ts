"use client";
import { useCallback, useEffect, useState } from "react";
import { normalizePoolLaunch, validatePoolResponse } from "./pool-response";
export type ProductDelivery = {
  /** "preloaded" only ever reaches a fixture deployment; see product-server.ts. */
  source: "indexer" | "preloaded";
};
/**
 * What every surface says when its read could not be served. There is no
 * second sentence: no as-of line, no cached figure, no explanation of the
 * pipeline behind it.
 */
export const DATA_UNAVAILABLE = "Live data is unavailable.";
/** The read was answered, and the answer is that this item is not covered. */
export const OUTSIDE_COVERAGE = "This item is outside available coverage.";
export type Delivered<T> = T & { delivery: ProductDelivery };
/** The endpoint identity: the same list or entity under different query parameters. */
const resource = (path: string) => path.split("?")[0];
/** Request the trailing-slash form the app serves, rather than paying its 308. */
const productUrl = (path: string) =>
  `/api/product/${resource(path)}/${path.slice(resource(path).length)}`;
export function retryAfterMilliseconds(value: string | null, now = Date.now()) {
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
function waitForRetry(delay: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** How long a single request to the proxy is given before it is cut short,
    warming or not. */
const REQUEST_TIMEOUT_MS = 12000;
/** The read API's warming gate runs one warm attempt for up to a minute
    (`docs/DATABASE-WARMING.md`); the client keeps honoring the server's own
    Retry-After guidance for as many warming responses as land inside that
    same ceiling, so warming stays a loading state rather than surfacing as
    an error after one retry. A database still warming past it is finally
    reported unavailable instead of retried forever. */
const WARMING_CEILING_MS = 60000;
/** Whether a 503 body is the warming reason the proxy documents, as opposed
    to a generic outage with no useful Retry-After to honor. */
async function isWarming(response: Response) {
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { reason?: unknown }).reason === "warming"
  );
}
/** One product read through the app's own proxy. Each request is cut short
    at `REQUEST_TIMEOUT_MS`; a warming 503 is retried after its own
    Retry-After delay, repeatedly, as long as the database keeps reporting
    warming and the retry stays inside `WARMING_CEILING_MS` of the first
    request - malformed or missing Retry-After guidance stops the loop
    immediately rather than retrying blindly. */
export async function fetchProduct<T>(path: string, signal: AbortSignal) {
  const deadline = Date.now() + WARMING_CEILING_MS;
  const request = () => {
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    return fetch(productUrl(path), {
      signal: requestSignal,
      cache: "no-store",
    });
  };
  let response = await request();
  while (response.status === 503 && (await isWarming(response))) {
    const delay = retryAfterMilliseconds(response.headers.get("retry-after"));
    if (delay === null) break;
    if (Date.now() + delay > deadline) break;
    await waitForRetry(delay, signal);
    response = await request();
  }
  /* A 503 is the proxy reporting that it has nothing live to serve; anything
     else it answers with is a real answer about this item. */
  if (!response.ok)
    throw Error(response.status === 503 ? DATA_UNAVAILABLE : OUTSIDE_COVERAGE);
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
            error: error instanceof Error ? error.message : DATA_UNAVAILABLE,
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
