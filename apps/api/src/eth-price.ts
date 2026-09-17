import type { EthPriceResponse } from "@pools/core";
import { RequestError } from "./request";

export const coinbaseSpotUrl = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

export interface EthPriceService {
  read(): Promise<EthPriceResponse>;
}

interface CacheEntry {
  value: EthPriceResponse;
  fetchedAt: number;
}

function parseUsdPerEth(body: unknown): number {
  const amount =
    typeof body === "object" && body !== null
      ? (body as { data?: { amount?: unknown } }).data?.amount
      : undefined;
  const usdPerEth = typeof amount === "string" ? Number(amount) : NaN;
  if (!Number.isFinite(usdPerEth) || usdPerEth <= 0) throw Error("invalid_amount");
  return usdPerEth;
}

/** Coinbase's keyless public spot endpoint, held as one in-process
 * stale-while-revalidate entry: fresh under `freshMs`, served stale (with a
 * background refresh, rate-limited to `minRefreshIntervalMs`) under
 * `staleMs`, and 503 past that or before any value has ever been fetched. A
 * request that already has a usable (fresh or stale) cached value never waits
 * on the network; only a cold or expired cache blocks, and only up to
 * `fetchTimeoutMs`. Concurrent refreshes share one in-flight fetch. */
export function createEthPriceService({
  fetchImpl = fetch,
  now = Date.now,
  freshMs = 60_000,
  staleMs = 600_000,
  minRefreshIntervalMs = 60_000,
  fetchTimeoutMs = 5000,
  url = coinbaseSpotUrl,
}: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  freshMs?: number;
  staleMs?: number;
  minRefreshIntervalMs?: number;
  fetchTimeoutMs?: number;
  url?: string;
} = {}): EthPriceService {
  let cache: CacheEntry | null = null;
  let lastAttempt = -Infinity;
  let inFlight: Promise<EthPriceResponse> | null = null;

  async function fetchPrice(): Promise<EthPriceResponse> {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (response.status !== 200)
      throw Error(`upstream_status_${response.status}`);
    const usdPerEth = parseUsdPerEth(await response.json());
    const fetchedAt = now();
    const value: EthPriceResponse = {
      usdPerEth,
      asOf: new Date(fetchedAt).toISOString(),
      source: "coinbase",
    };
    cache = { value, fetchedAt };
    return value;
  }

  function refresh(): Promise<EthPriceResponse> {
    lastAttempt = now();
    const task = fetchPrice().finally(() => {
      if (inFlight === task) inFlight = null;
    });
    inFlight = task;
    return task;
  }

  return {
    async read() {
      const t = now();
      const age = cache ? t - cache.fetchedAt : Infinity;
      if (cache && age < freshMs) return cache.value;
      if (cache && age < staleMs) {
        if (!inFlight && t - lastAttempt >= minRefreshIntervalMs)
          void refresh().catch(() => undefined);
        return cache.value;
      }
      try {
        if (inFlight) return await inFlight;
        if (t - lastAttempt < minRefreshIntervalMs) throw Error("rate_limited");
        return await refresh();
      } catch {
        throw new RequestError(503, "price_unavailable", { retryAfter: 30 });
      }
    },
  };
}
