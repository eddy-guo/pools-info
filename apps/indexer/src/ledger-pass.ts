import {
  HyperSyncBudgetExceeded,
  HyperSyncClient,
  HyperSyncPacer,
  HyperSyncRateLimitExhausted,
  Rpc,
  RpcRateLimitExhausted,
  collectLedgerRange,
  hypersyncPolicy,
  ledgerPassPolicy,
  multicallConfig,
  planLedgerRange,
  type HyperSyncRetryEvent,
  type LedgerRangeCollection,
  type MulticallConfig,
} from "@pools/chain";
import {
  applyLedgerBatch,
  commitBatch,
  ensureLedgerLaunchStream,
  ensureLedgerStream,
  getStream,
  ledgerBatchCreatedRows,
  ledgerCheckpoints,
  ledgerLaunchStreamIdentity,
  ledgerRegistry,
  ledgerStream,
  ledgerTotals,
  readLedgerStream,
  rewind,
  setLedgerMode,
  walkBackLedger,
  type Client,
  type LedgerBatch,
  type LedgerStreamState,
  type Stream,
} from "@pools/db";
import { safeError } from "./errors";
import { hypersyncSafeError } from "./hypersync-backfill";

/** The aggregate ledger's one-time history pass (docs/AGGREGATE-LEDGER.md
 * phase 2, design report section 7.1): `pnpm ledger:pass run`. Manual, off
 * by default, never started by the indexer service. One range at a time from
 * the ledger cursor to the confirmed archive height: the range is collected
 * from HyperSync in whole pages (packages/chain/src/hypersync-ledger.ts), its
 * launches commit through the launch stream, then the swaps and transfers
 * fold into the ledger under the writer lock. Each range commits or fails
 * alone, so a stopped pass resumes from its cursor; a replayed range is the
 * writer's content-hash no-op. Name, symbol and decimals are the one JSON-RPC
 * read, over the public RPC through Multicall3, never Alchemy. */
export interface LedgerPassConfig {
  enabled: boolean;
  url: string;
  token: string | null;
  rpcUrl: string;
  rangeBlocks: number;
  minIntervalMs: number;
  maxPages: number;
  maxRequests: number;
  /** Ranges per run; null runs to the confirmed cutoff. */
  maxRanges: number | null;
  /** A quiet range (one page per lane query) doubles the next range up to
   * this; a cut range resets it to rangeBlocks. Equal to rangeBlocks keeps
   * every range at the base size. */
  maxRangeBlocks: number;
}
export const ledgerPassDefaults = Object.freeze({
  /** 30 requests per minute: the free tier's measured sustained rate with
   * zero 429s (report section 3); also the floor. */
  minIntervalMs: 2000,
  maxRequests: 100000,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
});
function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`);
  return n;
}
export function ledgerPassConfig(
  env: NodeJS.ProcessEnv = process.env,
): LedgerPassConfig {
  const flag = env.LEDGER_PASS_ENABLED;
  if (flag !== undefined && flag !== "0" && flag !== "1")
    throw Error("Invalid LEDGER_PASS_ENABLED; expected 0 or 1");
  const token = env.ENVIO_API_TOKEN?.trim();
  const rpcUrl = env.ROBINHOOD_RPC_URL?.trim() || ledgerPassDefaults.rpcUrl;
  let host: string;
  try {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw Error();
    host = url.hostname;
  } catch {
    throw Error("Invalid ROBINHOOD_RPC_URL");
  }
  if (/alchemy/i.test(host))
    throw Error(
      "ROBINHOOD_RPC_URL must be the public RPC; the ledger pass never reads Alchemy",
    );
  return {
    enabled: flag === "1",
    url: env.HYPERSYNC_URL ?? hypersyncPolicy.defaultUrl,
    token: token ? token : null,
    rpcUrl,
    rangeBlocks: integer(
      env,
      "LEDGER_PASS_RANGE_BLOCKS",
      ledgerPassPolicy.rangeBlocks,
      1,
      ledgerPassPolicy.maxRangeBlocks,
    ),
    minIntervalMs: integer(
      env,
      "LEDGER_PASS_MIN_INTERVAL_MS",
      ledgerPassDefaults.minIntervalMs,
      ledgerPassDefaults.minIntervalMs,
      60000,
    ),
    maxPages: integer(
      env,
      "LEDGER_PASS_MAX_PAGES",
      ledgerPassPolicy.maxPages,
      1,
      ledgerPassPolicy.maxPages,
    ),
    maxRequests: integer(
      env,
      "LEDGER_PASS_MAX_REQUESTS",
      ledgerPassDefaults.maxRequests,
      1,
      10000000,
    ),
    maxRanges:
      env.LEDGER_PASS_MAX_RANGES === undefined
        ? null
        : integer(env, "LEDGER_PASS_MAX_RANGES", 1, 1, 1000000),
    maxRangeBlocks: integer(
      env,
      "LEDGER_PASS_MAX_RANGE_BLOCKS",
      ledgerPassPolicy.maxRangeBlocks,
      integer(
        env,
        "LEDGER_PASS_RANGE_BLOCKS",
        ledgerPassPolicy.rangeBlocks,
        1,
        ledgerPassPolicy.maxRangeBlocks,
      ),
      ledgerPassPolicy.maxRangeBlocks,
    ),
  };
}
/** Both gates are required before any authenticated request is built. */
export function assertLedgerPassAllowed(config: LedgerPassConfig) {
  if (!config.enabled)
    throw Error("Ledger pass disabled; set LEDGER_PASS_ENABLED=1");
  if (config.token === null)
    throw Error("ENVIO_API_TOKEN is required for the ledger pass");
}
export function createLedgerPassClient(
  config: LedgerPassConfig,
  options: {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    onRetry?: (event: HyperSyncRetryEvent) => void;
    pacer?: HyperSyncPacer;
  } = {},
) {
  assertLedgerPassAllowed(config);
  return new HyperSyncClient({
    url: config.url,
    token: config.token,
    fetch: options.fetch,
    signal: options.signal,
    pacer: options.pacer,
    maxRequests: config.maxRequests,
    minIntervalMs: config.minIntervalMs,
    onRetry: options.onRetry,
  });
}
/** One JSON-RPC transport per range: the class carries a lifetime budget and
 * the Multicall3 fallback is sticky per instance. */
export function createLedgerPassRpc(
  config: LedgerPassConfig,
  signal?: AbortSignal,
) {
  return new Rpc(config.rpcUrl, {
    timeoutMs: 600000,
    maxRequests: 5000,
    minIntervalMs: 250,
    maxBatchSize: 4,
  }).withAbortSignal(signal);
}

type Log = (event: Record<string, unknown>) => void;
const quiet: Log = () => {};
async function canonicalHash(client: HyperSyncClient, n: number) {
  return (await client.header(n)).hash.toLowerCase();
}
/** Reconcile before extending (report 7.1 step 2): the saved cursor's hash is
 * read from HyperSync; on a mismatch the ledger walks back to the newest
 * checkpoint still canonical. Then the launch stream is brought into lockstep:
 * a stop between a range's launch commit and its ledger commit leaves it one
 * range ahead, and it is rewound to the ledger cursor. */
export async function reconcileLedgerPass(
  db: Client,
  client: HyperSyncClient,
  log: Log = quiet,
): Promise<{ ledger: LedgerStreamState; launches: Stream }> {
  let ledger = await ensureLedgerStream(db, "pass");
  let launches = await ensureLedgerLaunchStream(db);
  if (ledger.cursor !== null) {
    const canonical = await canonicalHash(client, ledger.cursor);
    if (canonical !== ledger.hash) {
      let ancestor: number | null = null;
      for (const checkpoint of await ledgerCheckpoints(db))
        if ((await canonicalHash(client, checkpoint.to)) === checkpoint.hash) {
          ancestor = checkpoint.to;
          break;
        }
      const removed = await walkBackLedger(db, ancestor);
      log({
        event: "ledger_walk_back",
        from: ledger.cursor,
        to: ancestor,
        removed: removed.removed.length,
      });
      ledger = await readLedgerStream(db);
    }
  }
  if (launches.cursor !== ledger.cursor || launches.hash !== ledger.hash) {
    const ahead =
      launches.cursor !== null &&
      (ledger.cursor === null || launches.cursor > ledger.cursor);
    if (!ahead) throw Error("ledger_pass_streams_diverged");
    await rewind(db, launches, ledger.cursor);
    log({
      event: "ledger_launch_rewind",
      from: launches.cursor,
      to: ledger.cursor,
    });
    launches = await getStream(db, ledgerLaunchStreamIdentity.key);
    if (launches.cursor !== ledger.cursor || launches.hash !== ledger.hash)
      throw Error("ledger_pass_streams_diverged");
  }
  return { ledger, launches };
}
export interface LedgerRangeProgress {
  idle: false;
  from: number;
  to: number;
  blocks: number;
  launches: number;
  swaps: number;
  unsupportedSwaps: number;
  transfers: number;
  attributed: number;
  unattributed: number;
  unregisteredSwaps: number;
  positionsChanged: number;
  newPositions: number;
  newWallets: number;
  registryPools: number;
  pages: number;
  requests: number;
  bytes: number;
  elapsedMs: number;
  archiveHeight: number;
  /** The writer found the range already committed with the same content. */
  replayed: boolean;
  /** The planned range size, and whether a lane ended the range early. */
  rangeBlocks: number;
  cut: boolean;
  /** Every lane query answered in one page: the next range may grow. */
  singlePage: boolean;
}
export interface LedgerRangeOptions {
  rangeBlocks: number;
  maxPages: number;
  height: number;
  rpc: () => Rpc;
  multicall?: MulticallConfig;
  signal?: AbortSignal;
}
const pageCount = (c: LedgerRangeCollection) =>
  c.pages.launch.length +
  c.pages.swaps.reduce((n, p) => n + p.length, 0) +
  c.pages.transfers.reduce((n, p) => n + p.length, 0) +
  c.pages.headers.length;
/** The ledger batch of one collected range (report 7.1 step 7). */
export function ledgerBatchOf(collection: LedgerRangeCollection): LedgerBatch {
  return {
    from: collection.fromBlock,
    to: collection.toBlock,
    parentHash: collection.parentHash,
    hash: collection.blockHash,
    timestamp: collection.toTimestamp,
    archiveHeight: collection.archiveHeight,
    registryPools: collection.registryPools,
    query: collection.query,
    pages: collection.pages,
    requests: collection.requests,
    bytes: collection.bytes,
    launches: collection.launch.pools.map((p) => ({
      poolId: p.id,
      token: p.token,
      block: p.launchBlock,
      blockHash: p.launchBlockHash,
      txHash: p.launchTx,
      logIndex: p.launchLogIndex,
    })),
    swaps: collection.swaps,
    transfers: collection.transfers,
  };
}
/** One range: plan, collect, commit the launches, apply the ledger batch.
 * Idle once the cursor reaches the confirmed cutoff of `height`. */
export async function runLedgerRange(
  db: Client,
  client: HyperSyncClient,
  options: LedgerRangeOptions,
): Promise<LedgerRangeProgress | { idle: true; from: number }> {
  const started = performance.now();
  const ledger = await readLedgerStream(db);
  const launches = await getStream(db, ledgerLaunchStreamIdentity.key);
  if (launches.cursor !== ledger.cursor || launches.hash !== ledger.hash)
    throw Error("ledger_pass_streams_diverged");
  const range = planLedgerRange({
    cursor: ledger.cursor,
    start: ledger.start,
    height: options.height,
    rangeBlocks: options.rangeBlocks,
  });
  if (!range)
    return {
      idle: true,
      from: ledger.cursor === null ? ledger.start : ledger.cursor + 1,
    };
  options.signal?.throwIfAborted();
  const registry = await ledgerRegistry(db, range.fromBlock - 1);
  const collection = await collectLedgerRange(client, options.rpc(), {
    ...range,
    parentHash: ledger.hash,
    height: options.height,
    registry,
    maxPages: options.maxPages,
    multicall: options.multicall ?? multicallConfig(),
  });
  options.signal?.throwIfAborted();
  // The launches first, so the ledger finds every pool a swap names.
  await commitBatch(db, launches, {
    from: collection.fromBlock,
    to: collection.toBlock,
    hash: collection.blockHash,
    evidence: collection.launch.evidence,
    pools: collection.launch.pools.map((p) => ({
      id: p.id,
      token: p.token,
      name: p.name,
      symbol: p.symbol,
      launchBlock: p.launchBlock,
      launchTx: p.launchTx,
      launchSender: p.launchSender,
      launchedAt: p.launchedAt,
      ...(p.imageUrl === undefined ? {} : { imageUrl: p.imageUrl }),
      ...(p.description === undefined ? {} : { description: p.description }),
      ...(p.externalUrl === undefined ? {} : { externalUrl: p.externalUrl }),
      decimals: p.decimals,
    })),
  });
  const applied = await applyLedgerBatch(db, ledgerBatchOf(collection));
  const created = applied.changed
    ? await ledgerBatchCreatedRows(db, collection.toBlock)
    : { positions: 0, wallets: 0 };
  return {
    idle: false,
    from: collection.fromBlock,
    to: collection.toBlock,
    blocks: collection.toBlock - collection.fromBlock + 1,
    launches: collection.launch.pools.length,
    swaps: collection.swaps.length,
    unsupportedSwaps: collection.unsupportedSwaps,
    transfers: collection.transfers.length,
    attributed: applied.attributed,
    unattributed: applied.unattributed,
    unregisteredSwaps: applied.unregisteredSwaps,
    positionsChanged: applied.positions,
    newPositions: created.positions,
    newWallets: created.wallets,
    registryPools: collection.registryPools,
    pages: pageCount(collection),
    requests: collection.requests,
    bytes: collection.bytes,
    elapsedMs: Math.round(performance.now() - started),
    archiveHeight: collection.archiveHeight,
    replayed: !applied.changed,
    rangeBlocks: options.rangeBlocks,
    cut: collection.toBlock < range.toBlock,
    singlePage:
      collection.pages.launch.length === 1 &&
      collection.pages.swaps.every((p) => p.length === 1) &&
      collection.pages.transfers.every((p) => p.length === 1),
  };
}
/** The operational counters the projections are checked against (report
 * sections 3.6 and 5): per range, cumulative over the whole ledger, and per
 * million blocks of history. Pure; the caller logs what it returns. */
export class LedgerPassProgress {
  private readonly startedAt: number;
  private run = {
    ranges: 0,
    blocks: 0,
    launches: 0,
    swaps: 0,
    transfers: 0,
    requests: 0,
    bytes: 0,
  };
  private million: null | {
    index: number;
    partial: boolean;
    blocks: number;
    launches: number;
    swaps: number;
    transfers: number;
    requests: number;
    bytes: number;
    startedAt: number;
  } = null;
  constructor(
    private total: {
      positions: number;
      wallets: number;
      batches: number;
      swaps: number;
      transfers: number;
      launches: number;
      requests: number;
      bytes: number;
    },
    private readonly start: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = this.now();
  }
  get totals() {
    return { ...this.total };
  }
  observe(
    p: LedgerRangeProgress,
    context: { safeTo: number; throttled: number },
  ): { progress: Record<string, unknown>; million: Record<string, unknown>[] } {
    const r = this.run,
      t = this.total;
    r.ranges++;
    r.blocks += p.blocks;
    r.launches += p.launches;
    r.swaps += p.swaps;
    r.transfers += p.transfers;
    r.requests += p.requests;
    r.bytes += p.bytes;
    if (!p.replayed) {
      t.batches++;
      t.launches += p.launches;
      t.swaps += p.swaps;
      t.transfers += p.transfers;
      t.requests += p.requests;
      t.bytes += p.bytes;
      t.positions += p.newPositions;
      t.wallets += p.newWallets;
    }
    const elapsedMs = Math.round(this.now() - this.startedAt);
    const blocksPerSecond = elapsedMs > 0 ? r.blocks / (elapsedMs / 1000) : 0;
    const remainingBlocks = Math.max(0, context.safeTo - p.to);
    const historyBlocks = p.to - this.start + 1;
    const ratio = (a: number, b: number, digits = 4) =>
      b > 0 ? Number((a / b).toFixed(digits)) : null;
    // Per-million milestones: the blocks of history since the start block.
    const million: Record<string, unknown>[] = [];
    const before = Math.floor((p.from - this.start) / 1e6),
      after = Math.floor(historyBlocks / 1e6);
    if (!this.million)
      this.million = {
        index: before,
        partial: p.from - this.start !== before * 1e6,
        blocks: 0,
        launches: 0,
        swaps: 0,
        transfers: 0,
        requests: 0,
        bytes: 0,
        startedAt: this.now(),
      };
    const m = this.million;
    m.blocks += p.blocks;
    m.launches += p.launches;
    m.swaps += p.swaps;
    m.transfers += p.transfers;
    m.requests += p.requests;
    m.bytes += p.bytes;
    if (after > m.index) {
      million.push({
        event: "ledger_million",
        million: m.index,
        fromBlock: this.start + m.index * 1e6,
        partial: m.partial,
        blocks: m.blocks,
        launches: m.launches,
        swaps: m.swaps,
        transfers: m.transfers,
        requests: m.requests,
        bytes: m.bytes,
        elapsedMs: Math.round(this.now() - m.startedAt),
        swapsPerBlock: ratio(m.swaps, m.blocks),
        requestsPerMillionBlocks: ratio(m.requests * 1e6, m.blocks, 0),
        pairsPerSwapSoFar: ratio(t.positions, t.swaps),
      });
      this.million = {
        index: after,
        partial: false,
        blocks: 0,
        launches: 0,
        swaps: 0,
        transfers: 0,
        requests: 0,
        bytes: 0,
        startedAt: this.now(),
      };
    }
    const progress = {
      event: "ledger_progress",
      from: p.from,
      to: p.to,
      blocks: p.blocks,
      rangeBlocks: p.rangeBlocks,
      cut: p.cut,
      singlePage: p.singlePage,
      launches: p.launches,
      swaps: p.swaps,
      unsupportedSwaps: p.unsupportedSwaps,
      transfers: p.transfers,
      attributed: p.attributed,
      unattributed: p.unattributed,
      unregisteredSwaps: p.unregisteredSwaps,
      positionsChanged: p.positionsChanged,
      newPositions: p.newPositions,
      newWallets: p.newWallets,
      registryPools: p.registryPools,
      pages: p.pages,
      requests: p.requests,
      bytes: p.bytes,
      elapsedMs: p.elapsedMs,
      replayed: p.replayed,
      archiveHeight: p.archiveHeight,
      safeTo: context.safeTo,
      remainingBlocks,
      run: {
        ...r,
        throttled: context.throttled,
        elapsedMs,
        blocksPerSecond: Math.round(blocksPerSecond),
        requestsPerMillionBlocks: ratio(r.requests * 1e6, r.blocks, 0),
        etaSeconds:
          blocksPerSecond > 0
            ? Math.ceil(remainingBlocks / blocksPerSecond)
            : null,
      },
      total: {
        ...t,
        historyBlocks,
        swapsPerBlock: ratio(t.swaps, historyBlocks),
        pairsPerSwap: ratio(t.positions, t.swaps),
        requestsPerMillionBlocks: ratio(t.requests * 1e6, historyBlocks, 0),
        bytesPerSwap: ratio(t.bytes, t.swaps, 0),
      },
    };
    return { progress, million };
  }
}
export interface LedgerPassOptions {
  rangeBlocks: number;
  /** Growth ceiling for quiet ranges; unset is the policy's, equal to
   * rangeBlocks disables growth. */
  maxRangeBlocks?: number;
  /** Hand over once a fresh height leaves a gap this small; unset is the
   * policy's. */
  catchUpMargin?: number;
  maxPages: number;
  rpc: () => Rpc;
  multicall?: MulticallConfig;
  signal?: AbortSignal;
  log?: Log;
  /** Ranges per run; unset runs to the confirmed cutoff. */
  maxRanges?: number;
  /** Throttled retries seen by the client's onRetry, read per range. */
  throttled?: () => number;
}
export interface LedgerPassSummary {
  stopped:
    "complete" | "handed_over" | "aborted" | "throttled" | "budget" | "ranges";
  ranges: number;
  blocks: number;
  launches: number;
  swaps: number;
  transfers: number;
  requests: number;
  bytes: number;
  throttled: number;
  elapsedMs: number;
  from: number | null;
  through: number | null;
  archiveHeight: number | null;
  total: LedgerPassProgress["totals"] & {
    pairsPerSwap: number | null;
    swapsPerBlock: number | null;
    requestsPerMillionBlocks: number | null;
  };
  error: string | null;
}
/** Run ranges until the confirmed cutoff (then hand over to the tip loop by
 * setting mode 'tip'), a cap, an abort, a throttle stop or a request budget.
 * A sustained throttle (`HyperSyncRateLimitExhausted`) ends the run with
 * `stopped: "throttled"`; the command exits with the reserved code and nothing
 * restarts it. */
export async function runLedgerPass(
  db: Client,
  client: HyperSyncClient,
  options: LedgerPassOptions,
): Promise<LedgerPassSummary> {
  const log = options.log ?? quiet;
  const throttled = options.throttled ?? (() => 0);
  const started = performance.now();
  const summary: LedgerPassSummary = {
    stopped: "complete",
    ranges: 0,
    blocks: 0,
    launches: 0,
    swaps: 0,
    transfers: 0,
    requests: 0,
    bytes: 0,
    throttled: 0,
    elapsedMs: 0,
    from: null,
    through: null,
    archiveHeight: null,
    total: {
      positions: 0,
      wallets: 0,
      batches: 0,
      swaps: 0,
      transfers: 0,
      launches: 0,
      requests: 0,
      bytes: 0,
      pairsPerSwap: null,
      swapsPerBlock: null,
      requestsPerMillionBlocks: null,
    },
    error: null,
  };
  const finish = (progress: LedgerPassProgress | null) => {
    summary.elapsedMs = Math.round(performance.now() - started);
    summary.throttled = throttled();
    if (progress) {
      const t = progress.totals;
      const history =
        summary.through === null ? 0 : summary.through - ledgerStream.start + 1;
      summary.total = {
        ...t,
        pairsPerSwap:
          t.swaps > 0 ? Number((t.positions / t.swaps).toFixed(4)) : null,
        swapsPerBlock:
          history > 0 ? Number((t.swaps / history).toFixed(4)) : null,
        requestsPerMillionBlocks:
          history > 0 ? Math.round((t.requests * 1e6) / history) : null,
      };
    }
    return summary;
  };
  const initial = await ensureLedgerStream(db, "pass");
  if (initial.mode === "tip") {
    summary.stopped = "handed_over";
    log({
      event: "ledger_pass_handed_over",
      cursor: initial.cursor,
      mode: initial.mode,
    });
    return finish(null);
  }
  const maxRangeBlocks =
    options.maxRangeBlocks ?? ledgerPassPolicy.maxRangeBlocks;
  const catchUpMargin =
    options.catchUpMargin ?? ledgerPassPolicy.catchUpMargin;
  if (
    !Number.isSafeInteger(options.rangeBlocks) ||
    options.rangeBlocks < 1 ||
    !Number.isSafeInteger(maxRangeBlocks) ||
    maxRangeBlocks < options.rangeBlocks ||
    maxRangeBlocks > ledgerPassPolicy.maxRangeBlocks
  )
    throw Error("Invalid LEDGER_PASS_MAX_RANGE_BLOCKS");
  let rangeBlocks = options.rangeBlocks;
  const { ledger } = await reconcileLedgerPass(db, client, log);
  let height = await client.height();
  const progress = new LedgerPassProgress(await ledgerTotals(db), ledger.start);
  summary.archiveHeight = height;
  log({
    event: "ledger_pass_started",
    cursor: ledger.cursor,
    start: ledger.start,
    archiveHeight: height,
    safeTo: height - hypersyncPolicy.safeDistance,
    rangeBlocks: options.rangeBlocks,
    maxRangeBlocks,
    maxPages: options.maxPages,
    total: progress.totals,
  });
  for (;;) {
    if (options.signal?.aborted) {
      summary.stopped = "aborted";
      break;
    }
    if (
      options.maxRanges !== undefined &&
      summary.ranges >= options.maxRanges
    ) {
      summary.stopped = "ranges";
      break;
    }
    let result: Awaited<ReturnType<typeof runLedgerRange>>;
    try {
      result = await runLedgerRange(db, client, {
        rangeBlocks,
        maxPages: options.maxPages,
        height,
        rpc: options.rpc,
        multicall: options.multicall,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        summary.stopped = "aborted";
        break;
      }
      if (
        error instanceof HyperSyncRateLimitExhausted ||
        error instanceof RpcRateLimitExhausted
      ) {
        summary.stopped = "throttled";
        summary.error = ledgerPassSafeError(error);
        log({
          event: "ledger_pass_throttled",
          error: summary.error,
          through: summary.through,
        });
        break;
      }
      if (error instanceof HyperSyncBudgetExceeded) {
        summary.stopped = "budget";
        summary.error = ledgerPassSafeError(error);
        log({ event: "ledger_pass_budget", error: summary.error });
        break;
      }
      throw error;
    }
    if (result.idle) {
      // The archive may have grown during the run: one more read decides
      // whether a real backlog remains before the pass hands over. The chain
      // never stops producing blocks, so waiting for an exact zero gap would
      // never exit; a gap still at or above the margin is a backlog worth
      // another pass, a gap under it is close enough to the tip to hand over.
      const fresh = await client.height();
      const freshSafeTo = fresh - hypersyncPolicy.safeDistance;
      if (fresh > height && freshSafeTo - result.from >= catchUpMargin) {
        height = fresh;
        summary.archiveHeight = height;
        continue;
      }
      await setLedgerMode(db, "tip");
      summary.stopped = "complete";
      log({
        event: "ledger_pass_complete",
        cursor: result.from - 1,
        archiveHeight: fresh,
        safeTo: freshSafeTo,
      });
      break;
    }
    summary.ranges++;
    summary.blocks += result.blocks;
    summary.launches += result.launches;
    summary.swaps += result.swaps;
    summary.transfers += result.transfers;
    summary.requests += result.requests;
    summary.bytes += result.bytes;
    summary.from ??= result.from;
    summary.through = result.to;
    summary.archiveHeight = result.archiveHeight;
    // Quiet history grows the range; a cut resets it to the base size.
    rangeBlocks = result.cut
      ? options.rangeBlocks
      : result.singlePage
        ? Math.min(maxRangeBlocks, rangeBlocks * 2)
        : rangeBlocks;
    const observed = progress.observe(result, {
      safeTo: height - hypersyncPolicy.safeDistance,
      throttled: throttled(),
    });
    log(observed.progress);
    for (const m of observed.million) log(m);
  }
  return finish(progress);
}
export interface LedgerCalibration {
  fromBlock: number;
  toBlock: number;
  registryPools: number;
  launches: number;
  swaps: number;
  unsupportedSwaps: number;
  transactions: number;
  /** Distinct (pool, initiator) pairs, the report's "pairs". */
  pairs: number;
  wallets: number;
  pools: number;
  transfers: number;
  transfersInSwapTransactions: number;
  transfersOutside: number;
  requests: number;
  bytes: number;
  archiveHeight: number;
}
/** Collect one range exactly as the pass would and count what it holds,
 * writing nothing: the check against the report's section 3.3 ranges. The
 * registry is the catalog as of the range end, so the pass must have passed
 * `toBlock` for the count to be the report's. */
export async function calibrateLedgerRange(
  db: Client,
  client: HyperSyncClient,
  rpc: Rpc,
  range: { fromBlock: number; toBlock: number },
  maxPages: number = ledgerPassPolicy.maxPages,
): Promise<LedgerCalibration> {
  const height = await client.height();
  const registry = await ledgerRegistry(db, range.fromBlock - 1);
  const c = await collectLedgerRange(client, rpc, {
    ...range,
    parentHash: null,
    height,
    registry,
    maxPages,
  });
  const swapTx = new Set(c.swaps.map((s) => s.txHash));
  const inSwap = c.transfers.filter((t) => swapTx.has(t.txHash)).length;
  return {
    fromBlock: c.fromBlock,
    toBlock: c.toBlock,
    registryPools: c.registryPools,
    launches: c.launch.pools.length,
    swaps: c.swaps.length,
    unsupportedSwaps: c.unsupportedSwaps,
    transactions: swapTx.size,
    pairs: new Set(c.swaps.map((s) => `${s.poolId}:${s.initiator}`)).size,
    wallets: new Set(c.swaps.map((s) => s.initiator)).size,
    pools: new Set(c.swaps.map((s) => s.poolId)).size,
    transfers: c.transfers.length,
    transfersInSwapTransactions: inSwap,
    transfersOutside: c.transfers.length - inSwap,
    requests: c.requests,
    bytes: c.bytes,
    archiveHeight: c.archiveHeight,
  };
}
export async function ledgerPassStatus(db: Client) {
  const ledger = await ensureLedgerStream(db, "pass");
  const launches = await ensureLedgerLaunchStream(db);
  return {
    ledger,
    launches: { cursor: launches.cursor, hash: launches.hash },
    total: await ledgerTotals(db),
  };
}
/** Fixed descriptions for the pass's failures; never provider text or a token. */
export function ledgerPassSafeError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : "";
  if (name === "RpcRateLimitExhausted")
    return "rpc_rate_limit_exhausted: the public RPC throttled the metadata reads; lower the request rate before resuming";
  if (name === "RpcCallError")
    return "rpc_call_failed: the public RPC answered a metadata read with an error";
  if (name === "HyperSyncRateLimitExhausted")
    return "hypersync_rate_limit_exhausted: the pass stopped; lower the request rate before resuming";
  if (name === "HyperSyncBudgetExceeded")
    return "hypersync_request_budget_exceeded: the run's request cap was reached; resume later";
  if (
    /^(Ledger pass disabled; set LEDGER_PASS_ENABLED=1|ENVIO_API_TOKEN is required for the ledger pass)$/.test(
      message,
    )
  )
    return `ledger_pass_disabled: ${message}`;
  if (
    /^(Invalid (LEDGER_PASS_[A-Z_]+|ROBINHOOD_RPC_URL)|ROBINHOOD_RPC_URL must be the public RPC)/.test(
      message,
    )
  )
    return `ledger_pass_configuration_invalid: ${message}`;
  if (/^ledger_[a-z_]+$/.test(message)) return message;
  if (/^(Wrong chain|Invalid chain head)$/.test(message))
    return "rpc_endpoint_rejected: the JSON-RPC endpoint is not chain 4663";
  if (
    /^((Invalid|Unexpected|Duplicate|Inconsistent) (HyperSync )?(ledger|launch|catalog)|HyperSync (ledger|swap outside|transfer outside|log lacks|returned)|Unverified catalog|Launch precedes|Ledger (swap|range))/.test(
      message,
    )
  )
    return "ledger_evidence_rejected: HyperSync rows failed validation; inspect the range before resuming";
  if (
    /^(Conflicting (replay|launch)|Stale checkpoint|Discovery batch)/.test(
      message,
    )
  )
    return "ledger_catalog_conflict: the launch stream refused the range; inspect the catalog before resuming";
  return hypersyncSafeError(e) === safeError(e)
    ? safeError(e)
    : hypersyncSafeError(e);
}
