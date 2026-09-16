import type {
  WalletHistoryKind,
  WalletHistoryTokenTransfer,
  WalletHistoryTransaction,
} from "@pools/core";

/** Robinhood Chain (4663) on the Blockscout PRO host. The public explorer host
 * challenges scripted clients, and the PRO host bills every call in credits. */
export const blockscoutBaseUrl = "https://api.blockscout.com/4663/api/v2";
/** Credits per call from https://api.blockscout.com/api/json/config (2026-09-15):
 * `default` 20, `addresses/:hash/token-transfers` 30. */
export const creditCost: Record<WalletHistoryKind, number> = {
  transactions: 20,
  "token-transfers": 30,
};
export const freeTierRequestsPerSecond = 5;
const userAgent = "pools-info-api/0.1.0";

export type BlockscoutFailure =
  | "misconfigured_key"
  | "key_rejected"
  | "upstream_unavailable"
  | "budget_exhausted";
export class BlockscoutError extends Error {
  constructor(
    public kind: BlockscoutFailure,
    /** Seconds a caller should wait before trying the explorer again. */
    public retryAfter: number,
  ) {
    super(kind);
  }
}

/** Blockscout's `next_page_params`, carried verbatim as query parameters. */
export type PageParams = Record<string, string>;
const pageKey = /^[a-z][a-z0-9_]{0,39}$/;
const pageValue = /^[\w.:-]{0,100}$/;
/** Accept only a flat, bounded set of query-safe scalars: a cursor can add or
 * reorder upstream filters, never change the host, path, wallet, or kind. */
export function pageParams(value: unknown): PageParams | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw Error("page");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw Error("page");
  const page: PageParams = {};
  for (const [key, raw] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const text =
      typeof raw === "string"
        ? raw
        : (typeof raw === "number" && Number.isFinite(raw)) ||
            typeof raw === "boolean"
          ? String(raw)
          : null;
    if (!pageKey.test(key) || text === null || !pageValue.test(text))
      throw Error("page");
    page[key] = text;
  }
  return page;
}

/** Sliding window: any one-second interval starts at most `perSecond` calls,
 * which is stricter than any fixed-window measurement upstream could use. */
export function createRateLimiter({
  perSecond = freeTierRequestsPerSecond,
  maxWaitMs = 2000,
  now = Date.now,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
} = {}) {
  const scheduled: number[] = [];
  return {
    async acquire(): Promise<void> {
      const t = now();
      while (scheduled.length && scheduled[0] < t - 1000) scheduled.shift();
      const at =
        scheduled.length < perSecond
          ? t
          : scheduled[scheduled.length - perSecond] + 1000;
      if (at - t > maxWaitMs)
        throw new BlockscoutError("upstream_unavailable", 1);
      scheduled.push(at);
      if (at > t) await sleep(at - t);
    },
  };
}

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
function secondsToUtcMidnight(t: number): number {
  return Math.max(1, Math.ceil((86400000 - (t % 86400000)) / 1000));
}

/** Per-process daily credit counter, reset at UTC midnight. Every attempt is
 * counted before the call, so failures never under-count. The explorer's own
 * `x-credits-remaining` header is a backstop for what this process cannot see,
 * such as a second instance during a rolling deploy. */
export function createCreditBudget({
  dailyCap,
  now = Date.now,
}: {
  dailyCap: number;
  now?: () => number;
}) {
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1)
    throw Error("Invalid daily credit cap");
  let day = "",
    spent = 0,
    upstreamBlockedUntil = 0;
  function roll() {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      spent = 0;
    }
  }
  function assertAvailable(cost: number) {
    roll();
    const t = now();
    if (upstreamBlockedUntil > t)
      throw new BlockscoutError(
        "budget_exhausted",
        Math.ceil((upstreamBlockedUntil - t) / 1000),
      );
    if (spent + cost > dailyCap)
      throw new BlockscoutError("budget_exhausted", secondsToUtcMidnight(t));
  }
  return {
    assertAvailable,
    spend(cost: number) {
      assertAvailable(cost);
      spent += cost;
    },
    /** The header is only a lower bound on what the key has left today. */
    observeRemaining(remaining: number | null, nextCost: number) {
      if (remaining !== null && remaining < nextCost)
        upstreamBlockedUntil = now() + 3600000;
    },
    snapshot() {
      roll();
      return { day, spent, dailyCap };
    },
  };
}

const fullHash = /^0x[0-9a-f]{64}$/i;
const addressHash = /^0x[0-9a-f]{40}$/i;
const integerText = /^(0|[1-9][0-9]*)$/;
function invalid(): never {
  throw Error("invalid_item");
}
function hash(value: unknown): string {
  return typeof value === "string" && fullHash.test(value)
    ? value.toLowerCase()
    : invalid();
}
function address(value: unknown): string {
  const raw =
    typeof value === "object" && value !== null
      ? (value as { hash?: unknown }).hash
      : value;
  return typeof raw === "string" && addressHash.test(raw)
    ? raw.toLowerCase()
    : invalid();
}
function nullable<T>(value: unknown, map: (v: unknown) => T): T | null {
  return value === null || value === undefined ? null : map(value);
}
function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid();
}
function integerString(value: unknown): string {
  return typeof value === "string" && integerText.test(value)
    ? value
    : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}
function seconds(value: unknown): number {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : invalid();
}
function decimals(value: unknown): number | null {
  if (typeof value !== "string" || !integerText.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
type Item = Record<string, unknown>;
function item(value: unknown): Item {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Item)
    : invalid();
}
export function normalizeTransaction(value: unknown): WalletHistoryTransaction {
  const t = item(value);
  const status =
    t.status === "ok"
      ? "ok"
      : t.status === "error"
        ? "error"
        : t.status === null || t.status === undefined
          ? "pending"
          : invalid();
  const fee = nullable(t.fee, item);
  return {
    hash: hash(t.hash),
    block: nullable(t.block_number, integer),
    timestamp: nullable(t.timestamp, seconds),
    from: address(t.from),
    to: nullable(t.to, address),
    method: nullable(t.method, text),
    status,
    value: integerString(t.value),
    fee: fee ? nullable(fee.value, integerString) : null,
  };
}
export function normalizeTokenTransfer(
  value: unknown,
): WalletHistoryTokenTransfer {
  const t = item(value);
  const token = item(t.token);
  const total = nullable(t.total, item) ?? {};
  return {
    transactionHash: hash(t.transaction_hash),
    logIndex: integer(t.log_index),
    block: integer(t.block_number),
    timestamp: nullable(t.timestamp, seconds),
    from: address(t.from),
    to: address(t.to),
    token: {
      address: address(token.address_hash),
      symbol: nullable(token.symbol, text),
      name: nullable(token.name, text),
      decimals: decimals(total.decimals ?? token.decimals),
      type: nullable(token.type, text),
    },
    value: nullable(total.value, integerString),
    tokenId: nullable(total.token_id, integerString),
    method: nullable(t.method, text),
  };
}

export type HistoryItem<K extends WalletHistoryKind> = K extends "transactions"
  ? WalletHistoryTransaction
  : WalletHistoryTokenTransfer;
export interface BlockscoutPage<K extends WalletHistoryKind> {
  items: HistoryItem<K>[];
  nextPageParams: PageParams | null;
}
export interface BlockscoutClient {
  readPage<K extends WalletHistoryKind>(
    kind: K,
    wallet: string,
    page: PageParams | null,
  ): Promise<BlockscoutPage<K>>;
  budget: ReturnType<typeof createCreditBudget>;
}

/** The key never leaves this closure: it is sent only as a Bearer header to
 * the fixed base URL, and no error, log line, or response carries it. */
export function createBlockscoutClient({
  key,
  baseUrl = blockscoutBaseUrl,
  dailyCreditCap,
  timeoutMs = 5000,
  maxBytes = 4 * 1024 * 1024,
  now = Date.now,
  fetchImpl = fetch,
  limiter = createRateLimiter({ now }),
}: {
  key: string;
  baseUrl?: string;
  dailyCreditCap: number;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  limiter?: ReturnType<typeof createRateLimiter>;
}): BlockscoutClient {
  if (!key || /\s/.test(key)) throw Error("Invalid BLOCKSCOUT_API_KEY");
  if (!/^https?:\/\/[^\s?#]+$/.test(baseUrl))
    throw Error("Invalid BLOCKSCOUT_API_URL");
  if (!(timeoutMs > 0 && timeoutMs <= 5000)) throw Error("Invalid timeout");
  const budget = createCreditBudget({ dailyCap: dailyCreditCap, now });
  function fail(event: string, detail: Record<string, unknown> = {}) {
    process.stderr.write(JSON.stringify({ event, ...detail }) + "\n");
  }
  async function readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes || !response.body) throw Error("oversize");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw Error("oversize");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return {
    budget,
    async readPage(kind, wallet, page) {
      if (!addressHash.test(wallet)) throw Error("Invalid wallet");
      const cost = creditCost[kind];
      budget.assertAvailable(cost);
      await limiter.acquire();
      budget.spend(cost);
      const url = new URL(
        `${baseUrl.replace(/\/+$/, "")}/addresses/${wallet.toLowerCase()}/${kind}`,
      );
      for (const [k, v] of Object.entries(page ?? {}))
        url.searchParams.set(k, v);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "User-Agent": userAgent,
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        fail("blockscout_request_failed", {
          kind,
          cause: error instanceof Error ? error.name : "unknown",
        });
        throw new BlockscoutError("upstream_unavailable", 30);
      }
      const remaining = response.headers.get("x-credits-remaining");
      budget.observeRemaining(
        remaining !== null && integerText.test(remaining) ? +remaining : null,
        Math.max(...Object.values(creditCost)),
      );
      if (response.status !== 200) {
        fail("blockscout_request_rejected", { kind, status: response.status });
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403)
          throw new BlockscoutError("misconfigured_key", 3600);
        if (response.status === 402)
          throw new BlockscoutError("key_rejected", 3600);
        throw new BlockscoutError(
          "upstream_unavailable",
          response.status === 429 ? 5 : 30,
        );
      }
      try {
        const body = JSON.parse(await readBody(response)) as Item;
        if (!Array.isArray(body.items)) invalid();
        const normalize: (value: unknown) => unknown =
          kind === "transactions"
            ? normalizeTransaction
            : normalizeTokenTransfer;
        return {
          items: body.items.map(normalize) as HistoryItem<typeof kind>[],
          nextPageParams: pageParams(body.next_page_params),
        };
      } catch (error) {
        fail("blockscout_response_invalid", {
          kind,
          cause:
            error instanceof Error
              ? error.name + ":" + error.message
              : "unknown",
        });
        throw new BlockscoutError("upstream_unavailable", 30);
      }
    },
  };
}
