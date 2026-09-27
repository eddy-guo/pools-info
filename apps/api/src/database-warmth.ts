import { RequestError } from "./request";

export const warmPolicy = Object.freeze({
  cadenceMs: 5 * 60_000,
  attempts: 3,
  retryMs: 1000,
  // A failed set is retried on a doubling back-off from retryMs up to this,
  // not a cadence later: a restarting database refuses connections for
  // seconds, and a closed gate refuses every read until the next set.
  retryMaxMs: 5000,
  statementMs: 10_000,
  attemptMs: 60_000,
  servingMs: 2800,
  retryAfter: 5,
});
/** Resolves after ms or on abort. It reads the global timer at call time,
 * so a test's fake clock drives the retries as it drives the back-off. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
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
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextAt = -Infinity;
  private failedSets = 0;

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
   * than adding an entire poll interval to the five-minute cadence. A set is
   * next due a cadence after it warms and a short back-off after it fails. */
  get delayMs() {
    return Math.max(0, this.nextAt - this.now());
  }
  private get cadenceMs() {
    return this.options.cadenceMs ?? warmPolicy.cadenceMs;
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
    // A new postmaster answering is the end of an outage: restart the
    // back-off so a set it failed is retried after a second, not five.
    this.failedSets = 0;
    if (previous !== null) this.invalidate("database_restarted");
    else if (reconnected && !this.active) this.invalidate("database_connected");
    this.nextAt = -Infinity;
  }
  invalidate(reason: string) {
    this.ready = false;
    this.version++;
    this.nextAt = -Infinity;
    this.options.log?.({ event: "database_warming", reason });
    // Only the API schedules independently. The tip loop calls refresh in its
    // idle window, so an identity change cannot start reads beside its writes.
    if (this.started)
      queueMicrotask(() => {
        void this.refresh();
      });
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.refresh();
  }
  /** The API arms its next set only once the current one has settled, at the
   * cadence or the back-off, so sets never overlap or queue behind each other. */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.stopped || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.delayMs);
    this.timer.unref();
  }
  refresh(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return Promise.resolve();
    if (this.active) return this.active;
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = this.now() + this.cadenceMs;
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
              this.failedSets = 0;
              this.nextAt = this.now() + this.cadenceMs;
              this.options.log?.({ event: "database_warm", attempt: i + 1 });
              return;
            }
          } catch {
            if (controller.signal.aborted) return;
            this.invalidate("warm_read_failed");
          }
          if (i + 1 < (this.options.attempts ?? warmPolicy.attempts))
            await pause(
              this.options.retryMs ?? warmPolicy.retryMs,
              controller.signal,
            );
        }
        // Bounded attempts never fail open. The gate stays closed and the
        // whole set is retried after 1 s, 2 s, 4 s, then every 5 s until warm.
        const retryMs = Math.min(
          (this.options.retryMs ?? warmPolicy.retryMs) *
            2 ** Math.min(this.failedSets, 16),
          warmPolicy.retryMaxMs,
        );
        this.failedSets++;
        this.nextAt = this.now() + retryMs;
        this.options.log?.({
          event: "database_warm_attempts_exhausted",
          retryMs,
        });
      })
      .finally(() => {
        // Indexing can pre-empt an idle attempt. An unfinished set must be
        // retried in the next idle window, not treated as five minutes of warmth.
        if (controller.signal.aborted) this.nextAt = -Infinity;
        signal?.removeEventListener("abort", abort);
        this.active = null;
        this.controller = null;
        this.schedule();
      });
    return this.active;
  }
  cancel() {
    this.controller?.abort();
  }
  async close() {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancel();
    await this.active;
  }
}
