import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ledgerTipExitCodes,
  type LedgerTipCycle,
  type LedgerTipObserver,
  type LedgerTipStop,
} from "./ledger-tip";

/** What the worker is doing before its first cycle has completed. */
export type LedgerTipStartingStep =
  "connecting" | "locking" | "migrating" | "first_cycle";

export interface LedgerTipHealthReport {
  /** 200 after startup checks pass, while cursor progress is fresh. */
  ok: boolean;
  /** `starting` until the first cycle completes, `cycling` after a
   * committed cycle, `retrying` in the back-off after a failed one, and
   * `stopped` once the loop has returned (with `stopped` and `exitCode`). */
  state: "starting" | "cycling" | "retrying" | "stopped";
  step: LedgerTipStartingStep | null;
  startedAt: string;
  uptimeSeconds: number;
  lastCycleAt: string | null;
  sinceLastCycleSeconds: number | null;
  lastProgressAt: string | null;
  sinceLastProgressSeconds: number | null;
  staleAfterSeconds: number;
  stale: boolean;
  cycles: number;
  /** Consecutive failed cycles; the loop exits for a restart at five. */
  failures: number;
  /** The back-off before the next attempt while retrying. */
  waitMs: number | null;
  stopped: LedgerTipStop | null;
  exitCode: number | null;
  /** The loop's fixed description of the last failure or the stop; never
   * provider text. */
  error: string | null;
  head: number | null;
  headTimestamp: number | null;
  cursor: number | null;
  cursorTimestamp: number | null;
  lagBlocks: number | null;
  lagSeconds: number | null;
  atTip: boolean | null;
}

interface LastCycle {
  at: number;
  head: number;
  headTimestamp: number;
  cursor: number;
  cursorTimestamp: number;
  lagBlocks: number;
  lagSeconds: number;
  atTip: boolean;
}

/** The tip loop's liveness as the worker knows it, for `/health`: fed by
 * the worker's start-up steps and the loop's observer hooks, read by the
 * listener below, and never touching the database or the network. */
export class LedgerTipHealth implements LedgerTipObserver {
  private readonly now: () => number;
  private readonly startedAt: number;
  private validated = false;
  private cursor: number | null = null;
  private lastProgressAt: number | null = null;
  private state: LedgerTipHealthReport["state"] = "starting";
  private step: LedgerTipStartingStep = "connecting";
  private last: LastCycle | null = null;
  private cycles = 0;
  private failures = 0;
  private waitMs: number | null = null;
  private stop: LedgerTipStop | null = null;
  private error: string | null = null;

  constructor(
    private readonly options: { staleMs: number; now?: () => number },
  ) {
    if (!Number.isSafeInteger(options.staleMs) || options.staleMs < 1)
      throw Error("Invalid LEDGER_STALE_MS");
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }
  /** The worker's start-up progress, reported until the first cycle. */
  starting(step: LedgerTipStartingStep) {
    if (this.state === "starting") this.step = step;
  }
  ready(cursor: number) {
    if (this.state === "stopped") return;
    this.cursor = cursor;
    this.validated = true;
  }
  cycle(cycle: LedgerTipCycle) {
    if (this.state === "stopped") return;
    if (this.cursor !== null && cycle.cursor > this.cursor)
      this.lastProgressAt = this.now();
    this.cursor = cycle.cursor;
    this.state = "cycling";
    this.cycles++;
    this.failures = 0;
    this.waitMs = null;
    this.error = null;
    this.last = {
      at: this.now(),
      head: cycle.head,
      headTimestamp: cycle.headTimestamp,
      cursor: cycle.cursor,
      cursorTimestamp: cycle.cursorTimestamp,
      lagBlocks: cycle.lagBlocks,
      lagSeconds: cycle.lagSeconds,
      atTip: cycle.atTip,
    };
  }
  failed(event: { failures: number; waitMs: number; error: string }) {
    if (this.state === "stopped") return;
    this.state = "retrying";
    this.failures = event.failures;
    this.waitMs = event.waitMs;
    this.error = event.error;
  }
  stopped(stopped: LedgerTipStop, error: string | null) {
    this.state = "stopped";
    this.stop = stopped;
    this.error = error;
    this.waitMs = null;
  }
  report(): LedgerTipHealthReport {
    const now = this.now();
    const since = this.lastProgressAt ?? this.startedAt;
    const stale = now - since > this.options.staleMs;
    const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
    return {
      ok: this.validated && this.state !== "stopped" && !stale,
      state: this.state,
      step: this.state === "starting" ? this.step : null,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: seconds(now - this.startedAt),
      lastCycleAt: this.last ? new Date(this.last.at).toISOString() : null,
      sinceLastCycleSeconds: this.last ? seconds(now - this.last.at) : null,
      lastProgressAt:
        this.lastProgressAt === null
          ? null
          : new Date(this.lastProgressAt).toISOString(),
      sinceLastProgressSeconds:
        this.lastProgressAt === null
          ? null
          : seconds(now - this.lastProgressAt),
      staleAfterSeconds: Math.floor(this.options.staleMs / 1000),
      stale,
      cycles: this.cycles,
      failures: this.failures,
      waitMs: this.waitMs,
      stopped: this.stop,
      exitCode: this.stop === null ? null : ledgerTipExitCodes[this.stop],
      error: this.error,
      head: this.last?.head ?? null,
      headTimestamp: this.last?.headTimestamp ?? null,
      cursor: this.last?.cursor ?? null,
      cursorTimestamp: this.last?.cursorTimestamp ?? null,
      lagBlocks: this.last?.lagBlocks ?? null,
      lagSeconds: this.last?.lagSeconds ?? null,
      atTip: this.last?.atTip ?? null,
    };
  }
}

/** `GET /health` on the service's port (Railway's `PORT`; its deploy
 * healthcheck polls the path until the first 200, and nothing else reads
 * it continuously): the report above, 200 while the loop is fresh and 503
 * once it has stopped or gone stale. The handler reads memory only, so it
 * never blocks or slows a cycle; the server is unref'd, so it never keeps
 * the worker alive past its exit; and a port it cannot bind is logged, not
 * fatal: a deploy's healthcheck then fails on its own and the previous
 * release keeps running. Resolves the server, or null when it could not
 * listen. */
export function serveLedgerTipHealth(
  health: LedgerTipHealth,
  options: {
    port: number;
    host?: string;
    log: (event: Record<string, unknown>) => void;
  },
): Promise<Server | null> {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const head = req.method === "HEAD";
    const send = (status: number, body: string) => {
      res.statusCode = status;
      res.end(head ? undefined : body);
    };
    if (req.method !== "GET" && !head) {
      res.setHeader("Allow", "GET, HEAD");
      return send(405, '{"error":"method_not_allowed"}');
    }
    if ((req.url ?? "/").split("?")[0] !== "/health")
      return send(404, '{"error":"not_found"}');
    const report = health.report();
    send(report.ok ? 200 : 503, JSON.stringify(report));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 16;
  return new Promise((resolve) => {
    let listening = false;
    server.on("error", (error: NodeJS.ErrnoException) => {
      options.log({
        event: "ledger_tip_health_unavailable",
        port: options.port,
        code: typeof error.code === "string" ? error.code : null,
      });
      if (!listening) resolve(null);
    });
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      listening = true;
      server.unref();
      options.log({
        event: "ledger_tip_health_listening",
        port: (server.address() as AddressInfo).port,
      });
      resolve(server);
    });
  });
}
