import { rpcPacing } from "./rpc-pacing";
import {
  rpcRateLimitObserver,
  throwIfRateLimitExhausted,
  workerFailureExitCode,
} from "./rpc-operations";
import { setTimeout as sleep } from "node:timers/promises";
import { HyperSyncPacer, HyperSyncUnauthorized, Rpc } from "@pools/chain";
import { createClient, migrate, recentResumeBatchBlocks } from "@pools/db";
import {
  smallerRecentBatch,
  recentBatchSuccess,
  RECENT_TIMEOUT_MS,
  RECENT_MAX_REQUESTS,
} from "./recent-budget";
import { runRecentCycle, runRecentHyperSyncCycle } from "./recent-worker";
import {
  RecentGapProgress,
  recentHyperSyncClient,
  recentHyperSyncSafeError,
  recentSourceConfig,
} from "./recent-source";
import { safeError, errorDetails } from "./errors";
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
function integer(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error("Invalid recent configuration");
  return n;
}
async function pause(ms: number) {
  await sleep(ms, undefined, { signal: stop.signal }).catch((e) => {
    if (e.name !== "AbortError") throw e;
  });
}
async function main() {
  const mode = process.argv[2] ?? "once";
  if (!["once", "run"].includes(mode)) throw Error("Invalid recent command");
  if (!process.env.ROBINHOOD_RPC_URL)
    throw Error("ROBINHOOD_RPC_URL is required for the persistent worker");
  // The JSON-RPC cycle unless RECENT_SOURCE=hypersync; see docs/HYPERSYNC-TIP.md.
  const source = recentSourceConfig();
  const hs = source.source === "hypersync" ? source : null;
  const options = {
    bootstrapBlocks: integer("RECENT_BOOTSTRAP_BLOCKS", 6000, 1, 100000),
    batchBlocks: integer(
      "RECENT_BATCH_BLOCKS",
      source.defaultBatchBlocks,
      1,
      2000,
    ),
    signal: stop.signal,
  };
  const logRangeBlocks = integer("RECENT_LOG_RANGE_BLOCKS", 10, 1, 10000);
  // At the confirmed tip a cycle repeats its fixed reads (head, cursors, both
  // boundaries, one log query) whether or not blocks arrived; poll slowly.
  const tipPollMs = integer("RECENT_TIP_POLL_MS", 30000, 1000, 600000);
  const db = createClient();
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "recent_database_disconnected" }));
  });
  await db.connect();
  try {
    await migrate(db);
    const deadline = performance.now() + 180000;
    let acquired = false;
    do {
      if (stop.signal.aborted) return;
      acquired = (
        await db.query("SELECT pg_try_advisory_lock(4663,19004) AS acquired")
      ).rows[0].acquired;
      if (acquired) break;
      if (mode === "once") throw Error("Another worker holds the writer lock");
      await pause(1000);
    } while (performance.now() < deadline);
    if (!acquired) throw Error("Another worker holds the writer lock");
    let failures = 0;
    let goodCycles = 0;
    // HyperSync pages cut a dense range short at a block boundary instead of
    // failing it, so that source starts at its configured width.
    let batchBlocks = hs
      ? options.batchBlocks
      : await recentResumeBatchBlocks(db, options.batchBlocks);
    console.log(
      JSON.stringify({
        event: "recent_configuration",
        source: source.source,
        bootstrapBlocks: options.bootstrapBlocks,
        batchBlocks: options.batchBlocks,
        resumeBatchBlocks: batchBlocks,
        logRangeBlocks,
        tipPollMs,
        ...rpcPacing(),
        ...(hs
          ? {
              hypersyncUrl: hs.url,
              hypersyncMinIntervalMs: hs.minIntervalMs,
              hypersyncMaxPages: hs.maxPages,
              hypersyncMaxRequestsPerCycle: hs.maxRequestsPerCycle,
            }
          : {}),
      }),
    );
    // One pacer for the worker's life: cycles run back to back during a gap
    // fill, and the spacing must hold across them, not only within one.
    const pacer = new HyperSyncPacer();
    const gap = new RecentGapProgress();
    do {
      if (stop.signal.aborted) break;
      // Always use the configured authenticated RPC. The public provider blocks
      // hosted requests, and this lane never inherits INDEXER_LOG_RPC_URL.
      const rpc = new Rpc(process.env.ROBINHOOD_RPC_URL, {
        timeoutMs: RECENT_TIMEOUT_MS,
        maxRequests: RECENT_MAX_REQUESTS,
        ...rpcPacing(),
        onRateLimit: rpcRateLimitObserver("recent"),
        logRangeBlocks,
      });
      const client = hs
        ? recentHyperSyncClient(hs, pacer, {
            signal: stop.signal,
            onRetry: (event) =>
              console.error(
                JSON.stringify({
                  event: "hypersync_retry",
                  worker: "recent",
                  ...event,
                }),
              ),
          })
        : null;
      const hypersync = () =>
        client
          ? { hypersyncRequests: client.requests, hypersyncBytes: client.bytes }
          : {};
      const started = performance.now();
      try {
        const r =
          hs && client
            ? await runRecentHyperSyncCycle(db, client, rpc, {
                ...options,
                batchBlocks,
                maxPages: hs.maxPages,
              })
            : await runRecentCycle(db, rpc, { ...options, batchBlocks });
        failures = 0;
        const requestedBatchBlocks = batchBlocks;
        const elapsedMs = Math.round(performance.now() - started);
        ({ batchBlocks, goodCycles } = recentBatchSuccess({
          batchBlocks,
          maxBlocks: options.batchBlocks,
          goodCycles,
          advanced: r.advanced,
          elapsedMs,
          httpRequests: client ? client.requests : rpc.requests,
        }));
        console.log(
          JSON.stringify({
            event: "recent_batch",
            source: source.source,
            ...r,
            lagBlocks: r.through === null ? null : r.head - r.through,
            elapsedMs,
            requestedBatchBlocks,
            nextBatchBlocks: batchBlocks,
            // JSON-RPC provider (Alchemy) requests and logical calls.
            httpRequests: rpc.requests,
            rpcCalls: rpc.calls,
            ...hypersync(),
          }),
        );
        if (hs && client) {
          const progress = gap.observe({
            head: r.head,
            through: r.through,
            advanced: r.advanced,
            batchBlocks: requestedBatchBlocks,
            requests: client.requests,
            minIntervalMs: hs.minIntervalMs,
          });
          if (progress) console.log(JSON.stringify(progress));
        }
        if (mode === "once" || stop.signal.aborted) break;
        if (!r.advanced || r.through === r.head - 128) await pause(tipPollMs);
      } catch (e) {
        if (stop.signal.aborted) break;
        throwIfRateLimitExhausted(e);
        // A rejected token cannot recover by retrying.
        if (e instanceof HyperSyncUnauthorized) throw e;
        goodCycles = 0;
        const smaller = smallerRecentBatch(e, batchBlocks);
        if (smaller < batchBlocks) {
          batchBlocks = smaller;
          failures = 0;
        } else failures++;
        console.error(
          JSON.stringify({
            event: "recent_batch_failed",
            source: source.source,
            failures,
            nextBatchBlocks: batchBlocks,
            error: client ? recentHyperSyncSafeError(e) : safeError(e),
            ...errorDetails(e),
            httpRequests: rpc.requests,
            rpcCalls: rpc.calls,
            ...hypersync(),
          }),
        );
        if (mode === "once" || failures >= 5) throw e;
        if (!stop.signal.aborted)
          await pause(Math.min(30000, 2000 * 2 ** (failures - 1)));
      }
    } while (!stop.signal.aborted);
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      event: "recent_failed",
      error:
        process.env.RECENT_SOURCE === "hypersync"
          ? recentHyperSyncSafeError(e)
          : safeError(e),
      ...errorDetails(e),
    }),
  );
  process.exitCode = workerFailureExitCode(e);
});
