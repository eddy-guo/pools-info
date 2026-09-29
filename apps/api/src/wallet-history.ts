import type {
  WalletHistoryKind,
  WalletHistoryResponse,
  WalletHistoryTrade,
  WalletHistoryUnavailable,
} from "@pools/core";
import {
  BlockscoutError,
  createBlockscoutClient,
  type BlockscoutClient,
  type PageParams,
  type SwapBatchBudget,
} from "./blockscout-client";
import {
  createCreditBudget,
  type CreditAdmission,
  type CreditBudgetStore,
} from "./explorer-budget";
import {
  createHistoryCursorCodec,
  type HistoryCursorCodec,
} from "./history-cursor";
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
  /** One page for the public route, charged to the `history` allocation.
   * `cursor` is the caller's cursor as received: verified here, before any
   * paid read, and a 400 `invalid_cursor` for anything this api did not
   * issue for this wallet and kind. */
  read(input: {
    wallet: string;
    kind: WalletHistoryKind;
    cursor: string | null;
  }): Promise<WalletHistoryResponse>;
  /** The cached first trades page, however old, until it ages out. */
  peekTrades(wallet: string): TradesSnapshot | null;
  /** Reads the first trades page from the explorer, whatever the cache holds,
   * charged to the `following` allocation; a failed read answers the cached
   * page marked stale, or throws the 503. `reserveShare` of the day's shared
   * credits is left for other readers: past it the read fails as
   * `budget_exhausted` without an explorer call. */
  refreshTrades(
    wallet: string,
    options?: { reserveShare?: number; swapBatchBudget?: SwapBatchBudget },
  ): Promise<TradesSnapshot>;
}
interface Entry {
  fetchedAt: number;
  items: unknown[];
  next: PageParams | null;
  bytes: number;
}

/** The route's public reasons. A budget store that did not answer is the
 * explorer being unavailable to this reader: nothing is spent without a
 * reservation, and the caller retries as for any upstream failure. */
function failure(error: BlockscoutError): WalletHistoryUnavailable["reason"] {
  return error.kind === "misconfigured_key" || error.kind === "key_rejected"
    ? "key_rejected"
    : error.kind === "budget_unavailable"
      ? "upstream_unavailable"
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
 * Concurrent full reads of one page share one explorer call. Cursors are
 * issued and verified by `cursors`, which a configured client requires. */
export function createWalletHistory({
  client,
  registry = null,
  cursors = null,
  now = Date.now,
  firstPageTtlMs = 30000,
  pageTtlMs = 600000,
  staleMaxAgeMs = 86400000,
  maxEntries = 2000,
  maxBytes = 32 * 1024 * 1024,
}: {
  client: BlockscoutClient | null;
  registry?: TokenRegistry | null;
  cursors?: HistoryCursorCodec | null;
  now?: () => number;
  firstPageTtlMs?: number;
  pageTtlMs?: number;
  staleMaxAgeMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}): WalletHistory {
  if (client && !cursors)
    throw Error("A history cursor codec is required with an explorer client");
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();
  let cacheBytes = 0;
  function evict(key: string) {
    cacheBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
  }
  function assertConfigured(kind: WalletHistoryKind) {
    if (!client || !cursors || (kind === "trades" && !registry))
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
    admission: CreditAdmission,
    swapBatchBudget?: SwapBatchBudget,
  ): Promise<Entry> {
    const key = JSON.stringify([wallet, kind, page]);
    let result = swapBatchBudget ? undefined : pending.get(key);
    if (!result) {
      result = (async () => {
        const registered = kind === "trades" ? await registry!.current() : null;
        const read =
          kind === "trades"
            ? await client!.readPage(
                "trades",
                wallet,
                page,
                admission,
                {
                  tokens: registered!,
                  poolsOf: (t) => registry!.poolsOf(t),
                },
                swapBatchBudget,
              )
            : await client!.readPage(kind, wallet, page, admission);
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
        if (!read.incomplete) {
          evict(key);
          while (
            cache.size >= maxEntries ||
            cacheBytes + entry.bytes > maxBytes
          )
            evict(cache.keys().next().value!);
          cache.set(key, entry);
          cacheBytes += entry.bytes;
        }
        return entry;
      })();
      if (!swapBatchBudget) {
        pending.set(key, result);
        void result.then(
          () => pending.delete(key),
          () => pending.delete(key),
        );
      }
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
    async read({ wallet, kind, cursor }) {
      assertConfigured(kind);
      let page: PageParams | null = null;
      if (cursor !== null) {
        try {
          page = cursors!.decode(cursor, { wallet, kind });
        } catch {
          throw new RequestError(400, "invalid_cursor");
        }
      }
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
          entry = await fetchEntry(wallet, kind, page, { consumer: "history" });
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
          ? cursors!.encode({ wallet, kind, page: entry.next })
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
    async refreshTrades(wallet, { reserveShare = 0, swapBatchBudget } = {}) {
      assertConfigured("trades");
      const key = JSON.stringify([wallet, "trades", null]);
      try {
        return trades(
          await fetchEntry(
            wallet,
            "trades",
            null,
            { consumer: "following", reserveShare },
            swapBatchBudget,
          ),
          false,
          null,
        );
      } catch (error) {
        if (!(error instanceof BlockscoutError)) throw error;
        const last = cached(key);
        if (!last) throw unavailable(error);
        return trades(last, true, failure(error));
      }
    },
  };
}

function envInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max: number,
  min = 1,
) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`);
  return n;
}
/** Reads BLOCKSCOUT_API_KEY by name at startup: the one explorer client, and
 * so the one daily credit budget, of every reader of the explorer in this
 * process. Null without a key. With a key, the budget's day rows live in
 * `budgetStore` (the database, shared with every other process holding the
 * key), the cap is `BLOCKSCOUT_DAILY_CREDIT_CAP` and the account floor
 * `BLOCKSCOUT_CREDIT_FLOOR`. */
export function blockscoutClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  budgetStore: CreditBudgetStore | null = null,
): BlockscoutClient | null {
  const key = env.BLOCKSCOUT_API_KEY;
  if (!key) return null;
  if (!budgetStore)
    throw Error(
      "DATABASE_URL is required with BLOCKSCOUT_API_KEY: the explorer credit budget is kept in the database",
    );
  return createBlockscoutClient({
    key,
    baseUrl: env.BLOCKSCOUT_API_URL || undefined,
    budget: createCreditBudget({
      dailyCap: envInteger(env, "BLOCKSCOUT_DAILY_CREDIT_CAP", 30000, 99999),
      creditFloor: envInteger(env, "BLOCKSCOUT_CREDIT_FLOOR", 30000, 99999, 0),
      store: budgetStore,
    }),
  });
}
/** Without a key the route answers 503 `not_configured`, so unconfigured
 * deployments and CI stay green. With one, `HISTORY_CURSOR_SECRET` must be
 * set (its value is never printed), or startup refuses. */
export function createWalletHistoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  registry: TokenRegistry | null = null,
  client: BlockscoutClient | null = blockscoutClientFromEnv(env),
): WalletHistory {
  return createWalletHistory({
    registry,
    client,
    cursors: client
      ? createHistoryCursorCodec({ secret: env.HISTORY_CURSOR_SECRET })
      : null,
    firstPageTtlMs:
      envInteger(env, "BLOCKSCOUT_FIRST_PAGE_TTL_SECONDS", 30, 86400) * 1000,
    pageTtlMs:
      envInteger(env, "BLOCKSCOUT_PAGE_TTL_SECONDS", 600, 86400) * 1000,
  });
}
