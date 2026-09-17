import { HyperSyncPacer } from "@pools/chain";
import {
  acquireLedgerWriter,
  acquireWriter,
  createClient,
  migrate,
  releaseLedgerWriter,
} from "@pools/db";
import { errorDetails } from "./errors";
import {
  calibrateLedgerRange,
  compareLedgerSwapSelections,
  createLedgerPassClient,
  createLedgerPassRpc,
  ledgerPassConfig,
  ledgerPassSafeError,
  ledgerPassStatus,
  runLedgerPass,
} from "./ledger-pass";
import { RPC_RATE_LIMIT_EXIT_CODE } from "./supervisor";

// The aggregate ledger's history pass (docs/AGGREGATE-LEDGER.md phase 2).
// Manual, off by default, never started by service.ts:
//   pnpm ledger:pass status                      reads the streams, writes nothing
//   pnpm ledger:pass calibrate <from> <to>       collects one range, writes nothing
//   pnpm ledger:pass compare <from> <to>         collects one range with both swap
//                                                selections and requires the same rows
//   pnpm ledger:pass run                         folds ranges from the cursor to the cutoff
// A sustained HyperSync or RPC throttle ends `run` with the reserved exit
// code 75 and nothing restarts it.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
const usage =
  "Expected run, calibrate <from> <to>, compare <from> <to> or status";
const emit = (event: Record<string, unknown>) =>
  console.log(JSON.stringify(event));
async function main() {
  const mode = process.argv[2];
  if (
    mode !== "run" &&
    mode !== "calibrate" &&
    mode !== "compare" &&
    mode !== "status"
  )
    throw Error(usage);
  const config = ledgerPassConfig();
  const db = createClient(undefined, {
    statementTimeoutMs: 600000,
    applicationName: "pools-ledger-pass",
  });
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "ledger_database_disconnected" }));
  });
  await db.connect();
  try {
    await migrate(db);
    if (mode === "status") {
      emit({ event: "ledger_pass_status", ...(await ledgerPassStatus(db)) });
      return;
    }
    let throttled = 0;
    const client = createLedgerPassClient(config, {
      signal: stop.signal,
      pacer: new HyperSyncPacer(),
      onRetry: (event) => {
        if (event.reason === "throttled") throttled++;
        console.error(JSON.stringify({ event: "hypersync_retry", ...event }));
      },
    });
    emit({
      event: "ledger_pass_configured",
      mode,
      url: config.url,
      rpcHost: new URL(config.rpcUrl).hostname,
      rangeBlocks: config.rangeBlocks,
      maxRangeBlocks: config.maxRangeBlocks,
      minIntervalMs: config.minIntervalMs,
      maxPages: config.maxPages,
      maxRequests: config.maxRequests,
      maxRanges: config.maxRanges,
    });
    const fromBlock = Number(process.argv[3]),
      toBlock = Number(process.argv[4]);
    if (
      (mode === "calibrate" || mode === "compare") &&
      (!Number.isSafeInteger(fromBlock) ||
        !Number.isSafeInteger(toBlock) ||
        fromBlock < 0 ||
        toBlock < fromBlock)
    )
      throw Error(usage);
    if (mode === "compare") {
      const started = performance.now();
      const comparison = await compareLedgerSwapSelections(
        db,
        client,
        () => createLedgerPassRpc(config, stop.signal),
        { fromBlock, toBlock },
        config.maxPages,
      );
      emit({
        event: "ledger_swap_selections_compared",
        ...comparison,
        throttled,
        elapsedMs: Math.round(performance.now() - started),
      });
      return;
    }
    if (mode === "calibrate") {
      const started = performance.now();
      const calibration = await calibrateLedgerRange(
        db,
        client,
        createLedgerPassRpc(config, stop.signal),
        { fromBlock, toBlock },
        config.maxPages,
      );
      emit({
        event: "ledger_calibration",
        ...calibration,
        throttled,
        elapsedMs: Math.round(performance.now() - started),
      });
      return;
    }
    if (!(await acquireWriter(db)))
      throw Error("Another worker holds the writer lock");
    if (!(await acquireLedgerWriter(db)))
      throw Error("Another process holds the ledger writer lock");
    try {
      const summary = await runLedgerPass(db, client, {
        rangeBlocks: config.rangeBlocks,
        maxRangeBlocks: config.maxRangeBlocks,
        maxPages: config.maxPages,
        rpc: () => createLedgerPassRpc(config, stop.signal),
        signal: stop.signal,
        log: emit,
        throttled: () => throttled,
        ...(config.maxRanges === null ? {} : { maxRanges: config.maxRanges }),
      });
      emit({ event: "ledger_pass_summary", ...summary });
      if (summary.stopped === "throttled")
        process.exitCode = RPC_RATE_LIMIT_EXIT_CODE;
      else if (summary.stopped === "budget") process.exitCode = 1;
    } finally {
      await releaseLedgerWriter(db);
    }
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      event: "ledger_pass_failed",
      error: ledgerPassSafeError(e),
      ...errorDetails(e),
    }),
  );
  process.exitCode = 1;
});
