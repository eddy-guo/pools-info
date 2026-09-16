import type { Hex } from "viem";
import type { RawLog } from "./events";
type Request = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};
type Reply = {
  id: number;
  result?: unknown;
  error?: { message: string; code?: number };
};
class LogRangeLimit extends Error {
  constructor(readonly blocks: number) {
    super(`RPC log range limited to ${blocks} blocks`);
  }
}
class BatchRateLimit extends Error {
  constructor(readonly replies: Reply[] | null) {
    super("RPC HTTP 429");
  }
}
/** The provider answered a call with a JSON-RPC error or no result. */
export class RpcCallError extends Error {
  constructor() {
    super("RPC returned an error or missing result");
    this.name = "RpcCallError";
  }
}
/** Terminal for this collection and its worker. Do not retry with a fresh Rpc. */
export class RpcRateLimitExhausted extends Error {
  constructor() {
    super("RPC rate limit exhausted after 4 throttled attempts");
    this.name = "RpcRateLimitExhausted";
  }
}
export interface RpcRateLimitEvent {
  source: "http" | "json_rpc";
  methods: string[];
  batchCalls: number;
  throttledCalls: number;
  attempt: number;
  httpRequests: number;
  rpcCalls: number;
}
export const blockReceiptPolicy = Object.freeze({
  maxBatchCalls: 2,
  maxResponseBytes: 8 * 1024 * 1024,
  maxReceiptsPerBlock: 2000,
});
export class RpcResponseCapacity extends Error {
  constructor() {
    super("Block receipt response exceeds capacity");
    this.name = "RpcResponseCapacity";
  }
}
async function boundedJson(response: Response, signal?: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("RPC returned empty body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    const length = Number(response.headers.get("content-length"));
    if (length > blockReceiptPolicy.maxResponseBytes)
      throw new RpcResponseCapacity();
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > blockReceiptPolicy.maxResponseBytes)
        throw new RpcResponseCapacity();
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const observedMethods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getBlockReceipts",
  "eth_getTransactionByHash",
  "eth_getCode",
  "eth_call",
  "eth_getBalance",
  "eth_getStorageAt",
]);
export class Rpc {
  requests = 0;
  // Distinct logical calls; retries reuse IDs. This is not billable provider usage.
  calls = 0;
  private abortSignal?: AbortSignal;
  withAbortSignal(signal?: AbortSignal) {
    this.abortSignal = signal;
    return this;
  }
  private async wait(ms: number) {
    this.abortSignal?.throwIfAborted();
    if (!this.abortSignal)
      return new Promise<void>((resolve) => setTimeout(resolve, ms));
    const signal = this.abortSignal;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private started = Date.now();
  private nextRequestAt = 0;
  private logRange = 10000;
  private batchSize = 20;
  private throttleMs = 0;
  private rateLimitAttempts = new Map<number, number>();
  private rateLimitFailure?: RpcRateLimitExhausted;
  constructor(
    private url = process.env.ROBINHOOD_RPC_URL ??
      "https://rpc.mainnet.chain.robinhood.com",
    private limits: {
      timeoutMs?: number;
      maxRequests?: number;
      minIntervalMs?: number;
      maxBatchSize?: number;
      logRangeBlocks?: number;
      onRateLimit?: (event: RpcRateLimitEvent) => void;
    } = {},
  ) {
    const batchSize = limits.maxBatchSize ?? 20;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20)
      throw Error("Invalid RPC batch size");
    this.batchSize = batchSize;
    const logRangeBlocks = limits.logRangeBlocks ?? 10000;
    if (
      !Number.isSafeInteger(logRangeBlocks) ||
      logRangeBlocks < 1 ||
      logRangeBlocks > 10000
    )
      throw Error("Invalid RPC log range");
    this.logRange = logRangeBlocks;
  }
  private throttled() {
    this.throttleMs = Math.max(this.throttleMs, 1000);
    this.nextRequestAt = Math.max(
      this.nextRequestAt,
      Date.now() + this.throttleMs,
    );
  }
  private async send(body: Request | Request[]): Promise<Reply | Reply[]> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.rateLimitFailure) throw this.rateLimitFailure;
      this.abortSignal?.throwIfAborted();
      const scheduledAt = Math.max(Date.now(), this.nextRequestAt);
      this.nextRequestAt =
        scheduledAt + Math.max(this.limits.minIntervalMs ?? 0, this.throttleMs);
      const pause = scheduledAt - Date.now();
      if (pause > 0) await this.wait(pause);
      const remaining =
        (this.limits.timeoutMs ?? 45000) - (Date.now() - this.started);
      if (remaining <= 0 || this.requests >= (this.limits.maxRequests ?? 1500))
        throw Error(
          `Collection budget exceeded after ${this.requests} HTTP requests and ${this.calls} RPC calls`,
        );
      this.requests++;
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: this.abortSignal
            ? AbortSignal.any([
                this.abortSignal,
                AbortSignal.timeout(Math.max(1, Math.min(10000, remaining))),
              ])
            : AbortSignal.timeout(Math.max(1, Math.min(10000, remaining))),
          cache: "no-store",
        });
        const blockReceipts = (Array.isArray(body) ? body : [body]).some(
          (r) => r.method === "eth_getBlockReceipts",
        );
        // HTTP throttling wins even when its error body is oversized or invalid.
        let result: Reply | Reply[] | null;
        if (blockReceipts && response.status === 429) {
          await response.body?.cancel();
          result = null;
        } else if (blockReceipts) {
          result = (await boundedJson(response, this.abortSignal)) as
            Reply | Reply[];
        } else {
          result = (await response.json().catch(() => null)) as
            Reply | Reply[] | null;
        }
        // Observe throttling before any range/error handling. Only fixed method
        // labels and counters leave this boundary, never URLs, params or text.
        const replies = Array.isArray(result) ? result : result ? [result] : [];
        if (
          response.status === 429 ||
          replies.some((r) => r.error?.code === 429)
        ) {
          const requests = Array.isArray(body) ? body : [body];
          const limitedIds = new Set(
            replies.filter((r) => r.error?.code === 429).map((r) => r.id),
          );
          const limited =
            response.status === 429
              ? requests
              : requests.filter((r) => limitedIds.has(r.id));
          for (const request of limited)
            this.rateLimitAttempts.set(
              request.id,
              (this.rateLimitAttempts.get(request.id) ?? 0) + 1,
            );
          const throttledAttempt = Math.max(
            0,
            ...limited.map((r) => this.rateLimitAttempts.get(r.id)!),
          );
          this.limits.onRateLimit?.({
            source: response.status === 429 ? "http" : "json_rpc",
            methods: [
              ...new Set(
                requests.map((r) =>
                  observedMethods.has(r.method) ? r.method : "other",
                ),
              ),
            ],
            batchCalls: requests.length,
            throttledCalls: limited.length,
            attempt: throttledAttempt,
            httpRequests: this.requests,
            rpcCalls: this.calls,
          });
          if (throttledAttempt >= 4) {
            this.rateLimitFailure = new RpcRateLimitExhausted();
            throw this.rateLimitFailure;
          }
          this.throttled();
          if (Array.isArray(body))
            throw new BatchRateLimit(
              response.status === 429
                ? null
                : Array.isArray(result)
                  ? result
                  : null,
            );
          throw Error("RPC HTTP 429");
        }
        // Some providers return plan limits as HTTP 400 JSON-RPC errors. Keep
        // provider messages private and only extract the advertised range size.
        if (
          !Array.isArray(body) &&
          body.method === "eth_getLogs" &&
          result &&
          !Array.isArray(result)
        ) {
          const match = result.error?.message?.match(
            /up to (?:a )?([\d,]+) block range/i,
          );
          const blocks = match ? Number(match[1].replaceAll(",", "")) : 0;
          if (
            Number.isSafeInteger(blocks) &&
            blocks > 0 &&
            blocks < this.logRange
          )
            throw new LogRangeLimit(blocks);
        }
        if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
        if (!result) throw Error("RPC returned invalid JSON");
        for (const row of Array.isArray(result) ? result : [result])
          if (row.error || row.result === undefined) throw new RpcCallError();
        return result;
      } catch (error) {
        if (
          this.abortSignal?.aborted ||
          error instanceof RpcResponseCapacity ||
          error instanceof LogRangeLimit ||
          error instanceof BatchRateLimit ||
          error instanceof RpcRateLimitExhausted ||
          attempt === 3
        )
          throw error;
        await this.wait(500 * 2 ** attempt);
      }
    }
    throw Error("RPC retry exhausted");
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.calls;
    const response = await this.send({ jsonrpc: "2.0", id, method, params });
    if (Array.isArray(response) || response.id !== id)
      throw Error("RPC response ID mismatch");
    return response.result as T;
  }
  async batch<T>(method: string, paramsList: unknown[][]): Promise<T[]> {
    const requests = paramsList.map((params) => ({
      jsonrpc: "2.0" as const,
      id: ++this.calls,
      method,
      params,
    }));
    const pending = [...requests];
    const values = new Map<number, unknown>();
    const attempts = new Map<number, number>();
    while (pending.length) {
      const chunk = pending.splice(
        0,
        method === "eth_getBlockReceipts"
          ? Math.min(this.batchSize, blockReceiptPolicy.maxBatchCalls)
          : this.batchSize,
      );
      for (const request of chunk)
        attempts.set(request.id, (attempts.get(request.id) ?? 0) + 1);
      let response: Reply[];
      let limited = false;
      try {
        const result = await this.send(chunk);
        if (!Array.isArray(result)) throw Error("Incomplete RPC batch");
        response = result;
      } catch (error) {
        if (!(error instanceof BatchRateLimit)) throw error;
        limited = true;
        // Whole-request HTTP throttling supplies no usable per-item evidence.
        response =
          error.replies ??
          chunk.map((r) => ({
            id: r.id,
            error: { code: 429, message: "Rate limited" },
          }));
        this.batchSize = Math.max(
          1,
          Math.min(5, Math.floor(this.batchSize / 2)),
        );
      }
      if (response.length !== chunk.length) throw Error("Incomplete RPC batch");
      const replies = new Map(response.map((r) => [r.id, r]));
      if (replies.size !== chunk.length) throw Error("Duplicate RPC batch IDs");
      const retry: Request[] = [];
      for (const request of chunk) {
        const reply = replies.get(request.id);
        if (!reply) throw Error("Missing RPC batch ID");
        if (limited && reply.error?.code === 429) {
          if ((attempts.get(request.id) ?? 0) >= 4) {
            this.rateLimitFailure = new RpcRateLimitExhausted();
            throw this.rateLimitFailure;
          }
          retry.push(request);
        } else if (reply.error || reply.result === undefined) {
          throw new RpcCallError();
        } else values.set(request.id, reply.result);
      }
      pending.unshift(...retry);
    }
    return requests.map((request) => values.get(request.id) as T);
  }
  async logs(
    address: string | readonly string[],
    topics: unknown[],
    from: number,
    to: number,
  ): Promise<RawLog[]> {
    const rows: RawLog[] = [];
    // Plan-limited endpoints can use small ranges batched into one HTTP request.
    // Existing time/request budgets still apply; never return partial coverage.
    for (let start = from; start <= to;) {
      const ranges: { from: number; to: number }[] = [];
      const batchSize = this.logRange < 10000 ? 20 : 1;
      for (
        let next = start;
        next <= to && ranges.length < batchSize;
        next += this.logRange
      )
        ranges.push({ from: next, to: Math.min(to, next + this.logRange - 1) });
      const params = ranges.map((r) => [
        { address, topics, fromBlock: hex(r.from), toBlock: hex(r.to) },
      ]);
      try {
        const result =
          ranges.length === 1
            ? [await this.call<RawLog[]>("eth_getLogs", params[0])]
            : await this.batch<RawLog[]>("eth_getLogs", params);
        result.forEach((logs, i) => {
          if (!Array.isArray(logs)) throw Error("Invalid RPC log result");
          if (
            logs.some(
              (l) =>
                Number(l.blockNumber) < ranges[i].from ||
                Number(l.blockNumber) > ranges[i].to,
            )
          )
            throw Error("Out-of-range log batch");
          rows.push(...logs);
        });
        start = ranges.at(-1)!.to + 1;
      } catch (error) {
        if (!(error instanceof LogRangeLimit)) throw error;
        this.logRange = error.blocks;
      }
    }
    const unique = new Map<string, RawLog>();
    for (const row of rows) {
      const block = Number(row.blockNumber);
      if (row.removed || block < from || block > to)
        throw Error("Noncanonical/out-of-range log");
      const id = `${row.transactionHash}:${row.logIndex}`;
      const prior = unique.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row))
        throw Error("Conflicting duplicate log");
      unique.set(id, row);
    }
    return [...unique.values()].sort(
      (a, b) =>
        Number(a.blockNumber) - Number(b.blockNumber) ||
        Number(a.logIndex) - Number(b.logIndex),
    );
  }
}
export const hex = (n: number): Hex => `0x${n.toString(16)}`;
