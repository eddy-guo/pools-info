import {
  createClient,
  creatorFeeCoverage,
  retainedLaunchLogs,
  saveCreatorFees,
  unresolvedCreatorFeeBatches,
} from "@pools/db";
import { errorDetails } from "./errors";
import { runCreatorFeeBackfill } from "./creator-fees-backfill";

// The creator-fee flag for pools written before migration 021
// (apps/indexer/src/creator-fees-backfill.ts). Manual, never started by
// service.ts, no migration and no chain source: it reads the launch logs the
// launch stream already retains.
//   pnpm creator-fees:backfill status        counts known and unknown flags
//   pnpm creator-fees:backfill run           fills pools with no deep publication
//   pnpm creator-fees:backfill run --all     fills every unknown flag
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
const emit = (event: Record<string, unknown>) =>
  console.log(JSON.stringify(event));
async function main() {
  const [mode, ...flags] = process.argv.slice(2);
  if (mode !== "run" && mode !== "status")
    throw Error("Expected run or status");
  if (flags.some((f) => f !== "--all")) throw Error("Unexpected argument");
  const scope = flags.includes("--all") ? "all" : "unpublished";
  const db = createClient();
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(
      JSON.stringify({ event: "creator_fees_database_disconnected" }),
    );
  });
  await db.connect();
  try {
    emit({ event: "creator_fees_coverage", ...(await creatorFeeCoverage(db)) });
    if (mode === "status") return;
    emit({ event: "creator_fees_configured", scope });
    const summary = await runCreatorFeeBackfill({
      batches: () => unresolvedCreatorFeeBatches(db, scope),
      logs: (batchEnd) => retainedLaunchLogs(db, batchEnd),
      save: (rows) => saveCreatorFees(db, rows),
      log: emit,
      signal: stop.signal,
    });
    emit({ event: "creator_fees_summary", ...summary });
    emit({ event: "creator_fees_coverage", ...(await creatorFeeCoverage(db)) });
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({ event: "creator_fees_failed", ...errorDetails(e) }),
  );
  process.exitCode = 1;
});
