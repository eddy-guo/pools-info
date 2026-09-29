import { setTimeout as sleep } from "node:timers/promises";
import type { Server } from "node:http";
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
  connectWithBackoff,
  createLedgerTipClient,
  ledgerTipConfig,
  ledgerTipDefaults,
  ledgerTipExitCodes,
  ledgerTipIncomplete,
  ledgerTipSafeError,
  ledgerTipStatus,
  runLedgerTip,
  type LedgerTipConfig,
} from "./ledger-tip";
import { LedgerTipHealth, serveLedgerTipHealth } from "./ledger-tip-health";

// The aggregate ledger's tip loop (docs/AGGREGATE-LEDGER.md phase 3):
//   pnpm ledger:tip status    reads the stream, the ring and the windows; writes nothing
//   pnpm ledger:tip once      one cycle
//   pnpm ledger:tip run       follows the chain until a stop
// ledger-tip-service.ts runs `run` under the supervisor, which turns the
// reserved stops (76 capacity, 77 unauthorized, 78 inspection) into a clean
// exit that Railway does not restart; a throttle pauses the loop, and a
// failure exits 1 for a restart. `run` outlives a database outage in-process
// ("Stops" in the design doc): a lost connection ends the loop on its
// committed cursor and a new session connects again with waits doubling to a
// minute for up to an hour, takes the writer locks, migrates and reconciles
// both streams exactly as a fresh start does. SIGTERM and SIGINT are logged
// with the range in flight and end the loop on a committed batch. `run`
// serves `GET /health` from the loop's progress on PORT.
const stop = new AbortController();
const emit = (event: Record<string, unknown>) =>
  console.log(JSON.stringify(event));
let health: LedgerTipHealth | null = null;
let loopOwnsStop = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (!loopOwnsStop)
      emit({
        event: "ledger_tip_stopping",
        reason: signal,
        cursor: null,
        inFlight: null,
        cycle: null,
      });
    stop.abort(new DOMException(signal, "AbortError"));
  });
type Mode = "run" | "once" | "status";

/** Whether the database already holds the ledger the loop extends. Asked
 * before migrating, so a loop pointed at any other database (the old
 * production one) refuses without altering it. */
async function holdsLedger(db: Client) {
  const r = await db.query(
    "SELECT to_regclass('agg_streams') IS NOT NULL AS present",
  );
  if (!r.rows[0].present) return null;
  const stream = await db.query(
    "SELECT cursor_block FROM agg_streams WHERE chain_id=4663 AND stream_key='ledger:agg:v1'",
  );
  return stream.rows[0]?.cursor_block == null
    ? null
    : Number(stream.rows[0].cursor_block);
}
/** The writer locks, polled once a second for `waitMs`: a deployment
 * overlap's previous instance releases them on SIGTERM within a second, and
 * a session the server has not yet noticed dead holds them until it does,
 * so the service waits its connection horizon and says so once a minute. */
async function locks(db: Client, signal: AbortSignal, waitMs: number) {
  const started = performance.now();
  let writer = false,
    ledger = false,
    reported = 0;
  while (!signal.aborted) {
    writer ||= await acquireWriter(db);
    ledger ||= writer && (await acquireLedgerWriter(db));
    if (writer && ledger) return true;
    const waitedMs = Math.round(performance.now() - started);
    if (waitedMs >= waitMs) return false;
    if (waitedMs - reported >= 60000) {
      reported = waitedMs;
      emit({ event: "ledger_tip_writer_busy", waitedMs, waitMs });
    }
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
  return false;
}
/** One database session: connect, hold the locks, migrate, run the loop.
 * "reconnect" is a session `run` lost to the database (the connection
 * dropped, or the server went away) before a signal stopped the service:
 * the next session starts over from the saved cursor. */
async function session(
  mode: Mode,
  config: LedgerTipConfig,
  n: number,
): Promise<"done" | "reconnect"> {
  const horizonMs = mode === "run" ? ledgerTipDefaults.connectHorizonMs : 0;
  const lost = new AbortController();
  const signal = AbortSignal.any([stop.signal, lost.signal]);
  const reconnect = () =>
    mode === "run" && lost.signal.aborted && !stop.signal.aborted;
  const disconnected = (error: unknown) => {
    if (lost.signal.aborted) return;
    console.error(
      JSON.stringify({
        event: "ledger_database_disconnected",
        session: n,
        ...errorDetails(error),
      }),
    );
    lost.abort(new DOMException("database_lost", "AbortError"));
  };
  const db = await connectWithBackoff(
    () =>
      createClient(undefined, {
        statementTimeoutMs: 600000,
        applicationName: "pools-ledger-tip",
      }),
    { horizonMs, signal: stop.signal, log: emit },
  );
  if (db === null) return "done";
  db.on("error", disconnected);
  try {
    const refuse = (
      message: "ledger_tip_requires_pass" | "ledger_tip_ledger_incomplete",
    ) => {
      const error = Error(message);
      process.exitCode = ledgerTipExitCodes.inspection;
      health?.stopped("inspection", ledgerTipSafeError(error));
      console.error(
        JSON.stringify({
          event: "ledger_tip_refused",
          error: ledgerTipSafeError(error),
        }),
      );
    };
    const cursor = await holdsLedger(db);
    if (cursor === null) {
      refuse("ledger_tip_requires_pass");
      return "done";
    }
    if (mode === "status") {
      emit({ event: "ledger_tip_status", ...(await ledgerTipStatus(db)) });
      return "done";
    }
    assertLedgerTipAllowed(config);
    if (await ledgerTipIncomplete(db)) {
      refuse("ledger_tip_ledger_incomplete");
      return "done";
    }
    health?.ready(cursor);
    let throttled = 0;
    const pacer = new HyperSyncPacer();
    const client = () =>
      createLedgerTipClient(config, pacer, {
        signal,
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
    if (n === 1)
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
        crowdEnabled: config.crowdEnabled,
        staleMs: config.staleMs,
      });
    health?.starting("locking");
    if (!(await locks(db, signal, Math.max(180000, horizonMs)))) {
      if (signal.aborted) return reconnect() ? "reconnect" : "done";
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
      health?.starting("migrating");
      const migrator = createClient(undefined, {
        statementTimeoutMs: 3600000,
        applicationName: "pools-ledger-tip-migrate",
      });
      migrator.on("error", disconnected);
      await migrator.connect();
      try {
        await migrate(migrator);
      } finally {
        await migrator.end().catch(() => {});
      }
      health?.starting("first_cycle");
      const warmth = new DatabaseWarmth(
        createWarmSet(process.env.DATABASE_URL!, "ledger", undefined, emit),
        { log: emit },
      );
      try {
        if (stop.signal.aborted) return "done";
        loopOwnsStop = true;
        const summary = await runLedgerTip(db, {
          warmth,
          observer: health ?? undefined,
          client,
          rpc: () => createLedgerPassRpc(config, signal),
          rangeBlocks: config.rangeBlocks,
          maxRangeBlocks: config.maxRangeBlocks,
          maxPages: config.maxPages,
          pollMs: config.pollMs,
          windowRefreshMs: config.windowRefreshMs,
          crowdEnabled: config.crowdEnabled,
          signal,
          log: emit,
          throttled: () => throttled,
          ...(mode === "once" ? { maxCycles: 1 } : {}),
        });
        emit({ event: "ledger_tip_summary", session: n, ...summary });
        if (reconnect()) return "reconnect";
        process.exitCode = ledgerTipExitCodes[summary.stopped];
        return "done";
      } finally {
        loopOwnsStop = false;
        await warmth.close();
      }
    } finally {
      // The locks die with the session either way; on a lost connection the
      // server releases them as soon as it notices the socket is gone.
      await releaseLedgerWriter(db).catch(() => {});
    }
  } catch (error) {
    if (reconnect()) {
      console.error(
        JSON.stringify({
          event: "ledger_tip_session_lost",
          session: n,
          error: ledgerTipSafeError(error),
          ...errorDetails(error),
        }),
      );
      return "reconnect";
    }
    throw error;
  } finally {
    await db.end().catch(() => {});
  }
}
async function main() {
  const mode = process.argv[2];
  if (mode !== "run" && mode !== "once" && mode !== "status")
    throw Error("Expected run, once or status");
  const config = ledgerTipConfig();
  let healthServer: Server | null = null;
  if (mode === "run") {
    health = new LedgerTipHealth({ staleMs: config.staleMs });
    healthServer = await serveLedgerTipHealth(health, {
      port: config.healthPort,
      log: emit,
    });
  }
  try {
    for (let n = 1; ; n++) {
      if ((await session(mode, config, n)) === "done") return;
      emit({ event: "ledger_tip_reconnecting", session: n + 1 });
    }
  } finally {
    healthServer?.close();
  }
}
main().catch((e) => {
  health?.stopped("failed", ledgerTipSafeError(e));
  console.error(
    JSON.stringify({
      event: "ledger_tip_failed",
      error: ledgerTipSafeError(e),
      ...errorDetails(e),
    }),
  );
  process.exitCode = 1;
});
