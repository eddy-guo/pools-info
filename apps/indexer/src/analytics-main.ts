import { rpcPacing } from "./rpc-pacing";
import { gunzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Rpc } from "@pools/chain";
import { createClient } from "@pools/db";
import { backfillAccountingRows } from "./accounting-projection";
import {
  analyticsError,
  captureAnalyticsInput,
  projectAnalytics,
  publishAnalytics,
  runAnalyticsOnce,
} from "./analytics";

function rpc() {
  const range = Number(process.env.INDEXER_LOG_RANGE_BLOCKS ?? 10);
  if (!Number.isInteger(range) || range < 1 || range > 10000)
    throw Error("analytics_invalid_log_range");
  return new Rpc(undefined, {
    timeoutMs: 300000,
    maxRequests: 500,
    ...rpcPacing(),
    logRangeBlocks: range,
  });
}
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
async function seedCapture(
  db: ReturnType<typeof createClient>,
  path: string | undefined,
  skipExisting: boolean,
) {
  if (!path || (await stat(path)).size > 32 * 1024 * 1024)
    throw Error("analytics_invalid_capture");
  const bytes = await readFile(path);
  const content = path.endsWith(".gz")
    ? gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 })
    : bytes;
  if (content.length > 32 * 1024 * 1024)
    throw Error("analytics_invalid_capture");
  const capture = JSON.parse(content.toString("utf8"));
  const input = await captureAnalyticsInput(db, capture);
  if (skipExisting) {
    const prior = (
      await db.query(
        "SELECT through_block FROM analytics_pool_snapshots WHERE chain_id=4663 AND pool_id=$1",
        [input.poolId],
      )
    ).rows[0];
    if (prior && Number(prior.through_block) >= input.toBlock) {
      console.log(
        JSON.stringify({
          event: "analytics_seed_already_published",
          pool: input.poolId,
          toBlock: Number(prior.through_block),
        }),
      );
      return;
    }
  }
  const result = await projectAnalytics(input, rpc());
  const published = await publishAnalytics(db, input, result);
  console.log(
    JSON.stringify({
      event: published
        ? "analytics_imported"
        : "analytics_older_capture_retained",
      pool: input.poolId,
      toBlock: input.toBlock,
      holders: result.holders?.positiveHoldersExcludingInfrastructure ?? null,
      wallets: result.snapshot.markets[0].accounting?.wallets.length ?? 0,
    }),
  );
}
async function analyticsLock(
  db: ReturnType<typeof createClient>,
  wait: boolean,
) {
  const deadline = performance.now() + 180000;
  do {
    if (stop.signal.aborted) return false;
    const acquired = (
      await db.query("SELECT pg_try_advisory_lock(4663,19003) AS acquired")
    ).rows[0].acquired;
    if (acquired) {
      if (stop.signal.aborted) {
        await db.query("SELECT pg_advisory_unlock(4663,19003)");
        return false;
      }
      return true;
    }
    if (!wait) return false;
    await sleep(1000, undefined, { signal: stop.signal }).catch((e) => {
      if (e.name !== "AbortError") throw e;
    });
  } while (!stop.signal.aborted && performance.now() < deadline);
  return false;
}
async function main() {
  const mode = process.argv[2] ?? "once";
  if (!["once", "run", "import", "seed", "backfill"].includes(mode))
    throw Error("analytics_invalid_command");
  const db = createClient();
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "analytics_database_disconnected" }));
  });
  await db.connect();
  try {
    // Independent projector lock permits the chain collector to continue. One
    // projector prevents duplicate expensive work and conflicting import jobs.
    if (mode === "run")
      console.log(JSON.stringify({ event: "analytics_waiting_for_writer" }));
    const acquired = await analyticsLock(db, mode === "run");
    if (stop.signal.aborted) return;
    if (!acquired) throw Error("analytics_writer_busy");
    // Upgrade already published evidence without re-querying the chain. Each
    // pool commits separately, so interruption resumes from the next marker.
    let backfilled = 0;
    while (!stop.signal.aborted) {
      const count = await backfillAccountingRows(db, 25);
      backfilled += count;
      if (count < 25) break;
    }
    if (backfilled || mode === "backfill")
      console.log(
        JSON.stringify({
          event: "analytics_accounting_backfilled",
          pools: backfilled,
        }),
      );
    if (mode === "backfill" || stop.signal.aborted) return;
    if (mode === "import" || mode === "seed") {
      await seedCapture(db, process.argv[3], mode === "seed");
      return;
    }
    if (mode === "run" && process.env.ANALYTICS_SEED_PATH)
      await seedCapture(db, process.env.ANALYTICS_SEED_PATH, true);
    do {
      try {
        await runAnalyticsOnce(
          db,
          rpc(),
          mode === "once" ? process.argv[3]?.toLowerCase() : undefined,
        );
      } catch (e) {
        if (mode === "once") throw e;
        console.error(
          JSON.stringify({
            event: "analytics_failed",
            error: analyticsError(e),
          }),
        );
      }
      if (mode === "once" || stop.signal.aborted) break;
      await sleep(15000, undefined, { signal: stop.signal }).catch((e) => {
        if (e.name !== "AbortError") throw e;
      });
    } while (!stop.signal.aborted);
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({ event: "analytics_stopped", error: analyticsError(e) }),
  );
  process.exitCode = 1;
});
