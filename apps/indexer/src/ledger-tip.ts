import { setTimeout as sleep } from "node:timers/promises";
import { databaseIdentitySql, type DatabaseWarmth } from "@pools/api/warmup";
import {
  HyperSyncBudgetExceeded,
  HyperSyncClient,
  HyperSyncPacer,
  HyperSyncPageCapacity,
  HyperSyncRateLimitExhausted,
  HyperSyncUnauthorized,
  Rpc,
  RpcRateLimitExhausted,
  blockTimestamp,
  hypersyncPolicy,
  type HyperSyncRetryEvent,
  type MulticallConfig,
} from "@pools/chain";
import {
  observeLedgerHead,
  readLedgerStream,
  refreshLedgerWindows,
  setLedgerMode,
  type Client,
  type LedgerWindowsRefreshed,
} from "@pools/db";
import {
  integer,
  ledgerPassSafeError,
  ledgerRpcUrl,
  reconcileLedgerPass,
  runLedgerRange,
  type LedgerRangeProgress,
} from "./ledger-pass";
import {
  ledgerCrowdDefaults,
  runLedgerCrowdStep,
  type LedgerCrowdStep,
} from "./ledger-crowd";
import { errorDetails } from "./errors";
import {
  BROAD_CAPACITY_EXIT_CODE,
  HYPERSYNC_UNAUTHORIZED_EXIT_CODE,
  LEDGER_INSPECTION_EXIT_CODE,
} from "./supervisor";

/** The aggregate ledger's tip loop (docs/AGGREGATE-LEDGER.md phase 3, design
 * report section 7.3): `pnpm ledger:tip run`. It extends the history pass's
 * ledger and never starts one. Each cycle is PR 35's order over the pass's
 * lanes: the archive height and the head header, the saved cursor reconciled
 * against HyperSync (walking the journal back after a reorg), one range from
 * the cursor to at most `height - 128` collected and committed exactly as the
 * pass commits it (the launches with name, symbol, decimals and total supply,
 * then the swaps and transfers folded under the writer lock), then the
 * crowd lane (ledger-crowd.ts) brought level with the new cursor within its
 * time budget, then the leaderboard windows refreshed when due. At the
 * confirmed tip, with the crowd lane level, it waits
 * `pollMs` between cycles; behind it, cycles run back to back and quiet ranges
 * grow. HyperSync paces at one request per 2 s or slower, and the only
 * JSON-RPC read is a new launch's contract state over the public RPC. */
export interface LedgerTipConfig {
  enabled: boolean;
  url: string;
  token: string | null;
  rpcUrl: string;
  rangeBlocks: number;
  maxRangeBlocks: number;
  minIntervalMs: number;
  maxPages: number;
  maxRequestsPerCycle: number;
  pollMs: number;
  windowRefreshMs: number;
  /** Disable the crowd lane to preserve the shared free-tier token for the main ledger. */
  crowdEnabled: boolean;
  /** How long the loop may go without a committed cycle before its
   * `/health` answers 503 (`LEDGER_STALE_MS`, shared with the api). */
  staleMs: number;
  /** The health listener's port: Railway's `PORT`. */
  healthPort: number;
}
export const ledgerTipDefaults = Object.freeze({
  /** Blocks per range; a range that completes whole doubles the next one up
   * to maxRangeBlocks while the loop is behind, and a range a lane cut short
   * sets the next to what it covered. */
  rangeBlocks: 2000,
  maxRangeBlocks: 100000,
  /** 30 requests per minute: the free tier's measured sustained rate with
   * zero 429s, and the floor. */
  minIntervalMs: 2000,
  maxPages: 16,
  /** Height, head header, a reorg's walk over at most 257 checkpoints, and a
   * range of 16 pages on each lane query. */
  maxRequestsPerCycle: 400,
  /** Wait at the confirmed tip. A tip cycle is about ten requests, so a
   * minute's wait keeps the loop near 7 requests per minute. */
  pollMs: 60000,
  windowRefreshMs: 60000,
  /** A catching-up crowd lane gets about as long as the loop's poll wait,
   * so the main stream's lag stays under two minutes. */
  crowdBudgetMs: 60000,
  /** A failed cycle waits this long before the next, doubling up to the
   * cap; this many failures in a row (about an hour of paced attempts) exit
   * 1 for a restart from the cursor, so an upstream outage spends the
   * service's restart budget once an hour rather than once a minute. */
  failureWaitMs: 2000,
  maxFailureWaitMs: 60000,
  maxFailures: 60,
  /** A throttle (four throttled attempts on one request) pauses the loop
   * this long, doubling on each consecutive throttle up to the cap, a longer
   * Retry-After winning; once about six hours of consecutive pausing are
   * spent the loop exits 1 for a restart, never 0, which Railway neither
   * restarts nor reports (docs/AGGREGATE-LEDGER.md, "Stops"). */
  throttlePauseMs: 60000,
  maxThrottlePauseMs: 3600000,
  throttleBudgetMs: 21600000,
  /** The service's own connection to the database (the first one, the
   * writer lock, a connection lost mid-run) is retried with waits doubling
   * to the cap for the horizon before the process exits 1 for a restart. */
  connectWaitMs: 1000,
  maxConnectWaitMs: 60000,
  connectHorizonMs: 3600000,
  /** Ten minutes without a committed cycle is six missed production cycles
   * (one every 80 to 90 s); the api's `/health` degrades on the same age. */
  staleMs: 600000,
  /** Beside the api's 3102 when PORT is unset (locally). */
  healthPort: 3103,
});
export function ledgerTipConfig(
  env: NodeJS.ProcessEnv = process.env,
): LedgerTipConfig {
  const flag = env.LEDGER_TIP_ENABLED;
  if (flag !== undefined && flag !== "0" && flag !== "1")
    throw Error("Invalid LEDGER_TIP_ENABLED; expected 0 or 1");
  const token = env.ENVIO_API_TOKEN?.trim();
  const url = env.HYPERSYNC_URL ?? hypersyncPolicy.defaultUrl;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw Error("Invalid HYPERSYNC_URL");
  }
  // Another chain's endpoint answers without error; only the checkpoints
  // would disagree, much later.
  if (
    hostname !== "4663.hypersync.xyz" &&
    hostname !== "127.0.0.1" &&
    hostname !== "localhost"
  )
    throw Error("HYPERSYNC_URL must be chain 4663's HyperSync endpoint");
  const crowd = env.LEDGER_CROWD_ENABLED;
  if (crowd !== undefined && crowd !== "0" && crowd !== "1")
    throw Error("Invalid LEDGER_CROWD_ENABLED; expected 0 or 1");
  const rangeBlocks = integer(
    env,
    "LEDGER_TIP_RANGE_BLOCKS",
    ledgerTipDefaults.rangeBlocks,
    1,
    ledgerTipDefaults.maxRangeBlocks,
  );
  return {
    enabled: flag === "1",
    url,
    token: token ? token : null,
    rpcUrl: ledgerRpcUrl(env, "tip loop"),
    rangeBlocks,
    maxRangeBlocks: integer(
      env,
      "LEDGER_TIP_MAX_RANGE_BLOCKS",
      Math.max(rangeBlocks, ledgerTipDefaults.maxRangeBlocks),
      rangeBlocks,
      1000000,
    ),
    minIntervalMs: integer(
      env,
      "LEDGER_TIP_MIN_INTERVAL_MS",
      ledgerTipDefaults.minIntervalMs,
      ledgerTipDefaults.minIntervalMs,
      60000,
    ),
    maxPages: integer(
      env,
      "LEDGER_TIP_MAX_PAGES",
      ledgerTipDefaults.maxPages,
      1,
      ledgerTipDefaults.maxPages,
    ),
    maxRequestsPerCycle: ledgerTipDefaults.maxRequestsPerCycle,
    pollMs: integer(
      env,
      "LEDGER_TIP_POLL_MS",
      ledgerTipDefaults.pollMs,
      1000,
      3600000,
    ),
    windowRefreshMs: integer(
      env,
      "LEDGER_TIP_WINDOW_REFRESH_MS",
      ledgerTipDefaults.windowRefreshMs,
      0,
      3600000,
    ),
    crowdEnabled: crowd !== "0",
    staleMs: integer(
      env,
      "LEDGER_STALE_MS",
      ledgerTipDefaults.staleMs,
      60000,
      86400000,
    ),
    healthPort: integer(env, "PORT", ledgerTipDefaults.healthPort, 1, 65535),
  };
}
/** Both gates are required before any authenticated request is built. */
export function assertLedgerTipAllowed(config: LedgerTipConfig) {
  if (!config.enabled)
    throw Error("Ledger tip loop disabled; set LEDGER_TIP_ENABLED=1");
  if (config.token === null)
    throw Error("ENVIO_API_TOKEN is required for the ledger tip loop");
}
/** One client per cycle, for the cycle's request budget and counters; the
 * pacer is the loop's for its lifetime, so the spacing (and a throttle's
 * wait) holds across cycles. */
export function createLedgerTipClient(
  config: LedgerTipConfig,
  pacer: HyperSyncPacer,
  options: {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    onRetry?: (event: HyperSyncRetryEvent) => void;
  } = {},
) {
  assertLedgerTipAllowed(config);
  return new HyperSyncClient({
    url: config.url,
    token: config.token,
    pacer,
    minIntervalMs: config.minIntervalMs,
    maxRequests: config.maxRequestsPerCycle,
    signal: options.signal,
    fetch: options.fetch,
    onRetry: options.onRetry,
  });
}

type Log = (event: Record<string, unknown>) => void;
const quiet: Log = () => {};

export interface LedgerTipCycle {
  head: number;
  headTimestamp: number;
  cursor: number;
  cursorTimestamp: number;
  /** Blocks and seconds between the head and the committed cursor. */
  lagBlocks: number;
  lagSeconds: number;
  range: LedgerRangeProgress | null;
  /** The cursor reached the confirmed cutoff of this cycle's height. */
  atTip: boolean;
  /** The crowd lane's ranges this cycle; null when it did not run. */
  crowd: LedgerCrowdStep | null;
  windows: LedgerWindowsRefreshed | null;
  requests: number;
  bytes: number;
  /** Request body bytes sent: the upload the host bills. */
  sentBytes: number;
  elapsedMs: number;
}
export interface LedgerTipCycleOptions {
  rangeBlocks: number;
  maxPages: number;
  windowRefreshMs: number;
  /** The crowd lane's step; unset leaves it out of the cycle. */
  crowd?: { rangeBlocks: number; maxRangeBlocks: number; budgetMs: number };
  rpc: () => Rpc;
  multicall?: MulticallConfig;
  signal?: AbortSignal;
  log?: Log;
  /** Called once the cycle's range is planned, before its first request. */
  onRange?: (range: { from: number; to: number }) => void;
}
/** One cycle: head, reconcile, at most one range, windows. Every write is a
 * committed batch or nothing, so the loop can stop at any point of it. */
export async function runLedgerTipCycle(
  db: Client,
  client: HyperSyncClient,
  options: LedgerTipCycleOptions,
): Promise<LedgerTipCycle> {
  const started = performance.now();
  const log = options.log ?? quiet;
  const height = await client.height();
  if (height < hypersyncPolicy.safeDistance) throw Error("Invalid chain head");
  const headTimestamp = blockTimestamp(await client.header(height));
  await observeLedgerHead(db, height, headTimestamp);
  const saved = await readLedgerStream(db);
  if (saved.cursor === null) throw Error("ledger_tip_requires_pass");
  let range: LedgerRangeProgress | null = null;
  // A cursor above the archive height (a lagging HyperSync node) cannot be
  // read back yet; wait until the archive passes it.
  if (saved.cursor <= height) {
    await reconcileLedgerPass(db, client, log);
    options.signal?.throwIfAborted();
    const result = await runLedgerRange(db, client, {
      rangeBlocks: options.rangeBlocks,
      maxPages: options.maxPages,
      height,
      rpc: options.rpc,
      multicall: options.multicall,
      signal: options.signal,
      onRange: options.onRange,
    });
    if (!result.idle) range = result;
  }
  const crowd =
    options.crowd && !options.signal?.aborted
      ? await runLedgerCrowdStep(db, client, {
          ...options.crowd,
          maxPages: options.maxPages,
          height,
          rpc: options.rpc,
          multicall: options.multicall,
          signal: options.signal,
          log,
          safeError: ledgerTipSafeError,
        })
      : null;
  const windows = options.signal?.aborted
    ? null
    : await refreshLedgerWindows(db, {
        minIntervalMs: options.windowRefreshMs,
      });
  const ledger = await readLedgerStream(db);
  return {
    head: height,
    headTimestamp,
    cursor: ledger.cursor!,
    cursorTimestamp: ledger.timestamp!,
    lagBlocks: Math.max(0, height - ledger.cursor!),
    lagSeconds: Math.max(0, headTimestamp - ledger.timestamp!),
    range,
    atTip: ledger.cursor! >= height - hypersyncPolicy.safeDistance,
    crowd,
    windows,
    requests: client.requests,
    bytes: client.bytes,
    sentBytes: client.sentBytes,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** The next range size: a range cut short by a lane sets it to what it
 * covered (never below the base), a range that completed its whole size
 * doubles it up to the ceiling, and a range the confirmed tip ended leaves it. */
export function nextLedgerTipRange(
  range: LedgerRangeProgress | null,
  current: number,
  bounds: { rangeBlocks: number; maxRangeBlocks: number },
) {
  if (!range) return current;
  if (range.cut) return Math.max(bounds.rangeBlocks, range.blocks);
  if (range.blocks >= current)
    return Math.min(bounds.maxRangeBlocks, current * 2);
  return current;
}

export type LedgerTipStop =
  | "aborted"
  | "cycles"
  | "throttled"
  | "unauthorized"
  | "capacity"
  | "inspection"
  | "failed";
/** The service's exit code for each stop: 76 and 77 are the indexer's
 * reserved non-restarting pauses (an indivisible page, a rejected token), 78
 * a ledger that needs an operator's inspection, and 1 a failure a restart may
 * clear, which a throttle whose pause budget is spent is too. Never the
 * reserved 75: the supervisor exits 0 on it, and Railway neither restarts nor
 * reports an exit 0 (docs/AGGREGATE-LEDGER.md, "Stops"). */
export const ledgerTipExitCodes: Record<LedgerTipStop, number> = {
  aborted: 0,
  cycles: 0,
  throttled: 1,
  capacity: BROAD_CAPACITY_EXIT_CODE,
  unauthorized: HYPERSYNC_UNAUTHORIZED_EXIT_CODE,
  inspection: LEDGER_INSPECTION_EXIT_CODE,
  failed: 1,
};
/** Conditions a restart cannot clear: the ledger refuses to change until an
 * operator looks. */
const inspection =
  /^ledger_(walkback_unavailable|batch_conflict|pass_streams_diverged|tip_requires_pass|tip_ledger_incomplete|stream_missing|unknown_ancestor|launch_stream_identity)$/;
/** The loop's progress as `/health` reports it (ledger-tip-health.ts):
 * each committed cycle, each failed one with its back-off, and the stop. */
export interface LedgerTipObserver {
  cycle(cycle: LedgerTipCycle): void;
  failed(event: { failures: number; waitMs: number; error: string }): void;
  stopped(stopped: LedgerTipStop, error: string | null): void;
}
export interface LedgerTipOptions {
  /** Read-only reader warming, allowed only in the idle time between cycles. */
  warmth?: DatabaseWarmth;
  observer?: LedgerTipObserver;
  /** A fresh client per cycle, sharing the loop's pacer. */
  client: () => HyperSyncClient;
  rpc: () => Rpc;
  rangeBlocks: number;
  maxRangeBlocks: number;
  maxPages: number;
  pollMs: number;
  windowRefreshMs: number;
  crowdEnabled?: boolean;
  multicall?: MulticallConfig;
  signal?: AbortSignal;
  log?: Log;
  /** Cycles per run; unset runs until a stop. */
  maxCycles?: number;
  maxFailures?: number;
  /** Throttled retries seen by the clients' onRetry. */
  throttled?: () => number;
  /** Waits between cycles; tests replace it. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface LedgerTipSummary {
  stopped: LedgerTipStop;
  cycles: number;
  ranges: number;
  blocks: number;
  launches: number;
  swaps: number;
  transfers: number;
  requests: number;
  bytes: number;
  sentBytes: number;
  throttled: number;
  failures: number;
  /** Throttle pauses taken and the time they spent. */
  pauses: number;
  pausedMs: number;
  elapsedMs: number;
  from: number | null;
  through: number | null;
  error: string | null;
}
export async function ledgerTipIncomplete(db: Client): Promise<boolean> {
  const result = await db.query(
    `SELECT EXISTS (SELECT 1 FROM agg_batches WHERE chain_id=4663 AND stream_key='ledger:agg:v1' AND attributed>0)
       AND (NOT EXISTS (SELECT 1 FROM agg_positions WHERE chain_id=4663)
         OR NOT EXISTS (SELECT 1 FROM agg_wallet_hours WHERE chain_id=4663)) AS incomplete`,
  );
  return result.rows[0].incomplete === true;
}
async function abortableWait(ms: number, signal?: AbortSignal) {
  await sleep(ms, undefined, { signal }).catch((e) => {
    if (e?.name !== "AbortError") throw e;
  });
}
export interface ConnectWithBackoffOptions {
  /** How long the attempts may go on before the last error is thrown; 0
   * tries once. */
  horizonMs: number;
  waitMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  log?: Log;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
/** Connect to the database, retrying a refused or timed-out connection with
 * waits doubling from a second to a minute for the horizon, so an outage is
 * survived in-process rather than spent on the service's restart budget.
 * Throws the last error once the next wait would end past the horizon, and
 * answers null when the signal ends the wait. A client whose connection
 * failed is discarded. */
export async function connectWithBackoff(
  create: () => Client,
  options: ConnectWithBackoffOptions,
): Promise<Client | null> {
  const log = options.log ?? quiet;
  const wait = options.wait ?? abortableWait;
  const now = options.now ?? (() => performance.now());
  const waitMs = options.waitMs ?? ledgerTipDefaults.connectWaitMs;
  const maxWaitMs = options.maxWaitMs ?? ledgerTipDefaults.maxConnectWaitMs;
  const started = now();
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) return null;
    const db = create();
    try {
      await db.connect();
      return db;
    } catch (error) {
      const elapsedMs = Math.round(now() - started);
      const nextMs = Math.min(maxWaitMs, waitMs * 2 ** (attempt - 1));
      if (elapsedMs + nextMs > options.horizonMs) {
        log({
          event: "ledger_database_connect_exhausted",
          attempts: attempt,
          elapsedMs,
          horizonMs: options.horizonMs,
          ...errorDetails(error),
        });
        throw error;
      }
      log({
        event: "ledger_database_connect_failed",
        attempt,
        waitMs: nextMs,
        elapsedMs,
        horizonMs: options.horizonMs,
        ...errorDetails(error),
      });
      await wait(nextMs, options.signal);
    }
  }
}

const stopReasons = new Set(["SIGTERM", "SIGINT", "database_lost"]);
/** The reason the service gave its abort, one of a fixed few; never free
 * text. */
function abortReason(signal?: AbortSignal) {
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : "";
  return stopReasons.has(message) ? message : "aborted";
}
/** Follow the chain until a stop. The loop takes the stream over from the
 * pass (mode 'tip'); a rejected token, an indivisible page or a ledger that
 * needs inspection stops it for good; a throttle pauses it, with waits
 * doubling from a minute to an hour (a longer Retry-After honoured) until
 * about six hours of consecutive pausing spend the budget and it exits 1 for
 * a restart; and any other failure is retried with backoff up to
 * `maxFailures` cycles in a row. */
export async function runLedgerTip(
  db: Client,
  options: LedgerTipOptions,
): Promise<LedgerTipSummary> {
  const log = options.log ?? quiet;
  const wait = options.wait ?? abortableWait;
  const throttled = options.throttled ?? (() => 0);
  const maxFailures = options.maxFailures ?? ledgerTipDefaults.maxFailures;
  const started = performance.now();
  const summary: LedgerTipSummary = {
    stopped: "aborted",
    cycles: 0,
    ranges: 0,
    blocks: 0,
    launches: 0,
    swaps: 0,
    transfers: 0,
    requests: 0,
    bytes: 0,
    sentBytes: 0,
    throttled: 0,
    failures: 0,
    pauses: 0,
    pausedMs: 0,
    elapsedMs: 0,
    from: null,
    through: null,
    error: null,
  };
  // The range being collected and the cursor the loop started from, for the
  // stop line: a stop (a signal, a lost database connection) is logged at
  // once with what the loop was doing, and the loop then ends on its
  // committed cursor.
  let inFlight: { from: number; to: number } | null = null;
  let startCursor: number | null = null;
  const stopping = () =>
    log({
      event: "ledger_tip_stopping",
      reason: abortReason(options.signal),
      cursor: summary.through ?? startCursor,
      inFlight,
      cycle: summary.cycles + 1,
    });
  const finish = (stopped: LedgerTipStop, error: unknown = null) => {
    options.signal?.removeEventListener("abort", stopping);
    summary.stopped = stopped;
    summary.error = error === null ? null : ledgerTipSafeError(error);
    summary.elapsedMs = Math.round(performance.now() - started);
    summary.throttled = throttled();
    options.observer?.stopped(stopped, summary.error);
    return summary;
  };
  options.signal?.addEventListener("abort", stopping, { once: true });
  if (
    !Number.isSafeInteger(options.rangeBlocks) ||
    options.rangeBlocks < 1 ||
    !Number.isSafeInteger(options.maxRangeBlocks) ||
    options.maxRangeBlocks < options.rangeBlocks ||
    options.maxRangeBlocks > 1000000
  )
    throw Error("Invalid LEDGER_TIP_MAX_RANGE_BLOCKS");
  // Read, never created: a stream row the tip loop wrote into an empty
  // database would hand the pass a stream it refuses to run.
  const stream = await readLedgerStream(db).catch((error) => {
    if (error instanceof Error && error.message === "ledger_stream_missing")
      return null;
    throw error;
  });
  if (stream === null || stream.cursor === null) {
    const error = Error("ledger_tip_requires_pass");
    log({ event: "ledger_tip_refused", error: ledgerTipSafeError(error) });
    return finish("inspection", error);
  }
  // A copy of the ledger restored without its positions or wallet hours
  // would fold new trades into empty positions: sales without their buys.
  if (await ledgerTipIncomplete(db)) {
    const error = Error("ledger_tip_ledger_incomplete");
    log({ event: "ledger_tip_refused", error: ledgerTipSafeError(error) });
    return finish("inspection", error);
  }
  if (stream.mode !== "tip") {
    await setLedgerMode(db, "tip");
    log({ event: "ledger_tip_took_over", cursor: stream.cursor });
  }
  log({
    event: "ledger_tip_started",
    cursor: stream.cursor,
    cursorTimestamp: stream.timestamp,
    rangeBlocks: options.rangeBlocks,
    maxRangeBlocks: options.maxRangeBlocks,
    maxPages: options.maxPages,
    pollMs: options.pollMs,
    windowRefreshMs: options.windowRefreshMs,
  });
  let rangeBlocks = options.rangeBlocks;
  let failures = 0;
  // Consecutive throttle pauses and the time they have spent; a successful
  // cycle resets them.
  let pauses = 0,
    pausedMs = 0;
  // The crowd lane's own range size and failure backoff: a failed step
  // skips the lane for 1, 2, 4 ... cycles while the main stream carries on.
  let crowdRangeBlocks: number = ledgerCrowdDefaults.rangeBlocks;
  let crowdFailures = 0,
    crowdSkip = 0;
  const catchUp = { at: performance.now(), blocks: 0 };
  startCursor = stream.cursor;
  /** The idle wait at the tip and a throttle's pause: reader warming gets
   * the time, and the next cycle cancels it. */
  const rest = async (ms: number) => {
    const idle = new AbortController();
    const abort = () => idle.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) idle.abort();
    const warmth = options.warmth;
    if (warmth)
      void sleep(warmth.delayMs, undefined, { signal: idle.signal }).then(
        () => warmth.refresh(idle.signal),
        () => {}, // The next indexing cycle cancelled the idle timer.
      );
    try {
      await wait(ms, options.signal);
    } finally {
      // This abort destroys an active warm connection immediately. Do not
      // await the warm set: indexing owns the deadline, even mid-statement.
      idle.abort();
      options.signal?.removeEventListener("abort", abort);
    }
    catchUp.at = performance.now();
    catchUp.blocks = 0;
  };
  for (;;) {
    if (options.signal?.aborted) return finish("aborted");
    if (options.maxCycles !== undefined && summary.cycles >= options.maxCycles)
      return finish("cycles");
    const client = options.client();
    let cycle: LedgerTipCycle;
    try {
      options.warmth?.cancel();
      if (options.warmth) {
        const identity = await db.query(databaseIdentitySql);
        options.warmth.observeIdentity(identity.rows[0].identity);
      }
      const crowd =
        options.crowdEnabled && crowdSkip === 0
          ? {
              rangeBlocks: crowdRangeBlocks,
              maxRangeBlocks: ledgerCrowdDefaults.maxRangeBlocks,
              budgetMs: ledgerTipDefaults.crowdBudgetMs,
            }
          : undefined;
      if (crowdSkip > 0) crowdSkip--;
      cycle = await runLedgerTipCycle(db, client, {
        rangeBlocks,
        maxPages: options.maxPages,
        windowRefreshMs: options.windowRefreshMs,
        crowd,
        rpc: options.rpc,
        multicall: options.multicall,
        signal: options.signal,
        log,
        onRange: (range) => {
          inFlight = range;
        },
      });
    } catch (error) {
      inFlight = null;
      summary.requests += client.requests;
      summary.bytes += client.bytes;
      summary.sentBytes += client.sentBytes;
      if (options.signal?.aborted) return finish("aborted");
      if (
        error instanceof HyperSyncRateLimitExhausted ||
        error instanceof RpcRateLimitExhausted
      ) {
        // A pause, never a stop: the pacer bounds what continuing costs,
        // and an exit Railway counts as a success would leave the site
        // frozen with no restart and no notification.
        const source =
          error instanceof HyperSyncRateLimitExhausted ? "hypersync" : "rpc";
        const retryAfterMs = error.retryAfterMs;
        const waitMs = Math.max(
          Math.min(
            ledgerTipDefaults.maxThrottlePauseMs,
            ledgerTipDefaults.throttlePauseMs * 2 ** pauses,
          ),
          retryAfterMs ?? 0,
        );
        const budgetMs = ledgerTipDefaults.throttleBudgetMs;
        const safe = ledgerTipSafeError(error);
        if (pausedMs + waitMs > budgetMs) {
          log({
            event: "ledger_tip_throttle_exhausted",
            source,
            pauses,
            pausedMs,
            budgetMs,
            error: safe,
            through: summary.through,
          });
          return finish("throttled", error);
        }
        pauses++;
        pausedMs += waitMs;
        summary.pauses++;
        summary.pausedMs += waitMs;
        log({
          event: "ledger_tip_throttle_paused",
          source,
          pause: pauses,
          waitMs,
          retryAfterMs,
          pausedMs,
          budgetMs,
          error: safe,
          through: summary.through,
        });
        await rest(waitMs);
        continue;
      }
      const stop =
        error instanceof HyperSyncUnauthorized
          ? "unauthorized"
          : error instanceof HyperSyncPageCapacity
            ? "capacity"
            : error instanceof Error && inspection.test(error.message)
              ? "inspection"
              : null;
      if (stop) {
        log({
          event: "ledger_tip_stopped_for_good",
          stopped: stop,
          error: ledgerTipSafeError(error),
          through: summary.through,
        });
        return finish(stop, error);
      }
      failures++;
      summary.failures++;
      const waitMs = Math.min(
        ledgerTipDefaults.maxFailureWaitMs,
        ledgerTipDefaults.failureWaitMs * 2 ** (failures - 1),
      );
      log({
        event: "ledger_tip_cycle_failed",
        failures,
        waitMs,
        error: ledgerTipSafeError(error),
        ...errorDetails(error),
        budget: error instanceof HyperSyncBudgetExceeded,
      });
      options.observer?.failed({
        failures,
        waitMs,
        error: ledgerTipSafeError(error),
      });
      if (failures >= maxFailures) return finish("failed", error);
      await wait(waitMs, options.signal);
      continue;
    }
    inFlight = null;
    failures = 0;
    pauses = 0;
    pausedMs = 0;
    summary.cycles++;
    options.observer?.cycle(cycle);
    const c = cycle.crowd;
    if (c) {
      crowdRangeBlocks = c.rangeBlocks;
      if (c.failed) {
        crowdFailures++;
        crowdSkip = Math.min(
          ledgerCrowdDefaults.maxBackoffCycles,
          2 ** (crowdFailures - 1),
        );
      } else crowdFailures = 0;
    }
    summary.requests += cycle.requests;
    summary.bytes += cycle.bytes;
    summary.sentBytes += cycle.sentBytes;
    const r = cycle.range;
    if (r) {
      summary.ranges++;
      summary.blocks += r.blocks;
      summary.launches += r.launches;
      summary.swaps += r.swaps;
      summary.transfers += r.transfers;
      summary.from ??= r.from;
      summary.through = r.to;
      catchUp.blocks += r.blocks;
    }
    const nextRangeBlocks = nextLedgerTipRange(r, rangeBlocks, options);
    const remaining = Math.max(
      0,
      cycle.head - hypersyncPolicy.safeDistance - cycle.cursor,
    );
    const seconds = (performance.now() - catchUp.at) / 1000;
    const blocksPerSecond = seconds > 0 ? catchUp.blocks / seconds : 0;
    log({
      event: "ledger_tip_cycle",
      head: cycle.head,
      cursor: cycle.cursor,
      lagBlocks: cycle.lagBlocks,
      lagSeconds: cycle.lagSeconds,
      remainingBlocks: remaining,
      atTip: cycle.atTip,
      crowd: c && {
        level: c.level,
        failed: c.failed,
        skipCycles: crowdSkip,
        ranges: c.ranges.map((x) => ({
          from: x.from,
          to: x.to,
          cut: x.cut,
          launches: x.launches,
          auctions: x.auctions,
          rejected: x.rejected,
          swaps: x.swaps,
          transfers: x.transfers,
          attributed: x.attributed,
          unattributed: x.unattributed,
          positionsChanged: x.positionsChanged,
          requests: x.requests,
          replayed: x.replayed,
          elapsedMs: x.elapsedMs,
        })),
      },
      range: r && {
        from: r.from,
        to: r.to,
        blocks: r.blocks,
        cut: r.cut,
        launches: r.launches,
        swaps: r.swaps,
        unsupportedSwaps: r.unsupportedSwaps,
        transfers: r.transfers,
        attributed: r.attributed,
        unattributed: r.unattributed,
        unregisteredSwaps: r.unregisteredSwaps,
        swapSelection: r.swapSelection,
        transferSelection: r.transferSelection,
        unregisteredTransfers: r.unregisteredTransfers,
        transferPages: r.transferPages,
        transferFallbackRequests: r.transferFallbackRequests,
        positionsChanged: r.positionsChanged,
        newPositions: r.newPositions,
        newWallets: r.newWallets,
        pages: r.pages,
        replayed: r.replayed,
        elapsedMs: r.elapsedMs,
      },
      windows: cycle.windows && {
        elapsedMs: cycle.windows.elapsedMs,
        throughBlock: cycle.windows.throughBlock,
        windows: cycle.windows.windows.map((w) => ({
          window: w.window,
          mode: w.mode,
          wallets: w.wallets,
          recomputed: w.recomputed,
          subtracted: w.subtracted,
          ranked: w.ranked,
          elapsedMs: w.elapsedMs,
        })),
      },
      requests: cycle.requests,
      bytes: cycle.bytes,
      sentBytes: cycle.sentBytes,
      elapsedMs: cycle.elapsedMs,
      rangeBlocks,
      nextRangeBlocks,
      throttled: throttled(),
      // The catch-up rate since the loop last stood at the tip.
      blocksPerSecond: Math.round(blocksPerSecond),
      etaSeconds:
        remaining > 0 && blocksPerSecond > 0
          ? Math.ceil(remaining / blocksPerSecond)
          : null,
    });
    rangeBlocks = nextRangeBlocks;
    if (options.signal?.aborted) return finish("aborted");
    if (options.maxCycles !== undefined && summary.cycles >= options.maxCycles)
      return finish("cycles");
    // A crowd lane still catching up takes the poll wait for its ranges.
    const crowdBehind = !!c && !c.level && !c.failed;
    if (cycle.atTip && !crowdBehind) await rest(options.pollMs);
  }
}

/** The stream, the ring and the windows as the tables hold them; writes
 * nothing and makes no request. */
export async function ledgerTipStatus(db: Client) {
  const stream = await db.query(
    `SELECT cursor_block::text,cursor_timestamp::text,head_block::text,head_timestamp::text,checked_at,mode,
       (SELECT collected_at FROM agg_batches b WHERE b.chain_id=s.chain_id AND b.stream_key=s.stream_key ORDER BY to_block DESC LIMIT 1) AS last_batch_at
     FROM agg_streams s WHERE chain_id=4663 AND stream_key='ledger:agg:v1'`,
  );
  const ring = await db.query(
    "SELECT count(*)::int AS rows,min(timestamp)::text AS oldest,max(timestamp)::text AS newest,pg_total_relation_size('agg_live_trades')::text AS bytes FROM agg_live_trades WHERE chain_id=4663",
  );
  const refreshes = (
    await db.query(
      "SELECT to_regclass('agg_window_refreshes') IS NOT NULL AS present",
    )
  ).rows[0].present
    ? (
        await db.query(
          `SELECT "window",through_block::text,window_start,wallets,ranked,refreshed_at FROM agg_window_refreshes WHERE chain_id=4663 ORDER BY through_block,"window"`,
        )
      ).rows
    : [];
  const n = (v: string | null) => (v === null ? null : Number(v));
  const s = stream.rows[0];
  return {
    stream: s
      ? {
          cursor: n(s.cursor_block),
          cursorTimestamp: n(s.cursor_timestamp),
          head: n(s.head_block),
          headTimestamp: n(s.head_timestamp),
          lagBlocks:
            s.head_block === null || s.cursor_block === null
              ? null
              : Number(s.head_block) - Number(s.cursor_block),
          checkedAt: s.checked_at,
          lastBatchAt: s.last_batch_at,
          mode: s.mode,
        }
      : null,
    ring: {
      rows: ring.rows[0].rows,
      oldest: n(ring.rows[0].oldest),
      newest: n(ring.rows[0].newest),
      bytes: n(ring.rows[0].bytes),
    },
    windows: refreshes.map((w) => ({
      ...w,
      through_block: n(w.through_block),
    })),
  };
}

/** Fixed descriptions for the loop's failures; never provider text or a token. */
export function ledgerTipSafeError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : "";
  if (name === "HyperSyncRateLimitExhausted")
    return "hypersync_rate_limit_exhausted: four throttled attempts on one request; the tip loop pauses before it tries again";
  if (name === "HyperSyncBudgetExceeded")
    return "hypersync_cycle_budget_exceeded: one cycle reached its request cap; inspect reorg depth and paging";
  if (
    /^(Ledger tip loop disabled; set LEDGER_TIP_ENABLED=1|ENVIO_API_TOKEN is required for the ledger tip loop)$/.test(
      message,
    )
  )
    return `ledger_tip_disabled: ${message}`;
  if (
    /^(Invalid (LEDGER_TIP_[A-Z_]+|LEDGER_STALE_MS|PORT|ROBINHOOD_RPC_URL|HYPERSYNC_URL)|ROBINHOOD_RPC_URL must be the public RPC|HYPERSYNC_URL must be)/.test(
      message,
    )
  )
    return `ledger_tip_configuration_invalid: ${message}`;
  if (
    message === "ledger_tip_requires_pass" ||
    message === "ledger_stream_missing"
  )
    return "ledger_tip_requires_pass: the database holds no ledger; the tip loop extends the history pass's ledger and never starts one";
  if (message === "ledger_tip_ledger_incomplete")
    return "ledger_tip_ledger_incomplete: the ledger's batches folded trades but its positions or wallet hours are empty; restore them before starting the tip loop";
  if (
    /^HyperSync (range exceeds|archive height below) the confirmed cutoff$/.test(
      message,
    )
  )
    return "hypersync_behind_confirmed_cutoff: retry once the archive height passes the cutoff";
  return ledgerPassSafeError(e);
}
