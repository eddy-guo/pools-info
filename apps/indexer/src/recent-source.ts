import {
  HyperSyncClient,
  HyperSyncPacer,
  hypersyncPolicy,
  hypersyncRecentPolicy,
  type HyperSyncRetryEvent,
} from "@pools/chain";
import { hypersyncSafeError } from "./hypersync-backfill";

/** Where the live worker reads the chain (docs/HYPERSYNC-TIP.md).
 * RECENT_SOURCE=rpc, the default, is the JSON-RPC cycle. RECENT_SOURCE=hypersync
 * reads logs, transactions and headers from Envio HyperSync and the JSON-RPC
 * provider only for a new launch's name and symbol. */
export type RecentSourceConfig =
  | { source: "rpc"; defaultBatchBlocks: number }
  | {
      source: "hypersync";
      defaultBatchBlocks: number;
      url: string;
      token: string;
      minIntervalMs: number;
      maxPages: number;
      maxRequestsPerCycle: number;
    };
export const recentHyperSyncDefaults = Object.freeze({
  /** 30 requests per minute: the free tier's measured sustained rate held with
   * zero 429s at this spacing and throttled at 60 (2026-09-16). It is also
   * the floor, so no configuration can pace the worker faster. */
  minIntervalMs: 2000,
  maxPages: 4,
  /** Height, head header, the shared cursor header and the pages, plus a
   * reorg's walk over at most 256 saved checkpoints. */
  maxRequestsPerCycle: 300,
  /** commitRecentBatch bounds a batch at 2,000 blocks. */
  batchBlocks: hypersyncRecentPolicy.maxBlocks,
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
/** A HyperSync endpoint for another chain answers requests without error, so
 * a wrong URL is caught here rather than by the chain's own data disagreeing
 * with saved checkpoints later (see reconcile's matching guard). */
function hypersyncHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw Error("Invalid HYPERSYNC_URL");
  }
}
export function recentSourceConfig(
  env: NodeJS.ProcessEnv = process.env,
): RecentSourceConfig {
  const source = env.RECENT_SOURCE?.trim() || "rpc";
  if (source === "rpc") return { source, defaultBatchBlocks: 1000 };
  if (source !== "hypersync")
    throw Error("Invalid RECENT_SOURCE; expected rpc or hypersync");
  const token = env.ENVIO_API_TOKEN?.trim();
  if (!token)
    throw Error("ENVIO_API_TOKEN is required for RECENT_SOURCE=hypersync");
  const url = env.HYPERSYNC_URL ?? hypersyncPolicy.defaultUrl;
  const hostname = hypersyncHostname(url);
  if (
    hostname !== "4663.hypersync.xyz" &&
    hostname !== "127.0.0.1" &&
    hostname !== "localhost"
  )
    throw Error("HYPERSYNC_URL must be chain 4663's HyperSync endpoint");
  return {
    source,
    defaultBatchBlocks: recentHyperSyncDefaults.batchBlocks,
    url,
    token,
    minIntervalMs: integer(
      env,
      "RECENT_HYPERSYNC_MIN_INTERVAL_MS",
      recentHyperSyncDefaults.minIntervalMs,
      recentHyperSyncDefaults.minIntervalMs,
      60000,
    ),
    maxPages: integer(
      env,
      "RECENT_HYPERSYNC_MAX_PAGES",
      recentHyperSyncDefaults.maxPages,
      1,
      hypersyncRecentPolicy.maxPages,
    ),
    maxRequestsPerCycle: recentHyperSyncDefaults.maxRequestsPerCycle,
  };
}
/** One client per cycle for per-cycle counters and budget; the pacer is the
 * worker's for its lifetime, so the spacing holds across cycles too. */
export function recentHyperSyncClient(
  config: Extract<RecentSourceConfig, { source: "hypersync" }>,
  pacer: HyperSyncPacer,
  options: {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    onRetry?: (event: HyperSyncRetryEvent) => void;
  } = {},
) {
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
/** Gap-fill progress for the logs: a resume or a lag larger than one batch
 * reports its size when first seen, its remaining blocks and rate on every
 * batch, and its totals once the confirmed tip is reached. Pure; the caller
 * logs what it returns. */
export class RecentGapProgress {
  private started: null | {
    at: number;
    gapBlocks: number;
    blocks: number;
    batches: number;
    requests: number;
  } = null;
  constructor(private readonly now: () => number = () => performance.now()) {}
  observe(batch: {
    head: number;
    through: number | null;
    advanced: number;
    batchBlocks: number;
    requests: number;
    minIntervalMs: number;
  }): Record<string, unknown> | null {
    if (batch.through === null) return null;
    const remaining = Math.max(0, batch.head - 128 - batch.through);
    if (!this.started) {
      if (remaining <= batch.batchBlocks) return null;
      this.started = {
        at: this.now(),
        gapBlocks: remaining + batch.advanced,
        blocks: batch.advanced,
        batches: batch.advanced ? 1 : 0,
        requests: batch.requests,
      };
      const batches = Math.ceil(remaining / batch.batchBlocks);
      return {
        event: "recent_gap_fill",
        phase: "started",
        gapBlocks: this.started.gapBlocks,
        remainingBlocks: remaining,
        estimatedBatches: batches,
        // A floor: three fixed reads and one page per batch, paced. Dense
        // ranges take more pages; progress events report the measured rate.
        minimumMinutes: Math.ceil(
          (batches * 4 * batch.minIntervalMs) / 60000,
        ),
      };
    }
    const s = this.started;
    s.blocks += batch.advanced;
    s.batches += batch.advanced ? 1 : 0;
    s.requests += batch.requests;
    const elapsedMs = Math.round(this.now() - s.at);
    const blocksPerSecond = elapsedMs > 0 ? s.blocks / (elapsedMs / 1000) : 0;
    if (remaining === 0) {
      this.started = null;
      return {
        event: "recent_gap_fill",
        phase: "complete",
        gapBlocks: s.gapBlocks,
        blocks: s.blocks,
        batches: s.batches,
        requests: s.requests,
        elapsedMs,
      };
    }
    return {
      event: "recent_gap_fill",
      phase: "progress",
      gapBlocks: s.gapBlocks,
      remainingBlocks: remaining,
      blocks: s.blocks,
      batches: s.batches,
      requests: s.requests,
      elapsedMs,
      blocksPerSecond: Math.round(blocksPerSecond),
      etaSeconds:
        blocksPerSecond > 0 ? Math.ceil(remaining / blocksPerSecond) : null,
    };
  }
}
/** The worker's own descriptions for HyperSync failures, never provider text. */
export function recentHyperSyncSafeError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : "";
  if (name === "HyperSyncRateLimitExhausted")
    return "hypersync_rate_limit_exhausted: live worker stopped; inspect the Envio request rate before restarting";
  if (name === "HyperSyncBudgetExceeded")
    return "hypersync_cycle_budget_exceeded: one cycle reached its request cap; inspect reorg depth and paging";
  if (
    /^(Invalid RECENT_SOURCE; expected rpc or hypersync|ENVIO_API_TOKEN is required for RECENT_SOURCE=hypersync|Invalid RECENT_HYPERSYNC_[A-Z_]+)$/.test(
      message,
    )
  )
    return `recent_configuration_invalid: ${message}`;
  if (
    /^HyperSync (range exceeds|archive height below) the confirmed cutoff$/.test(
      message,
    )
  )
    return "hypersync_behind_confirmed_cutoff: retry once the archive height passes the cutoff";
  if (
    /^((Invalid|Unexpected|Duplicate|Inconsistent) HyperSync (recent|unregistered|canonical)|HyperSync (recent|swap outside|log lacks))/.test(
      message,
    )
  )
    return "recent_evidence_rejected: HyperSync rows failed validation; inspect the range before resuming";
  return hypersyncSafeError(e);
}
