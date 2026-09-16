import { toEventSelector, type Hex } from "viem";
import { contracts, swapEvent, transferEvent } from "./events";

/** Envio HyperSync JSON transport for chain 4663. Documented at
 * https://docs.envio.dev/docs/HyperSync/hypersync-query (read 2026-09-16):
 * POST /query with a bearer API token, paging by next_block, at most 5,000
 * logs per response and a 5-second server budget. Wire facts below were
 * recorded against https://4663.hypersync.xyz on 2026-09-16 02:25 UTC and are
 * retained under fixtures/hypersync. This is a separate authenticated API, not
 * a JSON-RPC endpoint, and it never reaches Alchemy. */
export const hypersyncPolicy = Object.freeze({
  defaultUrl: "https://4663.hypersync.xyz",
  chainId: 4663 as const,
  /** Documented per-response ceiling requested as max_num_logs. */
  maxLogsPerPage: 5000,
  /** Measured: bodies above 2,097,152 bytes are rejected with HTTP 413. */
  maxRequestBytes: 2097152,
  /** Measured: 10,000 topic values (690 KB) were accepted in one selection. */
  topicValuesPerSelection: 10000,
  maxSelectionsPerQuery: 2,
  maxResponseBytes: 32 * 1024 * 1024,
  maxRowsPerTable: 20000,
  requestTimeoutMs: 30000,
  maxAttempts: 4,
  /** Lag behind the archive height, matching the collectors' head - 128. */
  safeDistance: 128,
});
/** Fixed field selections. Every retained row keeps exactly these keys. */
export const hypersyncFields = Object.freeze({
  block: ["number", "hash", "parent_hash", "timestamp"],
  transaction: [
    "block_number",
    "block_hash",
    "hash",
    "transaction_index",
    "from",
    "to",
    "status",
  ],
  log: [
    "log_index",
    "transaction_index",
    "transaction_hash",
    "block_hash",
    "block_number",
    "address",
    "data",
    "topic0",
    "topic1",
    "topic2",
    "topic3",
    "removed",
  ],
} as const);
export interface HyperSyncLogSelection {
  address?: string[];
  topics?: string[][];
}
export interface HyperSyncQuery {
  from_block: number;
  /** Exclusive, as documented. */
  to_block?: number;
  logs?: HyperSyncLogSelection[];
  include_all_blocks?: boolean;
  field_selection: {
    block?: string[];
    transaction?: string[];
    log?: string[];
  };
  max_num_logs?: number;
}
/** Verbatim selected fields of one returned row. Quantities keep the server's
 * encoding: JSON numbers for block_number, log_index, transaction_index and
 * status; a 0x-prefixed hex string for the block timestamp. */
export interface HyperSyncLogRow {
  log_index: number;
  transaction_index: number;
  transaction_hash: string;
  block_hash: string;
  block_number: number;
  address: string;
  data: string;
  topic0: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  removed: boolean | null;
}
export interface HyperSyncTransactionRow {
  block_number: number;
  block_hash: string;
  hash: string;
  transaction_index: number;
  from: string;
  to: string | null;
  status: number;
}
export interface HyperSyncBlockRow {
  number: number;
  hash: string;
  parent_hash: string;
  timestamp: string;
}
export interface HyperSyncRollbackGuard {
  block_number: number;
  timestamp: number;
  hash: string;
  first_block_number: number;
  first_parent_hash: string;
}
export interface HyperSyncPage {
  fromBlock: number;
  nextBlock: number;
  archiveHeight: number | null;
  totalExecutionTime: number;
  rollbackGuard: HyperSyncRollbackGuard | null;
  logs: HyperSyncLogRow[];
  transactions: HyperSyncTransactionRow[];
  blocks: HyperSyncBlockRow[];
  bytes: number;
}
/** Retained per page: response metadata and counts, never the token. */
export interface HyperSyncPageRecord {
  fromBlock: number;
  nextBlock: number;
  archiveHeight: number | null;
  totalExecutionTime: number;
  rollbackGuard: HyperSyncRollbackGuard | null;
  logs: number;
  transactions: number;
  blocks: number;
  bytes: number;
}
export interface HyperSyncRetryEvent {
  attempt: number;
  status: number | null;
  waitMs: number;
  reason: "throttled" | "server_error" | "network";
}
export interface HyperSyncClientOptions {
  url?: string;
  token?: string | null;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxRequests?: number;
  minIntervalMs?: number;
  maxResponseBytes?: number;
  maxRowsPerTable?: number;
  /** Base of the exponential wait between attempts; tests shorten it. */
  retryBaseMs?: number;
  onRetry?: (event: HyperSyncRetryEvent) => void;
}
export class HyperSyncUnauthorized extends Error {
  constructor(readonly status: number) {
    super("HyperSync rejected the API token");
    this.name = "HyperSyncUnauthorized";
  }
}
export class HyperSyncRateLimitExhausted extends Error {
  constructor() {
    super("HyperSync rate limit exhausted after 4 throttled attempts");
    this.name = "HyperSyncRateLimitExhausted";
  }
}
export class HyperSyncResponseCapacity extends Error {
  constructor() {
    super("HyperSync response exceeds capacity");
    this.name = "HyperSyncResponseCapacity";
  }
}
export class HyperSyncRequestRejected extends Error {
  constructor(readonly status: number) {
    super(`HyperSync rejected the request with HTTP ${status}`);
    this.name = "HyperSyncRequestRejected";
  }
}
export class HyperSyncBudgetExceeded extends Error {
  constructor(readonly requests: number) {
    super(`HyperSync request budget exceeded after ${requests} requests`);
    this.name = "HyperSyncBudgetExceeded";
  }
}
/** One block group exceeded a per-batch cap and cannot be split by block. */
export class HyperSyncPageCapacity extends Error {
  constructor(
    readonly fromBlock: number,
    readonly nextBlock: number,
    readonly logs: number,
    readonly bytes: number,
  ) {
    super(
      "HyperSync page exceeds batch capacity; the block group cannot be split",
    );
    this.name = "HyperSyncPageCapacity";
  }
}

const hex64 = /^0x[0-9a-f]{64}$/i,
  hex40 = /^0x[0-9a-f]{40}$/i,
  hexData = /^0x(?:[0-9a-f]{2})*$/i,
  hexQuantity = /^0x[0-9a-f]{1,16}$/i;
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const blockTimestamp = (block: HyperSyncBlockRow) =>
  Number(block.timestamp);
/** Topics as an array, in the JSON-RPC log shape. */
export function logTopics(log: HyperSyncLogRow): Hex[] {
  const topics: Hex[] = [];
  for (const topic of [log.topic0, log.topic1, log.topic2, log.topic3]) {
    if (topic === undefined || topic === null) break;
    topics.push(topic as Hex);
  }
  return topics;
}
function rowObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("HyperSync returned an invalid row");
  return v as Record<string, unknown>;
}
export function checkedLogRow(v: unknown): HyperSyncLogRow {
  const r = rowObject(v);
  const topics: (string | undefined)[] = [];
  for (const key of ["topic0", "topic1", "topic2", "topic3"] as const) {
    const t = r[key];
    if (t === undefined || t === null) {
      topics.push(undefined);
      continue;
    }
    if (typeof t !== "string" || !hex64.test(t))
      throw Error("HyperSync returned an invalid log topic");
    topics.push(t);
  }
  // Topics are positional; a gap would silently shift decoded arguments.
  const present = topics.findIndex((t) => t === undefined);
  if (
    present === 0 ||
    (present !== -1 && topics.slice(present).some((t) => t !== undefined))
  )
    throw Error("HyperSync returned an invalid log topic");
  if (
    !integer(r.log_index) ||
    !integer(r.transaction_index) ||
    !integer(r.block_number) ||
    typeof r.transaction_hash !== "string" ||
    !hex64.test(r.transaction_hash) ||
    typeof r.block_hash !== "string" ||
    !hex64.test(r.block_hash) ||
    typeof r.address !== "string" ||
    !hex40.test(r.address) ||
    typeof r.data !== "string" ||
    !hexData.test(r.data) ||
    (r.removed !== null && r.removed !== undefined && r.removed !== false)
  )
    throw Error("HyperSync returned an invalid log row");
  return {
    log_index: r.log_index,
    transaction_index: r.transaction_index,
    transaction_hash: r.transaction_hash,
    block_hash: r.block_hash,
    block_number: r.block_number,
    address: r.address,
    data: r.data,
    topic0: topics[0]!,
    ...(topics[1] === undefined ? {} : { topic1: topics[1] }),
    ...(topics[2] === undefined ? {} : { topic2: topics[2] }),
    ...(topics[3] === undefined ? {} : { topic3: topics[3] }),
    removed: r.removed === undefined ? null : (r.removed as boolean | null),
  };
}
export function checkedTransactionRow(v: unknown): HyperSyncTransactionRow {
  const r = rowObject(v);
  if (
    !integer(r.block_number) ||
    !integer(r.transaction_index) ||
    typeof r.block_hash !== "string" ||
    !hex64.test(r.block_hash) ||
    typeof r.hash !== "string" ||
    !hex64.test(r.hash) ||
    typeof r.from !== "string" ||
    !hex40.test(r.from) ||
    (r.to !== null &&
      r.to !== undefined &&
      (typeof r.to !== "string" || !hex40.test(r.to))) ||
    (r.status !== 0 && r.status !== 1)
  )
    throw Error("HyperSync returned an invalid transaction row");
  return {
    block_number: r.block_number,
    block_hash: r.block_hash,
    hash: r.hash,
    transaction_index: r.transaction_index,
    from: r.from,
    to: r.to === undefined ? null : (r.to as string | null),
    status: r.status,
  };
}
export function checkedBlockRow(v: unknown): HyperSyncBlockRow {
  const r = rowObject(v);
  if (
    !integer(r.number) ||
    typeof r.hash !== "string" ||
    !hex64.test(r.hash) ||
    typeof r.parent_hash !== "string" ||
    !hex64.test(r.parent_hash) ||
    typeof r.timestamp !== "string" ||
    !hexQuantity.test(r.timestamp) ||
    !Number.isSafeInteger(Number(r.timestamp))
  )
    throw Error("HyperSync returned an invalid block row");
  return {
    number: r.number,
    hash: r.hash,
    parent_hash: r.parent_hash,
    timestamp: r.timestamp,
  };
}
function checkedRollbackGuard(v: unknown): HyperSyncRollbackGuard | null {
  if (v === null || v === undefined) return null;
  const r = rowObject(v);
  if (
    !integer(r.block_number) ||
    !integer(r.first_block_number) ||
    typeof r.timestamp !== "number" ||
    !Number.isSafeInteger(r.timestamp) ||
    typeof r.hash !== "string" ||
    !hex64.test(r.hash) ||
    typeof r.first_parent_hash !== "string" ||
    !hex64.test(r.first_parent_hash)
  )
    throw Error("HyperSync returned an invalid rollback guard");
  return {
    block_number: r.block_number,
    timestamp: r.timestamp,
    hash: r.hash,
    first_block_number: r.first_block_number,
    first_parent_hash: r.first_parent_hash,
  };
}
/** Validate one JSON response for the query that produced it. The wire shape
 * carries `data` as an array of chunks; the documented struct form is also
 * accepted. Row caps bound memory before any row is inspected. */
export function checkedPage(
  query: HyperSyncQuery,
  raw: unknown,
  bytes: number,
  maxRowsPerTable: number = hypersyncPolicy.maxRowsPerTable,
): HyperSyncPage {
  const r = rowObject(raw);
  if (
    !integer(r.next_block) ||
    r.next_block < query.from_block ||
    (query.to_block !== undefined && r.next_block > query.to_block) ||
    (r.archive_height !== null &&
      r.archive_height !== undefined &&
      !integer(r.archive_height)) ||
    !integer(r.total_execution_time)
  )
    throw Error("HyperSync returned an invalid response envelope");
  const chunks = Array.isArray(r.data) ? r.data : [r.data];
  const logs: HyperSyncLogRow[] = [],
    transactions: HyperSyncTransactionRow[] = [],
    blocks: HyperSyncBlockRow[] = [];
  for (const chunk of chunks) {
    const c = chunk === undefined ? {} : rowObject(chunk);
    for (const [key, rows, check] of [
      ["logs", logs, checkedLogRow],
      ["transactions", transactions, checkedTransactionRow],
      ["blocks", blocks, checkedBlockRow],
    ] as const) {
      const value = c[key];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) throw Error("HyperSync returned invalid data");
      if (rows.length + value.length > maxRowsPerTable)
        throw new HyperSyncResponseCapacity();
      for (const row of value) (rows as unknown[]).push(check(row));
    }
  }
  const next = r.next_block;
  for (const l of logs)
    if (l.block_number < query.from_block || l.block_number >= next)
      throw Error("HyperSync returned a log outside the page");
  for (const t of transactions)
    if (t.block_number < query.from_block || t.block_number >= next)
      throw Error("HyperSync returned a transaction outside the page");
  for (const b of blocks)
    if (b.number < query.from_block || b.number >= next)
      throw Error("HyperSync returned a block outside the page");
  return {
    fromBlock: query.from_block,
    nextBlock: next,
    archiveHeight:
      r.archive_height === undefined
        ? null
        : (r.archive_height as number | null),
    totalExecutionTime: r.total_execution_time,
    rollbackGuard: checkedRollbackGuard(r.rollback_guard),
    logs,
    transactions,
    blocks,
    bytes,
  };
}
export const pageRecord = (page: HyperSyncPage): HyperSyncPageRecord => ({
  fromBlock: page.fromBlock,
  nextBlock: page.nextBlock,
  archiveHeight: page.archiveHeight,
  totalExecutionTime: page.totalExecutionTime,
  rollbackGuard: page.rollbackGuard,
  logs: page.logs.length,
  transactions: page.transactions.length,
  blocks: page.blocks.length,
  bytes: page.bytes,
});

function checkedRange(fromBlock: number, toBlock: number) {
  if (!integer(fromBlock) || !integer(toBlock) || toBlock < fromBlock)
    throw Error("Invalid HyperSync block range");
}
/** Split one value list into selection-sized chunks. */
export function chunkValues<T>(
  values: readonly T[],
  size: number = hypersyncPolicy.topicValuesPerSelection,
): T[][] {
  if (!Number.isSafeInteger(size) || size < 1)
    throw Error("Invalid HyperSync chunk size");
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    chunks.push(values.slice(i, i + size));
  return chunks;
}
export function checkedQuery(query: HyperSyncQuery): HyperSyncQuery {
  if (
    !integer(query.from_block) ||
    (query.to_block !== undefined &&
      (!integer(query.to_block) || query.to_block <= query.from_block)) ||
    (query.logs?.length ?? 0) > hypersyncPolicy.maxSelectionsPerQuery ||
    (query.max_num_logs !== undefined &&
      (!integer(query.max_num_logs) ||
        query.max_num_logs < 1 ||
        query.max_num_logs > hypersyncPolicy.maxLogsPerPage))
  )
    throw Error("Invalid HyperSync query");
  if (
    Buffer.byteLength(JSON.stringify(query)) > hypersyncPolicy.maxRequestBytes
  )
    throw Error(
      "HyperSync query exceeds the request body limit; split the selection",
    );
  return query;
}
/** PoolManager Swap logs, optionally restricted to pool ids in topics[1]. The
 * ids are split across selections; more ids than one query holds must be
 * spread over separate queries by the caller. Without ids every manager swap
 * is returned and the caller filters locally. */
export function swapLogQuery(
  range: { fromBlock: number; toBlock: number },
  poolIds?: readonly string[],
): HyperSyncQuery {
  checkedRange(range.fromBlock, range.toBlock);
  const topic = toEventSelector(swapEvent);
  const ids = poolIds?.map((id) => {
    if (!hex64.test(id)) throw Error("Invalid HyperSync pool id selection");
    return id.toLowerCase();
  });
  if (ids && (!ids.length || new Set(ids).size !== ids.length))
    throw Error("Invalid HyperSync pool id selection");
  return checkedQuery({
    from_block: range.fromBlock,
    to_block: range.toBlock + 1,
    logs: ids
      ? chunkValues(ids).map((chunk) => ({
          address: [contracts.manager],
          topics: [[topic], chunk],
        }))
      : [{ address: [contracts.manager], topics: [[topic]] }],
    field_selection: {
      block: [...hypersyncFields.block],
      transaction: [...hypersyncFields.transaction],
      log: [...hypersyncFields.log],
    },
    max_num_logs: hypersyncPolicy.maxLogsPerPage,
  });
}
/** ERC-20 Transfer logs emitted by the listed token contracts. */
export function transferLogQuery(
  range: { fromBlock: number; toBlock: number },
  tokens: readonly string[],
): HyperSyncQuery {
  checkedRange(range.fromBlock, range.toBlock);
  const addresses = tokens.map((t) => {
    if (!hex40.test(t)) throw Error("Invalid HyperSync token selection");
    return t.toLowerCase();
  });
  if (!addresses.length || new Set(addresses).size !== addresses.length)
    throw Error("Invalid HyperSync token selection");
  return checkedQuery({
    from_block: range.fromBlock,
    to_block: range.toBlock + 1,
    logs: chunkValues(addresses).map((chunk) => ({
      address: chunk,
      topics: [[toEventSelector(transferEvent)]],
    })),
    field_selection: {
      block: [...hypersyncFields.block],
      transaction: [...hypersyncFields.transaction],
      log: [...hypersyncFields.log],
    },
    max_num_logs: hypersyncPolicy.maxLogsPerPage,
  });
}
/** One canonical header, as documented by include_all_blocks. */
export function headerQuery(block: number): HyperSyncQuery {
  if (!integer(block)) throw Error("Invalid HyperSync header block");
  return {
    from_block: block,
    to_block: block + 1,
    include_all_blocks: true,
    field_selection: { block: [...hypersyncFields.block] },
  };
}

export class HyperSyncClient {
  requests = 0;
  bytes = 0;
  readonly url: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly signal?: AbortSignal;
  private readonly requestTimeoutMs: number;
  private readonly maxRequests: number;
  private readonly minIntervalMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRowsPerTable: number;
  private readonly retryBaseMs: number;
  private readonly onRetry?: (event: HyperSyncRetryEvent) => void;
  private nextRequestAt = 0;
  constructor(options: HyperSyncClientOptions = {}) {
    const url = options.url ?? hypersyncPolicy.defaultUrl;
    if (
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url) &&
      !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(url)
    )
      throw Error(
        "Invalid HYPERSYNC_URL; expected an https origin without a path",
      );
    this.url = url;
    this.token = options.token ?? null;
    if (this.token !== null && !/^[\x21-\x7e]{8,512}$/.test(this.token))
      throw Error("Invalid ENVIO_API_TOKEN");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? hypersyncPolicy.requestTimeoutMs;
    this.maxRequests = options.maxRequests ?? 1000;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.maxResponseBytes =
      options.maxResponseBytes ?? hypersyncPolicy.maxResponseBytes;
    this.maxRowsPerTable =
      options.maxRowsPerTable ?? hypersyncPolicy.maxRowsPerTable;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.onRetry = options.onRetry;
    for (const [name, value, min, max] of [
      ["requestTimeoutMs", this.requestTimeoutMs, 1, 600000],
      ["maxRequests", this.maxRequests, 1, 10000000],
      ["minIntervalMs", this.minIntervalMs, 0, 60000],
      ["maxResponseBytes", this.maxResponseBytes, 1024, 256 * 1024 * 1024],
      ["maxRowsPerTable", this.maxRowsPerTable, 1, 1000000],
      ["retryBaseMs", this.retryBaseMs, 1, 60000],
    ] as const)
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw Error(`Invalid HyperSync client option ${name}`);
  }
  get authenticated() {
    return this.token !== null;
  }
  private async wait(ms: number) {
    this.signal?.throwIfAborted();
    if (ms <= 0) return;
    const signal = this.signal;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private async retry(
    attempt: number,
    status: number | null,
    reason: HyperSyncRetryEvent["reason"],
    retryAfterMs: number | null = null,
  ) {
    const waitMs =
      reason === "throttled"
        ? Math.min(60000, retryAfterMs ?? 2 * this.retryBaseMs * 2 ** attempt)
        : this.retryBaseMs * 2 ** attempt;
    this.onRetry?.({ attempt: attempt + 1, status, waitMs, reason });
    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + waitMs);
    await this.wait(waitMs);
  }
  private async boundedBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw Error("HyperSync returned an empty body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      const length = Number(response.headers.get("content-length"));
      if (length > this.maxResponseBytes) throw new HyperSyncResponseCapacity();
      for (;;) {
        this.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.maxResponseBytes)
          throw new HyperSyncResponseCapacity();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.bytes += bytes;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  }
  private async send(
    path: "/height" | "/query",
    body?: HyperSyncQuery,
  ): Promise<{ json: unknown; bytes: number }> {
    if (body && this.token === null) throw new HyperSyncUnauthorized(401);
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      const scheduledAt = Math.max(Date.now(), this.nextRequestAt);
      this.nextRequestAt = scheduledAt + this.minIntervalMs;
      await this.wait(scheduledAt - Date.now());
      if (this.requests >= this.maxRequests)
        throw new HyperSyncBudgetExceeded(this.requests);
      this.requests++;
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.url}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: this.signal
            ? AbortSignal.any([this.signal, timeout])
            : timeout,
          cache: "no-store",
        });
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (attempt + 1 >= hypersyncPolicy.maxAttempts)
          throw Error("HyperSync request failed after retries");
        await this.retry(attempt, null, "network");
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => {});
        if (attempt + 1 >= hypersyncPolicy.maxAttempts)
          throw new HyperSyncRateLimitExhausted();
        const header = Number(response.headers.get("retry-after"));
        await this.retry(
          attempt,
          429,
          "throttled",
          Number.isFinite(header) && header > 0 ? header * 1000 : null,
        );
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new HyperSyncUnauthorized(response.status);
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        if (attempt + 1 >= hypersyncPolicy.maxAttempts)
          throw new HyperSyncRequestRejected(response.status);
        await this.retry(attempt, response.status, "server_error");
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new HyperSyncRequestRejected(response.status);
      }
      const text = await this.boundedBody(response);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw Error("HyperSync returned invalid JSON");
      }
      return { json, bytes: Buffer.byteLength(text) };
    }
  }
  /** GET /height answers without a token. */
  async height(): Promise<number> {
    const { json } = await this.send("/height");
    const height = rowObject(json).height;
    if (!integer(height)) throw Error("HyperSync returned an invalid height");
    return height;
  }
  async query(query: HyperSyncQuery): Promise<HyperSyncPage> {
    const { json, bytes } = await this.send("/query", checkedQuery(query));
    return checkedPage(query, json, bytes, this.maxRowsPerTable);
  }
  async header(block: number): Promise<HyperSyncBlockRow> {
    const page = await this.query(headerQuery(block));
    const row = page.blocks[0];
    if (page.blocks.length !== 1 || row.number !== block)
      throw Error("HyperSync returned an unexpected header");
    return row;
  }
}

export interface CollectedPages {
  pages: HyperSyncPageRecord[];
  /** Every log of every consumed page, sorted by block, log index, hash. */
  logs: HyperSyncLogRow[];
  transactions: Map<string, HyperSyncTransactionRow>;
  blocks: Map<number, HyperSyncBlockRow>;
  /** The last complete block, at most the requested end. */
  toBlock: number;
  archiveHeight: number;
}
/** Consume whole pages until the range completes or a cap would be crossed.
 * A page is never split, so every consumed page is block-complete and the
 * range ends at the last consumed page. */
export async function collectLogPages(
  client: HyperSyncClient,
  query: HyperSyncQuery,
  caps: {
    maxPages: number;
    maxLogs: number;
    maxBytes: number;
    safeDistance?: number;
  },
): Promise<CollectedPages> {
  if (
    query.to_block === undefined ||
    !Number.isSafeInteger(caps.maxPages) ||
    caps.maxPages < 1 ||
    caps.maxPages > 64 ||
    !Number.isSafeInteger(caps.maxLogs) ||
    caps.maxLogs < 1 ||
    !Number.isSafeInteger(caps.maxBytes) ||
    caps.maxBytes < 1
  )
    throw Error("Invalid HyperSync page collection");
  const safeDistance = caps.safeDistance ?? hypersyncPolicy.safeDistance;
  const requestedTo = query.to_block - 1;
  const pages: HyperSyncPageRecord[] = [];
  const logs: HyperSyncLogRow[] = [];
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const blocks = new Map<number, HyperSyncBlockRow>();
  let next = query.from_block,
    bytes = 0,
    archiveHeight = 0;
  while (next <= requestedTo && pages.length < caps.maxPages) {
    const page = await client.query({ ...query, from_block: next });
    if (page.nextBlock <= next) throw Error("HyperSync page did not advance");
    if (
      page.archiveHeight === null ||
      page.archiveHeight - safeDistance < requestedTo
    )
      throw Error("HyperSync archive height below the confirmed cutoff");
    if (
      logs.length + page.logs.length > caps.maxLogs ||
      bytes + page.bytes > caps.maxBytes
    ) {
      if (!pages.length)
        throw new HyperSyncPageCapacity(
          next,
          page.nextBlock,
          page.logs.length,
          page.bytes,
        );
      break;
    }
    for (const t of page.transactions) {
      const key = t.hash.toLowerCase();
      const prior = transactions.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(t))
        throw Error("HyperSync returned conflicting transactions");
      transactions.set(key, t);
    }
    for (const b of page.blocks) {
      const prior = blocks.get(b.number);
      if (prior && JSON.stringify(prior) !== JSON.stringify(b))
        throw Error("HyperSync returned conflicting blocks");
      blocks.set(b.number, b);
    }
    logs.push(...page.logs);
    pages.push(pageRecord(page));
    bytes += page.bytes;
    archiveHeight = page.archiveHeight;
    next = page.nextBlock;
  }
  if (!pages.length) throw Error("HyperSync returned no pages");
  logs.sort(
    (a, b) =>
      a.block_number - b.block_number ||
      a.log_index - b.log_index ||
      a.transaction_hash
        .toLowerCase()
        .localeCompare(b.transaction_hash.toLowerCase()),
  );
  return {
    pages,
    logs,
    transactions,
    blocks,
    toBlock: Math.min(requestedTo, next - 1),
    archiveHeight,
  };
}
/** Retain the blocks a batch depends on, in ascending order, and check them
 * against each other: parent links between neighbours, non-decreasing
 * timestamps, and nothing after the cutoff dated later than the cutoff. */
export function checkedRetainedBlocks(
  blocks: readonly HyperSyncBlockRow[],
  toBlock: number,
): HyperSyncBlockRow[] {
  const sorted = [...blocks].sort((a, b) => a.number - b.number);
  const cutoff = sorted.find((b) => b.number === toBlock);
  if (!cutoff) throw Error("HyperSync cutoff header missing");
  for (const [i, b] of sorted.entries()) {
    const previous = sorted[i - 1];
    if (
      (previous && previous.number === b.number) ||
      (previous && blockTimestamp(b) < blockTimestamp(previous)) ||
      (previous &&
        previous.number === b.number - 1 &&
        !same(b.parent_hash, previous.hash)) ||
      (b.number <= toBlock && blockTimestamp(b) > blockTimestamp(cutoff))
    )
      throw Error("Inconsistent HyperSync canonical headers");
  }
  return sorted;
}
/** The transaction and block a retained log depends on, both consistent with it. */
export function joinedLog(
  log: HyperSyncLogRow,
  transactions: ReadonlyMap<string, HyperSyncTransactionRow>,
  blocks: ReadonlyMap<number, HyperSyncBlockRow>,
) {
  const transaction = transactions.get(log.transaction_hash.toLowerCase());
  const block = blocks.get(log.block_number);
  if (
    !transaction ||
    transaction.status !== 1 ||
    transaction.block_number !== log.block_number ||
    !same(transaction.block_hash, log.block_hash) ||
    !block ||
    !same(block.hash, log.block_hash)
  )
    throw Error(
      "HyperSync log lacks a consistent successful transaction or block",
    );
  return { transaction, block };
}
