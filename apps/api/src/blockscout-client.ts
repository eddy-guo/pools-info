import type {
  WalletHistoryKind,
  WalletHistoryTokenTransfer,
  WalletHistoryTrade,
  WalletHistoryTransaction,
} from "@pools/core";
import { BlockscoutError, type BlockscoutFailure } from "./blockscout-error";
import {
  createCreditBudget,
  type CreditAdmission,
  type CreditBudget,
} from "./explorer-budget";
import { canonicalPageParams, upstream, type PageParams } from "./history-page";

export { BlockscoutError, type BlockscoutFailure, type PageParams };

/** Robinhood Chain (4663) on the Blockscout PRO host. The public explorer host
 * challenges scripted clients, and the PRO host bills every call in credits. */
export const blockscoutBaseUrl = "https://api.blockscout.com/4663/api/v2";
/** Credits per call from https://api.blockscout.com/api/json/config (2026-09-15):
 * `default` 20, `addresses/:hash/token-transfers` 30. */
export const creditCost: Record<WalletHistoryKind, number> = {
  transactions: 20,
  "token-transfers": 30,
  trades: 30,
};
/** The Uniswap v4 PoolManager every catalog pool swaps through, the same
 * address as `contracts.manager` in `packages/chain/src/events.ts`. */
export const poolManager = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** topic0 of the PoolManager's `Swap(bytes32 indexed id, ...)`, whose topic1
 * is the pool id (`swapEvent` in `packages/chain/src/events.ts`). */
export const swapTopic =
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
/** The PRO host's JSON-RPC gateway answers at most 5 requests per batch (a
 * larger one is refused as 413 and still billed) and bills a batch like one
 * `default` call: 20 credits, measured 2026-09-27 (`eth_getLogs`) and
 * 2026-09-28 (`eth_getCode`). */
export const swapLogBatchSize = 5;
export const swapLogBatchCost = 20;
const swapLogConcurrency = 2;
const swapCacheEntries = 50000;
const recentSwapSeconds = 300;
export const freeTierRequestsPerSecond = 5;
/** Blockscout PRO answers wallet address pages in 2.0-4.6 s from Railway
 * (scout measurement, 2026-09-16); this leaves headroom for a slow page
 * without the route falsely declaring the explorer unavailable. */
export const defaultBlockscoutTimeoutMs = 12000;
const userAgent = "pools-info-api/0.1.0";

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
/** A display string the website renders as-is. The website's validator
 * requires null or a non-empty string of at most 256 characters, so an
 * empty upstream string maps to null and a longer one clips to fit. */
function display(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = text(value);
  return s === "" ? null : s.slice(0, 256);
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
    method: display(t.method),
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
      symbol: display(token.symbol),
      name: display(token.name),
      decimals: decimals(total.decimals ?? token.decimals),
      type: display(token.type),
    },
    value: nullable(total.value, integerString),
    tokenId: nullable(total.token_id, integerString),
    method: display(t.method),
  };
}

/** The verified registry as a trade read needs it: its launch tokens, and the
 * pool ids each one launched in. */
export interface TradeRegistry {
  tokens: ReadonlySet<string>;
  poolsOf(token: string): readonly string[];
}
export interface SwapBatchBudget {
  remaining: number;
}
/** A wallet leg that may be a trade. `relayed` when its counterparty is not
 * the PoolManager, so it is a trade only once its transaction is shown to hold
 * a PoolManager swap of the token's pool. */
export interface TradeLeg {
  trade: WalletHistoryTrade;
  relayed: boolean;
}

/** The wallet's ERC-20 leg as a trade candidate, sided by direction, or null
 * for any row that cannot be one. A leg against the PoolManager is a direct
 * trade. Any other counterparty (a router or an aggregator passing the swap's
 * tokens on, but also a plain send or an airdrop) makes a relayed candidate,
 * and only for a registry token. Only the direction and token are read from
 * a row that is not a candidate, so a malformed row the list would never show
 * cannot fail the page. */
export function normalizeTrade(
  value: unknown,
  wallet: string,
  registered: ReadonlySet<string>,
): TradeLeg | null {
  const t = item(value);
  const hashOf = (party: unknown) =>
    typeof party === "object" && party !== null
      ? String((party as { hash?: unknown }).hash).toLowerCase()
      : null;
  const from = hashOf(t.from),
    to = hashOf(t.to);
  if (from === to) return null;
  const side = to === wallet ? "buy" : from === wallet ? "sell" : null;
  if (!side) return null;
  const relayed = (side === "buy" ? from : to) !== poolManager;
  const token =
    typeof t.token === "object" && t.token !== null
      ? String((t.token as Item).address_hash).toLowerCase()
      : null;
  if (relayed && !(token && registered.has(token))) return null;
  const transfer = normalizeTokenTransfer(value);
  if (transfer.token.type !== "ERC-20" || transfer.value === null) invalid();
  return {
    trade: {
      transactionHash: transfer.transactionHash,
      logIndex: transfer.logIndex,
      block: transfer.block,
      timestamp: transfer.timestamp,
      side,
      token: transfer.token,
      tokenRaw: transfer.value,
      method: transfer.method,
    },
    relayed,
  };
}

export type HistoryItem<K extends WalletHistoryKind> = K extends "transactions"
  ? WalletHistoryTransaction
  : K extends "trades"
    ? WalletHistoryTrade
    : WalletHistoryTokenTransfer;
export interface BlockscoutPage<K extends WalletHistoryKind> {
  items: HistoryItem<K>[];
  nextPageParams: PageParams | null;
  incomplete?: boolean;
}
export interface BlockscoutClient {
  /** One explorer page. `page` is a position this api issued (a verified
   * cursor) or null for the first page; `admission` names the reader the
   * call is charged to and the share of the day's budget it leaves. */
  readPage(
    kind: "trades",
    wallet: string,
    page: PageParams | null,
    admission: CreditAdmission,
    registry: TradeRegistry,
    swapBatchBudget?: SwapBatchBudget,
  ): Promise<BlockscoutPage<"trades">>;
  readPage<K extends Exclude<WalletHistoryKind, "trades">>(
    kind: K,
    wallet: string,
    page: PageParams | null,
    admission?: CreditAdmission,
  ): Promise<BlockscoutPage<K>>;
  /** The code at each address at the latest block, `0x` for none, read
   * through the explorer's JSON-RPC gateway five addresses a call. */
  readCode(
    addresses: readonly string[],
    admission: CreditAdmission,
  ): Promise<Map<string, string>>;
  budget: CreditBudget;
}

/** The key never leaves this closure: it is sent only as a Bearer header to
 * the fixed base URL and its JSON-RPC gateway, and no error, log line, or
 * response carries it. */
export function createBlockscoutClient({
  key,
  baseUrl = blockscoutBaseUrl,
  dailyCreditCap,
  creditFloor,
  budget: configuredBudget,
  timeoutMs = defaultBlockscoutTimeoutMs,
  maxBytes = 4 * 1024 * 1024,
  now = Date.now,
  fetchImpl = fetch,
  limiter = createRateLimiter({ now }),
}: {
  key: string;
  baseUrl?: string;
  /** The day's credit cap for a budget kept in this process alone (tests);
   * a deployment passes `budget`, the shared one over the database. */
  dailyCreditCap?: number;
  creditFloor?: number;
  budget?: CreditBudget;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  limiter?: ReturnType<typeof createRateLimiter>;
}): BlockscoutClient {
  if (!key || /\s/.test(key)) throw Error("Invalid BLOCKSCOUT_API_KEY");
  if (!/^https?:\/\/[^\s?#]+$/.test(baseUrl))
    throw Error("Invalid BLOCKSCOUT_API_URL");
  if (!(timeoutMs > 0 && timeoutMs <= defaultBlockscoutTimeoutMs))
    throw Error("Invalid timeout");
  const root = baseUrl.replace(/\/+$/, "");
  /** The gateway sits beside the REST API: `/4663/json-rpc` for `/4663/api/v2`. */
  const rpcUrl = `${root.replace(/\/api\/v2$/, "")}/json-rpc`;
  const budget =
    configuredBudget ??
    createCreditBudget({ dailyCap: dailyCreditCap ?? NaN, creditFloor, now });
  const swaps = new Map<string, boolean>();
  function fail(event: string, detail: Record<string, unknown> = {}) {
    process.stderr.write(JSON.stringify({ event, ...detail }) + "\n");
  }
  function invalidResponse(kind: string, error: unknown) {
    fail("blockscout_response_invalid", {
      kind,
      cause:
        error instanceof Error
          ? `${error.name}:${error.message}`.slice(0, 120)
          : "unknown",
    });
    return new BlockscoutError("upstream_unavailable", 30);
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
  /** One billed call: reserved on the shared budget before it is made,
   * paced by the limiter, settled as spent once attempted, and answered as
   * parsed JSON or a `BlockscoutError`. */
  async function request(
    kind: string,
    url: URL,
    cost: number,
    admission: CreditAdmission,
    body?: string,
  ): Promise<unknown> {
    const reservation = await budget.reserve(cost, admission);
    try {
      await limiter.acquire();
    } catch (error) {
      await reservation.release();
      throw error;
    }
    let response: Response;
    const started = now();
    try {
      response = await fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "User-Agent": userAgent,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail("blockscout_request_failed", {
        kind,
        cause: error instanceof Error ? error.name : "unknown",
        ms: now() - started,
      });
      // Attempted, so spent; the shared account view only ever falls.
      await reservation.settle({ remaining: null, at: now() });
      throw new BlockscoutError("upstream_unavailable", 30);
    }
    const remaining = response.headers.get("x-credits-remaining");
    await reservation.settle({
      remaining:
        remaining !== null && /^(0|[1-9][0-9]{0,8})$/.test(remaining)
          ? +remaining
          : null,
      at: now(),
    });
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
      return JSON.parse(await readBody(response));
    } catch (error) {
      throw invalidResponse(kind, error);
    }
  }
  /** The relayed legs whose transaction holds a PoolManager swap of their
   * token's pool. The explorer's transfer rows carry only the wallet's own
   * legs, so the swap is read from the chain: the PoolManager's `Swap` logs of
   * the legs' pools in each leg's block, one `eth_getLogs` per block, five
   * blocks per gateway batch. A filtered block answers a few hundred bytes
   * where a relayed transaction's full receipt can run to megabytes (a
   * 2,900-log airdrop, 2026-09-27). */
  async function confirmSwaps(
    legs: TradeLeg[],
    registry: TradeRegistry,
    admission: CreditAdmission,
    swapBatchBudget?: SwapBatchBudget,
  ): Promise<{ confirmed: Set<TradeLeg>; incomplete: boolean }> {
    const keysOf = ({ trade }: TradeLeg) =>
      registry
        .poolsOf(trade.token.address)
        .map((pool) => `${trade.transactionHash}:${pool}`);
    const asks = new Map<number, Set<string>>();
    for (const leg of legs)
      for (const pool of registry.poolsOf(leg.trade.token.address))
        if (!swaps.has(`${leg.trade.transactionHash}:${pool}`)) {
          const pools = asks.get(leg.trade.block) ?? new Set<string>();
          asks.set(leg.trade.block, pools.add(pool));
        }
    const blocks = [...asks];
    const batches: (typeof blocks)[] = [];
    for (let i = 0; i < blocks.length; i += swapLogBatchSize)
      batches.push(blocks.slice(i, i + swapLogBatchSize));
    const selected = batches.slice(
      0,
      swapBatchBudget?.remaining ?? batches.length,
    );
    if (swapBatchBudget) swapBatchBudget.remaining -= selected.length;
    const queriedBlocks = new Set(
      selected.flatMap((batch) => batch.map(([block]) => block)),
    );
    const found = new Set<string>();
    const readBatch = async (batch: (typeof batches)[number]) => {
      const answer = await request(
        "swap-logs",
        new URL(rpcUrl),
        swapLogBatchCost,
        admission,
        JSON.stringify(
          batch.map(([block, pools], id) => ({
            jsonrpc: "2.0",
            id,
            method: "eth_getLogs",
            params: [
              {
                fromBlock: `0x${block.toString(16)}`,
                toBlock: `0x${block.toString(16)}`,
                address: poolManager,
                topics: [swapTopic, [...pools]],
              },
            ],
          })),
        ),
      );
      try {
        if (!Array.isArray(answer) || answer.length !== batch.length) invalid();
        const replies = answer.map(item);
        const ids = new Set<number>();
        for (const reply of replies) {
          if (
            typeof reply.id !== "number" ||
            !Number.isInteger(reply.id) ||
            reply.id < 0 ||
            reply.id >= batch.length ||
            ids.has(reply.id)
          )
            invalid();
          ids.add(reply.id);
        }
        for (const reply of replies) {
          const asked =
            typeof reply.id === "number" ? batch[reply.id] : undefined;
          if (!asked || reply.error !== undefined) invalid();
          if (!Array.isArray(reply.result)) invalid();
          const [block, pools] = asked;
          for (const log of reply.result.map(item)) {
            if (log.removed === true) continue;
            const topics = Array.isArray(log.topics) ? log.topics : [];
            const pool = hash(topics[1]);
            if (
              address(log.address) !== poolManager ||
              topics[0] !== swapTopic ||
              !pools.has(pool) ||
              typeof log.blockNumber !== "string" ||
              !/^0x[0-9a-f]+$/i.test(log.blockNumber) ||
              parseInt(log.blockNumber, 16) !== block
            )
              invalid();
            found.add(`${hash(log.transactionHash)}:${pool}`);
          }
        }
      } catch (error) {
        throw invalidResponse("swap-logs", error);
      }
    };
    // Two batches in flight at most: the key's 5 requests per second are
    // shared with every other reader of it, and a burst right after the page
    // read drew 429s on 2026-09-27.
    const queue = [...selected];
    const worker = async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift())
        // A failed batch fails the page, so the rest are not worth paying for.
        await readBatch(batch).catch((error: unknown) => {
          queue.length = 0;
          throw error;
        });
    };
    await Promise.all(
      Array.from(
        { length: Math.min(swapLogConcurrency, queue.length) },
        worker,
      ),
    );
    const confirmed = new Set<TradeLeg>();
    for (const leg of legs)
      if (keysOf(leg).some((k) => found.has(k) || swaps.get(k) === true))
        confirmed.add(leg);
    for (const leg of legs)
      for (const k of keysOf(leg))
        if (
          queriedBlocks.has(leg.trade.block) &&
          leg.trade.timestamp !== null &&
          now() / 1000 - leg.trade.timestamp >= recentSwapSeconds &&
          !swaps.has(k)
        ) {
          swaps.set(k, found.has(k));
          if (swaps.size > swapCacheEntries)
            swaps.delete(swaps.keys().next().value!);
        }
    return { confirmed, incomplete: selected.length < batches.length };
  }
  return {
    budget,
    async readCode(addresses, admission) {
      const code = new Map<string, string>();
      for (let i = 0; i < addresses.length; i += swapLogBatchSize) {
        const batch = addresses
          .slice(i, i + swapLogBatchSize)
          .map((a) => address(a));
        const answer = await request(
          "code",
          new URL(rpcUrl),
          swapLogBatchCost,
          admission,
          JSON.stringify(
            batch.map((a, id) => ({
              jsonrpc: "2.0",
              id,
              method: "eth_getCode",
              params: [a, "latest"],
            })),
          ),
        );
        try {
          if (!Array.isArray(answer) || answer.length !== batch.length)
            invalid();
          for (const reply of answer.map(item)) {
            const asked =
              typeof reply.id === "number" ? batch[reply.id] : undefined;
            if (
              !asked ||
              code.has(asked) ||
              reply.error !== undefined ||
              typeof reply.result !== "string" ||
              !/^0x(?:[0-9a-f]{2})*$/i.test(reply.result)
            )
              invalid();
            code.set(asked, reply.result.toLowerCase());
          }
        } catch (error) {
          throw invalidResponse("code", error);
        }
      }
      return code;
    },
    async readPage<K extends WalletHistoryKind>(
      kind: K,
      wallet: string,
      page: PageParams | null,
      admission: CreditAdmission = { consumer: "history" },
      registry?: TradeRegistry,
      swapBatchBudget?: SwapBatchBudget,
    ): Promise<BlockscoutPage<K>> {
      if (!addressHash.test(wallet)) throw Error("Invalid wallet");
      if (kind === "trades" && !registry)
        throw Error("Trade registry required");
      // A position is only ever the kind's own paging keys in canonical
      // form, whoever issued it.
      const position = page === null ? null : canonicalPageParams(kind, page);
      const cost = creditCost[kind];
      const trades = kind === "trades";
      const address = wallet.toLowerCase();
      const url = new URL(
        `${root}/addresses/${address}/${upstream[kind].path}`,
      );
      // The kind's own filter goes last, so a position can never replace it.
      for (const [k, v] of Object.entries({
        ...position,
        ...upstream[kind].filter,
      }))
        url.searchParams.set(k, v);
      const answer = await request(kind, url, cost, admission);
      let items: unknown[];
      let legs: TradeLeg[] = [];
      let nextPageParams: PageParams | null;
      try {
        const body = item(answer);
        if (!Array.isArray(body.items)) invalid();
        nextPageParams = canonicalPageParams(kind, body.next_page_params);
        if (trades) {
          legs = body.items
            .map((value) => normalizeTrade(value, address, registry!.tokens))
            .filter((leg) => leg !== null);
          legs = legs.filter((leg) =>
            registry!.tokens.has(leg.trade.token.address),
          );
        }
        const normalize: (value: unknown) => unknown =
          kind === "transactions"
            ? normalizeTransaction
            : normalizeTokenTransfer;
        items = trades ? [] : body.items.map(normalize);
      } catch (error) {
        throw invalidResponse(kind, error);
      }
      if (trades) {
        const relayed = legs.filter((leg) => leg.relayed);
        const { confirmed, incomplete } = relayed.length
          ? await confirmSwaps(relayed, registry!, admission, swapBatchBudget)
          : { confirmed: new Set<TradeLeg>(), incomplete: false };
        items = legs
          .filter((leg) => !leg.relayed || confirmed.has(leg))
          .map((leg) => leg.trade);
        return {
          items: items as HistoryItem<K>[],
          nextPageParams,
          incomplete,
        };
      }
      return {
        items: items as HistoryItem<K>[],
        nextPageParams,
      };
    },
  };
}
