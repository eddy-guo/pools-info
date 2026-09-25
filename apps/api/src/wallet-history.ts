import type { WalletHistoryKind, WalletHistoryResponse } from "@pools/core";
import {
  BlockscoutError,
  createBlockscoutClient,
  type BlockscoutClient,
  type PageParams,
} from "./blockscout-client";
import { encodeHistoryCursor } from "./history-cursor";
import { RequestError } from "./request";

const note =
  "Explorer history for display only; not accounting or PnL evidence." as const;
/** A trades response keeps reading whole explorer pages until it holds this
 * many trades, the explorer runs out, or it has read `tradesMaxPages` pages.
 * Most pages are nearly all trades; a wallet whose page is crowded by
 * spoofed-token poisoning logs still gets a list rather than an empty page
 * beside a cursor, at no more than 90 credits for the request. */
export const tradesPageTarget = 25;
export const tradesMaxPages = 3;

/** Reads one response's worth of explorer pages. Whole pages only, so the
 * cursor is always the explorer's own; a later page that fails ends the
 * response early with a cursor pointing at that page. */
async function readPages(
  client: BlockscoutClient,
  kind: WalletHistoryKind,
  wallet: string,
  page: PageParams | null,
) {
  const items: unknown[] = [];
  let next = page;
  for (let read = 1; ; read++) {
    let result;
    try {
      result = await client.readPage(kind, wallet, next);
    } catch (error) {
      if (read === 1 || !(error instanceof BlockscoutError)) throw error;
      break;
    }
    items.push(...result.items);
    next = result.nextPageParams;
    if (
      kind !== "trades" ||
      !next ||
      items.length >= tradesPageTarget ||
      read >= tradesMaxPages
    )
      break;
  }
  return { items, nextPageParams: next };
}

export interface WalletHistory {
  read(input: {
    wallet: string;
    kind: WalletHistoryKind;
    page: PageParams | null;
    scope: string;
  }): Promise<WalletHistoryResponse>;
}
interface Entry {
  fetchedAt: number;
  body: WalletHistoryResponse;
  bytes: number;
}

function unavailable(error: BlockscoutError): RequestError {
  return new RequestError(503, "wallet_history_unavailable", {
    reason:
      error.kind === "misconfigured_key" || error.kind === "key_rejected"
        ? "key_rejected"
        : error.kind,
    retryAfter: error.retryAfter,
  });
}

/** Cache keyed by wallet, kind, and page. First pages change as the wallet
 * acts, so they stay fresh briefly; deeper pages are effectively immutable
 * history and stay longer. Past freshness an entry is still served, marked
 * stale, whenever the explorer or the credit budget cannot answer. */
export function createWalletHistory({
  client,
  now = Date.now,
  firstPageTtlMs = 30000,
  pageTtlMs = 600000,
  staleMaxAgeMs = 86400000,
  maxEntries = 2000,
  maxBytes = 32 * 1024 * 1024,
}: {
  client: BlockscoutClient | null;
  now?: () => number;
  firstPageTtlMs?: number;
  pageTtlMs?: number;
  staleMaxAgeMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}): WalletHistory {
  const cache = new Map<string, Entry>();
  let cacheBytes = 0;
  function evict(key: string) {
    cacheBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
  }
  return {
    async read({ wallet, kind, page, scope }) {
      if (!client)
        throw new RequestError(503, "wallet_history_unavailable", {
          reason: "not_configured",
          retryAfter: 3600,
        });
      const key = JSON.stringify([wallet, kind, page]);
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.fetchedAt >= staleMaxAgeMs) evict(key);
      const fresh =
        hit && t - hit.fetchedAt < (page ? pageTtlMs : firstPageTtlMs);
      if (hit && fresh) {
        cache.delete(key);
        cache.set(key, hit);
        return hit.body;
      }
      try {
        const result = await readPages(client, kind, wallet, page);
        const fetchedAt = now();
        const body = {
          source: "blockscout",
          chainId: 4663,
          wallet,
          kind,
          items: result.items,
          nextCursor: result.nextPageParams
            ? encodeHistoryCursor(scope, kind, result.nextPageParams)
            : null,
          fetchedAt: new Date(fetchedAt).toISOString(),
          stale: false,
          note,
        } as WalletHistoryResponse;
        const bytes = Buffer.byteLength(JSON.stringify(body));
        evict(key);
        while (cache.size >= maxEntries || cacheBytes + bytes > maxBytes)
          evict(cache.keys().next().value!);
        cache.set(key, { fetchedAt, body, bytes });
        cacheBytes += bytes;
        return body;
      } catch (error) {
        if (!(error instanceof BlockscoutError)) throw error;
        const stale = cache.get(key);
        if (stale) return { ...stale.body, stale: true };
        throw unavailable(error);
      }
    },
  };
}

/** Reads BLOCKSCOUT_API_KEY by name at startup. Without it the route answers
 * 503 `not_configured`, so unconfigured deployments and CI stay green. */
export function createWalletHistoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
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
