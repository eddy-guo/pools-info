import { setTimeout as sleep } from "node:timers/promises";
import { HyperSyncPacer } from "@pools/chain";
import {
  acquireLedgerWriter,
  acquireWriter,
  createClient,
  migrate,
  releaseLedgerWriter,
  type Client,
} from "@pools/db";
import { errorDetails } from "./errors";
import { createLedgerPassRpc } from "./ledger-pass";
import {
  assertLedgerTipAllowed,
  createLedgerTipClient,
  ledgerTipConfig,
  ledgerTipExitCodes,
  ledgerTipSafeError,
  ledgerTipStatus,
  runLedgerTip,
} from "./ledger-tip";

// The aggregate ledger's tip loop (docs/AGGREGATE-LEDGER.md phase 3):
//   pnpm ledger:tip status    reads the stream, the ring and the windows; writes nothing
//   pnpm ledger:tip once      one cycle
//   pnpm ledger:tip run       follows the chain until a stop
// ledger-tip-service.ts runs `run` under the supervisor, which turns the
// reserved stops (75 throttled, 76 capacity, 77 unauthorized, 78 inspection)
// into a clean exit that Railway does not restart. SIGTERM ends the loop on a
// committed batch.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
const emit = (event: Record<string, unknown>) =>
  console.log(JSON.stringify(event));

/** Whether the database already holds the ledger the loop extends. Asked
 * before migrating, so a loop pointed at any other database (the old
 * production one) refuses without altering it. */
async function holdsLedger(db: Client) {
  const r = await db.query(
    "SELECT to_regclass('agg_streams') IS NOT NULL AS present",
  );
  if (!r.rows[0].present) return false;
  const stream = await db.query(
    "SELECT cursor_block FROM agg_streams WHERE chain_id=4663 AND stream_key='ledger:agg:v1'",
  );
  return stream.rows[0]?.cursor_block != null;
}
async function locks(db: Client) {
  // A deployment overlap: the previous instance releases on SIGTERM.
  const deadline = performance.now() + 180000;
  let writer = false,
    ledger = false;
  while (!stop.signal.aborted && performance.now() < deadline) {
    writer ||= await acquireWriter(db);
    ledger ||= writer && (await acquireLedgerWriter(db));
    if (writer && ledger) return true;
    await sleep(1000, undefined, { signal: stop.signal }).catch(() => {});
  }
  return false;
}
async function main() {
  const mode = process.argv[2];
  if (mode !== "run" && mode !== "once" && mode !== "status")
    throw Error("Expected run, once or status");
  const config = ledgerTipConfig();
  const db = createClient(undefined, {
    statementTimeoutMs: 600000,
    applicationName: "pools-ledger-tip",
  });
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "ledger_database_disconnected" }));
  });
  await db.connect();
  try {
    if (!(await holdsLedger(db))) {
      process.exitCode = ledgerTipExitCodes.inspection;
      console.error(
        JSON.stringify({
          event: "ledger_tip_refused",
          error: ledgerTipSafeError(Error("ledger_tip_requires_pass")),
        }),
      );
      return;
    }
    if (mode === "status") {
      emit({ event: "ledger_tip_status", ...(await ledgerTipStatus(db)) });
      return;
    }
    assertLedgerTipAllowed(config);
    await migrate(db);
    let throttled = 0;
    const pacer = new HyperSyncPacer();
    const client = () =>
      createLedgerTipClient(config, pacer, {
        signal: stop.signal,
        onRetry: (event) => {
          if (event.reason === "throttled") throttled++;
          console.error(
            JSON.stringify({
              event: "hypersync_retry",
              worker: "ledger-tip",
              ...event,
            }),
          );
        },
      });
    emit({
      event: "ledger_tip_configured",
      mode,
      url: config.url,
      rpcHost: new URL(config.rpcUrl).hostname,
      rangeBlocks: config.rangeBlocks,
      maxRangeBlocks: config.maxRangeBlocks,
      minIntervalMs: config.minIntervalMs,
      maxPages: config.maxPages,
      maxRequestsPerCycle: config.maxRequestsPerCycle,
      pollMs: config.pollMs,
      windowRefreshMs: config.windowRefreshMs,
    });
    if (!(await locks(db))) {
      if (stop.signal.aborted) return;
      throw Error("Another process holds the ledger writer lock");
    }
    try {
      const summary = await runLedgerTip(db, {
        client,
        rpc: () => createLedgerPassRpc(config, stop.signal),
        rangeBlocks: config.rangeBlocks,
        maxRangeBlocks: config.maxRangeBlocks,
        maxPages: config.maxPages,
        pollMs: config.pollMs,
        windowRefreshMs: config.windowRefreshMs,
        signal: stop.signal,
        log: emit,
        throttled: () => throttled,
        ...(mode === "once" ? { maxCycles: 1 } : {}),
      });
      emit({ event: "ledger_tip_summary", ...summary });
      process.exitCode = ledgerTipExitCodes[summary.stopped];
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
      event: "ledger_tip_failed",
      error: ledgerTipSafeError(e),
      ...errorDetails(e),
    }),
  );
  process.exitCode = 1;
});
