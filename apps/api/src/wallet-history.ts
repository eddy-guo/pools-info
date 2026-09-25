import type {
  WalletHistoryKind,
  WalletHistoryResponse,
  WalletHistoryTrade,
  WalletHistoryUnavailable,
} from "@pools/core";
import {
  BlockscoutError,
  createBlockscoutClient,
  creditCost,
  type BlockscoutClient,
  type PageParams,
} from "./blockscout-client";
import { encodeHistoryCursor } from "./history-cursor";
import { RequestError } from "./request";
import type { TokenRegistry } from "./token-registry";

const note =
  "Explorer history for display only; not accounting or PnL evidence." as const;

/** A wallet's first explorer page of trades as the cache holds it. */
export interface TradesSnapshot {
  items: WalletHistoryTrade[];
  /** The explorer's own position of the next page, null at the end. */
  next: PageParams | null;
  /** Epoch milliseconds the page was read from the explorer. */
  fetchedAt: number;
  /** True when a refresh failed and this is the last page read. */
  stale: boolean;
  /** Why the refresh failed; null when the page is fresh. */
  reason: WalletHistoryUnavailable["reason"] | null;
}
export interface WalletHistory {
  read(input: {
    wallet: string;
    kind: WalletHistoryKind;
    page: PageParams | null;
    scope: string;
  }): Promise<WalletHistoryResponse>;
  /** The cached first trades page, however old, until it ages out. */
  peekTrades(wallet: string): TradesSnapshot | null;
  /** Reads the first trades page from the explorer, whatever the cache holds;
   * a failed read answers the cached page marked stale, or throws the 503.
   * `reserveShare` of the day's credits is left for other readers: past it
   * the read fails as `budget_exhausted` without an explorer call. */
  refreshTrades(
    wallet: string,
    options?: { reserveShare?: number },
  ): Promise<TradesSnapshot>;
}
interface Entry {
  fetchedAt: number;
  items: unknown[];
  next: PageParams | null;
  bytes: number;
}

function failure(error: BlockscoutError): WalletHistoryUnavailable["reason"] {
  return error.kind === "misconfigured_key" || error.kind === "key_rejected"
    ? "key_rejected"
    : error.kind;
}
function unavailable(error: BlockscoutError): RequestError {
  return new RequestError(503, "wallet_history_unavailable", {
    reason: failure(error),
    retryAfter: error.retryAfter,
  });
}

/** Cache keyed by wallet, kind, and page. First pages change as the wallet
 * acts, so they stay fresh briefly; deeper pages are effectively immutable
 * history and stay longer. Past freshness an entry is still served, marked
 * stale, whenever the explorer or the credit budget cannot answer. Trades
 * keep only legs whose token is in the verified registry, read before any
 * credit is spent; without a registry the trades kind is not configured.
 * Concurrent reads of one page share one explorer call. */
export function createWalletHistory({
  client,
  registry = null,
  now = Date.now,
  firstPageTtlMs = 30000,
  pageTtlMs = 600000,
  staleMaxAgeMs = 86400000,
  maxEntries = 2000,
  maxBytes = 32 * 1024 * 1024,
}: {
  client: BlockscoutClient | null;
  registry?: TokenRegistry | null;
  now?: () => number;
  firstPageTtlMs?: number;
  pageTtlMs?: number;
  staleMaxAgeMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}): WalletHistory {
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();
  let cacheBytes = 0;
  function evict(key: string) {
    cacheBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
  }
  function assertConfigured(kind: WalletHistoryKind) {
    if (!client || (kind === "trades" && !registry))
      throw new RequestError(503, "wallet_history_unavailable", {
        reason: "not_configured",
        retryAfter: 3600,
      });
  }
  /** The cached entry, dropped once past the stale limit. */
  function cached(key: string): Entry | undefined {
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt >= staleMaxAgeMs) evict(key);
    return cache.get(key);
  }
  function fetchEntry(
    wallet: string,
    kind: WalletHistoryKind,
    page: PageParams | null,
  ): Promise<Entry> {
    const key = JSON.stringify([wallet, kind, page]);
    let result = pending.get(key);
    if (!result) {
      result = (async () => {
        const registered = kind === "trades" ? await registry!.current() : null;
        const read = await client!.readPage(kind, wallet, page);
        const items = registered
          ? (read.items as { token: { address: string } }[]).filter((i) =>
              registered.has(i.token.address),
            )
          : read.items;
        const entry: Entry = {
          fetchedAt: now(),
          items,
          next: read.nextPageParams,
          bytes: Buffer.byteLength(
            JSON.stringify([items, read.nextPageParams]),
          ),
        };
        evict(key);
        while (cache.size >= maxEntries || cacheBytes + entry.bytes > maxBytes)
          evict(cache.keys().next().value!);
        cache.set(key, entry);
        cacheBytes += entry.bytes;
        return entry;
      })();
      pending.set(key, result);
      void result.then(
        () => pending.delete(key),
        () => pending.delete(key),
      );
    }
    return result;
  }
  function trades(
    entry: Entry,
    stale: boolean,
    reason: TradesSnapshot["reason"],
  ) {
    return {
      items: entry.items as WalletHistoryTrade[],
      next: entry.next,
      fetchedAt: entry.fetchedAt,
      stale,
      reason,
    };
  }
  return {
    async read({ wallet, kind, page, scope }) {
      assertConfigured(kind);
      const key = JSON.stringify([wallet, kind, page]);
      const hit = cached(key);
      let entry: Entry;
      let stale = false;
      if (hit && now() - hit.fetchedAt < (page ? pageTtlMs : firstPageTtlMs)) {
        cache.delete(key);
        cache.set(key, hit);
        entry = hit;
      } else {
        try {
          entry = await fetchEntry(wallet, kind, page);
        } catch (error) {
          if (!(error instanceof BlockscoutError)) throw error;
          const last = cache.get(key);
          if (!last) throw unavailable(error);
          entry = last;
          stale = true;
        }
      }
      return {
        source: "blockscout",
        chainId: 4663,
        wallet,
        kind,
        items: entry.items,
        nextCursor: entry.next
          ? encodeHistoryCursor(scope, kind, entry.next)
          : null,
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
        stale,
        note,
      } as WalletHistoryResponse;
    },
    peekTrades(wallet) {
      if (!client || !registry) return null;
      const hit = cached(JSON.stringify([wallet, "trades", null]));
      return hit ? trades(hit, false, null) : null;
    },
    async refreshTrades(wallet, { reserveShare = 0 } = {}) {
      assertConfigured("trades");
      const key = JSON.stringify([wallet, "trades", null]);
      try {
        if (reserveShare > 0 && !pending.has(key))
          client!.budget.assertAvailable(
            creditCost.trades +
              Math.ceil(client!.budget.snapshot().dailyCap * reserveShare),
          );
        return trades(await fetchEntry(wallet, "trades", null), false, null);
      } catch (error) {
        if (!(error instanceof BlockscoutError)) throw error;
        const last = cached(key);
        if (!last) throw unavailable(error);
        return trades(last, true, failure(error));
      }
    },
  };
}

/** Reads BLOCKSCOUT_API_KEY by name at startup. Without it the route answers
 * 503 `not_configured`, so unconfigured deployments and CI stay green. */
export function createWalletHistoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  registry: TokenRegistry | null = null,
): WalletHistory {
  function integer(name: string, fallback: number, max: number) {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw Error(`Invalid ${name}`);
    return n;
  }
  const key = env.BLOCKSCOUT_API_KEY;
  return createWalletHistory({
    registry,
    client: key
      ? createBlockscoutClient({
          key,
          baseUrl: env.BLOCKSCOUT_API_URL || undefined,
          dailyCreditCap: integer("BLOCKSCOUT_DAILY_CREDIT_CAP", 30000, 99999),
        })
      : null,
    firstPageTtlMs:
      integer("BLOCKSCOUT_FIRST_PAGE_TTL_SECONDS", 30, 86400) * 1000,
    pageTtlMs: integer("BLOCKSCOUT_PAGE_TTL_SECONDS", 600, 86400) * 1000,
  });
}
