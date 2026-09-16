import {
  HyperSyncClient,
  HyperSyncPageCapacity,
  collectHyperSyncBroadGroup,
  hypersyncPolicy,
  swapLogQuery,
  broadEventPolicy,
  type HyperSyncBlockRow,
  type HyperSyncRetryEvent,
} from "@pools/chain";
import {
  broadRangeCheckpoint,
  broadStreamIdentity,
  checkpoints,
  commitPoolGroup,
  discoveryV2Identity,
  ensureBroadStream,
  getStream,
  markAttempt,
  resolveBroadPools,
  rewind,
  type Client,
  type Stream,
} from "@pools/db";
import { safeError } from "./errors";

/** Off by default and never part of the indexer service. The backfill writes
 * the existing tier-2 stream `swaps:broad:v1` from HyperSync instead of from
 * Alchemy, one bounded range per batch, under the same writer lock, the same
 * discovery:v2 registry pin, the same content-hashed evidence and the same
 * canonical reconciliation as the broad worker. It never touches discovery:v1
 * or any pool stream. */
export interface HyperSyncBackfillConfig {
  enabled: boolean;
  url: string;
  token: string | null;
  batchBlocks: number;
  maxBatches: number;
  maxBlocks: number;
  maxPages: number;
  maxRequests: number;
  minIntervalMs: number;
}
function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`);
  return n;
}
export function hypersyncBackfillConfig(
  env: NodeJS.ProcessEnv = process.env,
): HyperSyncBackfillConfig {
  const flag = env.HYPERSYNC_BACKFILL_ENABLED;
  if (flag !== undefined && flag !== "0" && flag !== "1")
    throw Error("Invalid HYPERSYNC_BACKFILL_ENABLED; expected 0 or 1");
  const token = env.ENVIO_API_TOKEN?.trim();
  return {
    enabled: flag === "1",
    url: env.HYPERSYNC_URL ?? hypersyncPolicy.defaultUrl,
    token: token ? token : null,
    batchBlocks: integer(
      env,
      "HYPERSYNC_BATCH_BLOCKS",
      broadEventPolicy.maxBlocks - 1,
      1,
      broadEventPolicy.maxBlocks - 1,
    ),
    maxBatches: integer(env, "HYPERSYNC_MAX_BATCHES", 50, 1, 100000),
    maxBlocks: integer(env, "HYPERSYNC_MAX_BLOCKS", 500000, 1, 50000000),
    maxPages: integer(env, "HYPERSYNC_MAX_PAGES", 4, 1, 16),
    maxRequests: integer(env, "HYPERSYNC_MAX_REQUESTS", 2000, 1, 1000000),
    minIntervalMs: integer(env, "HYPERSYNC_MIN_INTERVAL_MS", 1000, 0, 60000),
  };
}
/** Both gates are required before any authenticated request is built. */
export function assertHyperSyncBackfillAllowed(
  config: HyperSyncBackfillConfig,
) {
  if (!config.enabled)
    throw Error(
      "HyperSync backfill disabled; set HYPERSYNC_BACKFILL_ENABLED=1",
    );
  if (config.token === null)
    throw Error("ENVIO_API_TOKEN is required for HyperSync queries");
}
export function createHyperSyncClient(
  config: HyperSyncBackfillConfig,
  options: {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    onRetry?: (event: HyperSyncRetryEvent) => void;
  } = {},
) {
  assertHyperSyncBackfillAllowed(config);
  return new HyperSyncClient({
    url: config.url,
    token: config.token,
    fetch: options.fetch,
    signal: options.signal,
    maxRequests: config.maxRequests,
    minIntervalMs: config.minIntervalMs,
    onRetry: options.onRetry,
  });
}
type Log = (event: Record<string, unknown>) => void;
const quiet: Log = () => {};
async function canonicalHash(client: HyperSyncClient, n: number) {
  return (await client.header(n)).hash.toLowerCase();
}
/** The broad worker's reconciliation, reading canonical headers from
 * HyperSync: walk saved checkpoints back to the newest one still canonical
 * and rewind to it. The stream is created if missing, never any other. The
 * next block's header, when the caller already holds it, proves the cursor
 * canonical through its parent hash without another read. */
export async function reconcileBroadStream(
  db: Client,
  client: HyperSyncClient,
  log: Log = quiet,
  next?: HyperSyncBlockRow,
): Promise<Stream> {
  const s = await ensureBroadStream(db);
  if (s.cursor === null) return s;
  const canonical =
    next && next.number === s.cursor + 1
      ? next.parent_hash.toLowerCase()
      : await canonicalHash(client, s.cursor);
  if (canonical === s.hash) return s;
  let ancestor: number | null = null;
  for (const batch of await checkpoints(db, s.key))
    if ((await canonicalHash(client, batch.to)) === batch.hash) {
      ancestor = batch.to;
      break;
    }
  await rewind(db, s, ancestor);
  log({
    event: "hypersync_rewind",
    stream: s.key,
    from: s.cursor,
    to: ancestor,
  });
  return getStream(db, s.key);
}
export interface HyperSyncBatchProgress {
  idle: null | "head" | "discovery";
  from: number;
  to: number | null;
  committed: boolean;
  observedSwaps: number;
  registeredSwaps: number;
  unsupportedSwaps: number;
  unregisteredPools: number;
  pages: number;
  requests: number;
  bytes: number;
  elapsedMs: number;
  archiveHeight: number;
  discoveryThroughBlock: number | null;
  lagBlocks: number;
}
export interface HyperSyncBatchOptions {
  batchBlocks: number;
  maxPages: number;
  safeDistance?: number;
  signal?: AbortSignal;
  log?: Log;
}
/** One range: reconcile, pin the registry, collect, recheck boundaries against
 * the provider again, commit. Failures leave the cursor untouched. */
export async function runHyperSyncBatch(
  db: Client,
  client: HyperSyncClient,
  options: HyperSyncBatchOptions,
): Promise<HyperSyncBatchProgress> {
  const safeDistance = options.safeDistance ?? hypersyncPolicy.safeDistance;
  if (
    !Number.isSafeInteger(options.batchBlocks) ||
    options.batchBlocks < 1 ||
    options.batchBlocks >= broadEventPolicy.maxBlocks ||
    !Number.isSafeInteger(safeDistance) ||
    safeDistance < hypersyncPolicy.safeDistance
  )
    throw Error("Invalid HyperSync batch options");
  const started = performance.now();
  const requests0 = client.requests,
    bytes0 = client.bytes;
  const counters = () => ({
    requests: client.requests - requests0,
    bytes: client.bytes - bytes0,
    elapsedMs: Math.round(performance.now() - started),
  });
  options.signal?.throwIfAborted();
  // One header read serves both the cursor's reconciliation (through the
  // parent hash) and the parent link of the range about to be collected.
  const saved = await ensureBroadStream(db);
  const next = await client.header(
    saved.cursor === null ? saved.start : saved.cursor + 1,
  );
  const stream = await reconcileBroadStream(db, client, options.log, next);
  const height = await client.height();
  const confirmed = height - safeDistance;
  const from = stream.cursor === null ? stream.start : stream.cursor + 1;
  const requestedTo = Math.min(confirmed, from + options.batchBlocks - 1);
  const idle = (
    reason: "head" | "discovery",
    discoveryThroughBlock: number | null,
  ): HyperSyncBatchProgress => ({
    idle: reason,
    from,
    to: null,
    committed: false,
    observedSwaps: 0,
    registeredSwaps: 0,
    unsupportedSwaps: 0,
    unregisteredPools: 0,
    pages: 0,
    ...counters(),
    archiveHeight: height,
    discoveryThroughBlock,
    lagBlocks: Math.max(0, confirmed - (stream.cursor ?? stream.start - 1)),
  });
  if (from > requestedTo) return idle("head", null);
  const range = await broadRangeCheckpoint(db, from, requestedTo);
  if (!range) return idle("discovery", null);
  const { registry } = range;
  const first = next.number === from ? next : await client.header(from);
  if (stream.hash && first.parent_hash.toLowerCase() !== stream.hash)
    throw Error("Checkpoint parent changed");
  await markAttempt(db, stream.key);
  options.signal?.throwIfAborted();
  const group = await collectHyperSyncBroadGroup(
    {
      fromBlock: from,
      toBlock: range.toBlock,
      registry,
      resolvePools: (ids) => resolveBroadPools(db, ids, registry),
      maxPages: options.maxPages,
      height,
      headers: [first],
    },
    client,
  );
  options.signal?.throwIfAborted();
  // These must hit the provider again, not the rows just collected.
  if (
    group.fromBlockParentHash !== first.parent_hash.toLowerCase() ||
    (await canonicalHash(client, from)) !== first.hash.toLowerCase() ||
    (await canonicalHash(client, group.toBlock)) !== group.blockHash ||
    (await canonicalHash(client, registry.throughBlock)) !== registry.blockHash
  )
    throw Error("Broad boundary changed during collection");
  options.signal?.throwIfAborted();
  const committed = await commitPoolGroup(db, {
    mode: "broad",
    expected: stream,
    group,
  });
  return {
    idle: null,
    from,
    to: group.toBlock,
    committed,
    observedSwaps: group.observedSwaps,
    registeredSwaps: group.swaps.length,
    unsupportedSwaps: group.unsupportedSwaps,
    unregisteredPools: group.evidence.unregistered.poolIds.length,
    pages: group.evidence.pages.length,
    ...counters(),
    archiveHeight: height,
    discoveryThroughBlock: registry.throughBlock,
    lagBlocks: Math.max(0, confirmed - group.toBlock),
  };
}
export interface HyperSyncBackfillOptions extends HyperSyncBatchOptions {
  maxBatches: number;
  maxBlocks: number;
}
export interface HyperSyncBackfillSummary {
  stopped: "caps" | "head" | "discovery" | "aborted";
  batches: number;
  blocks: number;
  observedSwaps: number;
  registeredSwaps: number;
  unsupportedSwaps: number;
  requests: number;
  bytes: number;
  elapsedMs: number;
  from: number | null;
  through: number | null;
  lagBlocks: number | null;
  archiveHeight: number | null;
}
/** Bounded per run by batches and blocks; each batch commits or fails alone,
 * so a stopped run resumes from the saved cursor. */
export async function runHyperSyncBackfill(
  db: Client,
  client: HyperSyncClient,
  options: HyperSyncBackfillOptions,
): Promise<HyperSyncBackfillSummary> {
  if (
    !Number.isSafeInteger(options.maxBatches) ||
    options.maxBatches < 1 ||
    !Number.isSafeInteger(options.maxBlocks) ||
    options.maxBlocks < 1
  )
    throw Error("Invalid HyperSync backfill options");
  const started = performance.now();
  const log = options.log ?? quiet;
  const summary: HyperSyncBackfillSummary = {
    stopped: "caps",
    batches: 0,
    blocks: 0,
    observedSwaps: 0,
    registeredSwaps: 0,
    unsupportedSwaps: 0,
    requests: 0,
    bytes: 0,
    elapsedMs: 0,
    from: null,
    through: null,
    lagBlocks: null,
    archiveHeight: null,
  };
  while (
    summary.batches < options.maxBatches &&
    summary.blocks < options.maxBlocks
  ) {
    if (options.signal?.aborted) {
      summary.stopped = "aborted";
      break;
    }
    const progress = await runHyperSyncBatch(db, client, options);
    summary.requests += progress.requests;
    summary.bytes += progress.bytes;
    summary.archiveHeight = progress.archiveHeight;
    summary.lagBlocks = progress.lagBlocks;
    if (progress.idle) {
      summary.stopped = progress.idle;
      log({
        event: "hypersync_backfill_idle",
        stream: broadStreamIdentity.key,
        ...progress,
      });
      break;
    }
    summary.batches++;
    summary.blocks += progress.to! - progress.from + 1;
    summary.observedSwaps += progress.observedSwaps;
    summary.registeredSwaps += progress.registeredSwaps;
    summary.unsupportedSwaps += progress.unsupportedSwaps;
    summary.from ??= progress.from;
    summary.through = progress.to;
    log({
      event: "hypersync_batch",
      stream: broadStreamIdentity.key,
      ...progress,
    });
  }
  summary.elapsedMs = Math.round(performance.now() - started);
  return summary;
}
export interface HyperSyncBackfillPlan {
  stream: {
    key: string;
    exists: boolean;
    start: number;
    cursor: number | null;
    hash: string | null;
  };
  discovery: { key: string; cursor: number | null };
  archiveHeight: number;
  confirmed: number;
  from: number;
  cap: number;
  remainingBlocks: number;
  firstPage: null | {
    query: { from_block: number; to_block: number };
    nextBlock: number;
    blocksCovered: number;
    logs: number;
    transactions: number;
    blocks: number;
    bytes: number;
    totalExecutionTime: number;
    archiveHeight: number | null;
    rollbackGuard: boolean;
    logFields: string[];
    transactionFields: string[];
    blockFields: string[];
    managerSwapsPerBlock: number | null;
  };
  estimate: null | {
    basis: string;
    managerSwaps: number;
    pages: number;
    batches: number;
    requests: number;
  };
  caps: {
    batchBlocks: number;
    maxPages: number;
    maxBatches: number;
    maxBlocks: number;
    maxRequests: number;
    minIntervalMs: number;
    maxLogsPerBatch: number;
    maxBytesPerBatch: number;
    safeDistance: number;
  };
}
/** Dry run: read the saved cursor and discovery coverage, read the archive
 * height, fetch exactly one page for the first range and report its shape.
 * Creates no stream, takes no lock and writes nothing. */
export async function planHyperSyncBackfill(
  db: Client,
  client: HyperSyncClient,
  config: HyperSyncBackfillConfig,
): Promise<HyperSyncBackfillPlan> {
  const saved = (
    await db.query(
      "SELECT start_block::text,cursor_block::text,cursor_hash FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1",
      [broadStreamIdentity.key],
    )
  ).rows[0];
  const discovery = (
    await db.query(
      "SELECT cursor_block::text FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1",
      [discoveryV2Identity.key],
    )
  ).rows[0];
  const stream = {
    key: broadStreamIdentity.key,
    exists: !!saved,
    start: saved ? Number(saved.start_block) : broadStreamIdentity.start,
    cursor: saved?.cursor_block == null ? null : Number(saved.cursor_block),
    hash: saved?.cursor_hash ?? null,
  };
  const discoveryCursor =
    discovery?.cursor_block == null ? null : Number(discovery.cursor_block);
  const archiveHeight = await client.height();
  const confirmed = archiveHeight - hypersyncPolicy.safeDistance;
  const from = stream.cursor === null ? stream.start : stream.cursor + 1;
  const cap = Math.min(confirmed, discoveryCursor ?? -1);
  const remainingBlocks = Math.max(0, cap - from + 1);
  const caps = {
    batchBlocks: config.batchBlocks,
    maxPages: config.maxPages,
    maxBatches: config.maxBatches,
    maxBlocks: config.maxBlocks,
    maxRequests: config.maxRequests,
    minIntervalMs: config.minIntervalMs,
    maxLogsPerBatch: broadEventPolicy.maxLogs,
    maxBytesPerBatch: broadEventPolicy.maxBytes,
    safeDistance: hypersyncPolicy.safeDistance,
  };
  if (!remainingBlocks)
    return {
      stream,
      discovery: { key: discoveryV2Identity.key, cursor: discoveryCursor },
      archiveHeight,
      confirmed,
      from,
      cap,
      remainingBlocks,
      firstPage: null,
      estimate: null,
      caps,
    };
  const query = swapLogQuery({
    fromBlock: from,
    toBlock: Math.min(cap, from + config.batchBlocks - 1),
  });
  const page = await client.query(query);
  const blocksCovered = page.nextBlock - from;
  const density = blocksCovered > 0 ? page.logs.length / blocksCovered : null;
  const managerSwaps =
    density === null ? null : Math.round(density * remainingBlocks);
  const pages =
    managerSwaps === null
      ? null
      : Math.ceil(managerSwaps / hypersyncPolicy.maxLogsPerPage);
  const batches =
    managerSwaps === null
      ? null
      : Math.max(
          Math.ceil(managerSwaps / broadEventPolicy.maxLogs),
          Math.ceil(remainingBlocks / config.batchBlocks),
        );
  return {
    stream,
    discovery: { key: discoveryV2Identity.key, cursor: discoveryCursor },
    archiveHeight,
    confirmed,
    from,
    cap,
    remainingBlocks,
    firstPage: {
      query: { from_block: query.from_block, to_block: query.to_block! },
      nextBlock: page.nextBlock,
      blocksCovered,
      logs: page.logs.length,
      transactions: page.transactions.length,
      blocks: page.blocks.length,
      bytes: page.bytes,
      totalExecutionTime: page.totalExecutionTime,
      archiveHeight: page.archiveHeight,
      rollbackGuard: page.rollbackGuard !== null,
      logFields: page.logs[0] ? Object.keys(page.logs[0]) : [],
      transactionFields: page.transactions[0]
        ? Object.keys(page.transactions[0])
        : [],
      blockFields: page.blocks[0] ? Object.keys(page.blocks[0]) : [],
      managerSwapsPerBlock: density,
    },
    estimate:
      managerSwaps === null || pages === null || batches === null
        ? null
        : {
            basis:
              "the first page's manager swaps per block applied to every remaining block; history is denser in launch weeks, so treat this as a floor",
            managerSwaps,
            pages,
            // Every batch also reads the archive height, the from header,
            // the to and registry headers when no page carried them, and the
            // three boundaries again after collection: at most seven reads.
            batches,
            requests: pages + batches * 7,
          },
    caps,
  };
}
/** Fixed descriptions for HyperSync failures; never provider text or a token. */
export function hypersyncSafeError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : "";
  if (name === "HyperSyncUnauthorized")
    return "hypersync_unauthorized: the API token was rejected; check ENVIO_API_TOKEN";
  if (name === "HyperSyncRateLimitExhausted")
    return "hypersync_rate_limit_exhausted: backfill stopped; lower the request rate before resuming";
  if (name === "HyperSyncBudgetExceeded")
    return "hypersync_request_budget_exceeded: the run's request cap was reached; resume later";
  if (name === "HyperSyncResponseCapacity")
    return "hypersync_response_too_large: a page exceeded the byte or row cap";
  if (name === "HyperSyncPageCapacity")
    return "hypersync_block_group_too_large: one page exceeds the broad caps; inspect the range before resuming";
  if (name === "HyperSyncRequestRejected")
    return `hypersync_request_rejected: HTTP ${(e as { status?: number }).status ?? "unknown"}`;
  if (
    /^(HyperSync backfill disabled; set HYPERSYNC_BACKFILL_ENABLED=1|ENVIO_API_TOKEN is required for HyperSync queries)$/.test(
      message,
    )
  )
    return `hypersync_disabled: ${message}`;
  if (
    /^Invalid (HYPERSYNC_[A-Z_]+|ENVIO_API_TOKEN|HyperSync (backfill|batch) options)/.test(
      message,
    )
  )
    return `hypersync_configuration_invalid: ${message}`;
  if (/^HyperSync (returned|page|archive|range|query|request)/.test(message))
    return "hypersync_response_rejected: the provider answer failed validation";
  if (
    /^(Unexpected HyperSync swap source or range|Duplicate HyperSync swap evidence|HyperSync (swap outside|broad|log lacks)|Invalid HyperSync (broad|unregistered)|Inconsistent HyperSync canonical headers)/.test(
      message,
    )
  )
    return "hypersync_evidence_rejected: inspect the retained rows and the pinned registry before resuming";
  return safeError(e);
}
export { HyperSyncPageCapacity };
