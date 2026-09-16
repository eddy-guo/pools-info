import { acquireWriter, createClient, migrate } from "@pools/db";
import {
  createHyperSyncClient,
  hypersyncBackfillConfig,
  hypersyncSafeError,
  planHyperSyncBackfill,
  runHyperSyncBackfill,
} from "./hypersync-backfill";
import { errorDetails } from "./errors";

// Manual, bounded, off by default. `plan` reads state and one page and writes
// nothing; `run` commits bounded broad batches from HyperSync under the main
// writer lock. Neither is started by service.ts.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
async function main() {
  const mode = process.argv[2];
  if (mode !== "plan" && mode !== "run") throw Error("Expected plan or run");
  const config = hypersyncBackfillConfig();
  const client = createHyperSyncClient(config, {
    signal: stop.signal,
    onRetry: (event) =>
      console.error(JSON.stringify({ event: "hypersync_retry", ...event })),
  });
  const db = createClient();
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "hypersync_database_disconnected" }));
  });
  await db.connect();
  try {
    await migrate(db);
    console.log(
      JSON.stringify({
        event: "hypersync_backfill_configured",
        mode,
        url: config.url,
        batchBlocks: config.batchBlocks,
        maxBatches: config.maxBatches,
        maxBlocks: config.maxBlocks,
        maxPages: config.maxPages,
        maxRequests: config.maxRequests,
        minIntervalMs: config.minIntervalMs,
      }),
    );
    if (mode === "plan") {
      const plan = await planHyperSyncBackfill(db, client, config);
      console.log(JSON.stringify({ event: "hypersync_plan", ...plan }));
      return;
    }
    if (!(await acquireWriter(db)))
      throw Error("Another worker holds the writer lock");
    const summary = await runHyperSyncBackfill(db, client, {
      batchBlocks: config.batchBlocks,
      maxPages: config.maxPages,
      maxBatches: config.maxBatches,
      maxBlocks: config.maxBlocks,
      signal: stop.signal,
      log: (event) => console.log(JSON.stringify(event)),
    });
    console.log(
      JSON.stringify({ event: "hypersync_backfill_summary", ...summary }),
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      event: "hypersync_backfill_failed",
      error: hypersyncSafeError(e),
      ...errorDetails(e),
    }),
  );
  process.exitCode = 1;
});
