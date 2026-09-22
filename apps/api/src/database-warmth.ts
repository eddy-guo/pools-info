import { setTimeout as sleep } from "node:timers/promises";
import { RequestError } from "./request";

export const warmPolicy = Object.freeze({
  cadenceMs: 5 * 60_000,
  attempts: 3,
  retryMs: 1000,
  statementMs: 10_000,
  attemptMs: 60_000,
  servingMs: 2800,
  retryAfter: 5,
});
export interface WarmAttempt {
  signal: AbortSignal;
  identity(value: string): void;
  slow(name: string): void;
}

/** Database-wide availability, independent of container health. Like explorer
 * wallet history, an unanswerable read is a retryable refusal, never a stored
 * substitute. The cadence detects eviction; identity only accelerates restart
 * detection. A failure between cadence runs can still spend the read budget. */
export class DatabaseWarmth {
  private identity: string | null = null;
  private ready = false;
  private version = 0;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastAttempt = -Infinity;

  constructor(
    private readonly attempt: (context: WarmAttempt) => Promise<void>,
    private readonly options: {
      cadenceMs?: number;
      attempts?: number;
      retryMs?: number;
      now?: () => number;
      log?: (event: Record<string, unknown>) => void;
    } = {},
  ) {}

  private get now() {
    return this.options.now ?? Date.now;
  }
  get due() {
    return this.delayMs === 0;
  }
  /** Allows the tip to schedule a due set inside a long idle poll, rather
   * than adding an entire poll interval to the five-minute cadence. */
  get delayMs() {
    return Math.max(
      0,
      this.lastAttempt +
        (this.options.cadenceMs ?? warmPolicy.cadenceMs) -
        this.now(),
    );
  }
  assertReady(expected?: number): number {
    if (!this.ready || (expected !== undefined && expected !== this.version))
      throw new RequestError(503, "data_temporarily_unavailable", {
        reason: "warming",
        retryAfter: warmPolicy.retryAfter,
      });
    return this.version;
  }
  observeIdentity(value: string, reconnected = false) {
    if (this.identity === value) {
      // A network interruption can reconnect to the same postmaster after
      // bounded attempts exhausted. Only physical serving connections use
      // this flag; the warm connection must not schedule itself forever.
      if (reconnected && !this.ready && !this.active)
        this.invalidate("database_reconnected");
      return;
    }
    const previous = this.identity;
    this.identity = value;
    if (previous !== null) this.invalidate("database_restarted");
    else if (reconnected && !this.active) this.invalidate("database_connected");
    this.lastAttempt = -Infinity;
  }
  invalidate(reason: string) {
    this.ready = false;
    this.version++;
    this.lastAttempt = -Infinity;
    this.options.log?.({ event: "database_warming", reason });
    // Only the API schedules independently. The tip loop calls refresh in its
    // idle window, so an identity change cannot start reads beside its writes.
    if (this.timer)
      queueMicrotask(() => {
        void this.refresh();
      });
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.options.cadenceMs ?? warmPolicy.cadenceMs);
    this.timer.unref();
    void this.refresh();
  }
  refresh(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return Promise.resolve();
    if (this.active) return this.active;
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.lastAttempt = this.now();
    // Start on a microtask so active is installed before any callback can
    // invalidate the state and request another attempt.
    this.active = Promise.resolve()
      .then(async () => {
        for (
          let i = 0;
          i < (this.options.attempts ?? warmPolicy.attempts);
          i++
        ) {
          if (controller.signal.aborted) return;
          const version = this.version;
          let slow = false;
          try {
            await this.attempt({
              signal: controller.signal,
              identity: (value) => this.observeIdentity(value),
              slow: (name) => {
                if (!slow) this.invalidate(`slow_${name}`);
                slow = true;
              },
            });
            if (
              !controller.signal.aborted &&
              !slow &&
              this.identity !== null &&
              version === this.version
            ) {
              this.ready = true;
              this.lastAttempt = this.now();
              this.options.log?.({ event: "database_warm", attempt: i + 1 });
              return;
            }
          } catch {
            if (controller.signal.aborted) return;
            this.invalidate("warm_read_failed");
          }
          if (i + 1 < (this.options.attempts ?? warmPolicy.attempts))
            await sleep(this.options.retryMs ?? warmPolicy.retryMs, undefined, {
              signal: controller.signal,
            }).catch(() => {});
        }
        // Bounded attempts never fail open. A later cadence retries the set.
        this.lastAttempt = this.now();
        this.options.log?.({ event: "database_warm_attempts_exhausted" });
      })
      .finally(() => {
        // Indexing can pre-empt an idle attempt. An unfinished set must be
        // retried in the next idle window, not treated as five minutes of warmth.
        if (controller.signal.aborted) this.lastAttempt = -Infinity;
        signal?.removeEventListener("abort", abort);
        this.active = null;
        this.controller = null;
      });
    return this.active;
  }
  cancel() {
    this.controller?.abort();
  }
  async close() {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cancel();
    await this.active;
  }
}
