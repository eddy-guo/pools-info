import { setTimeout as sleep } from "node:timers/promises";
import { HyperSyncPacer } from "@pools/chain";
import { DatabaseWarmth, createWarmSet } from "@pools/api/warmup";
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
      // Migrations run under the writer lock, after the previous instance
      // of a deployment overlap has released it: a migration that rewrites
      // ledger rows (022 re-flags positions and rebuilds the windows) never
      // runs beside a batch the old image is still folding under the old
      // rule, and the api only reads while it runs. They get their own
      // connection with an hour's budget: a migration file is one query to
      // the driver, whose call timeout is the statement budget, and 022 takes
      // one to three minutes on a production-shaped copy against the ten
      // minutes a batch's own statements keep.
      const migrator = createClient(undefined, {
        statementTimeoutMs: 3600000,
        applicationName: "pools-ledger-tip-migrate",
      });
      await migrator.connect();
      try {
        await migrate(migrator);
      } finally {
        await migrator.end();
      }
      const warmth = new DatabaseWarmth(
        createWarmSet(process.env.DATABASE_URL!, "ledger", undefined, emit),
        { log: emit },
      );
      try {
        const summary = await runLedgerTip(db, {
          warmth,
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
        await warmth.close();
      }
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
