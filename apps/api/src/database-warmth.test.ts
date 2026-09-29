import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseWarmth, type WarmAttempt } from "./database-warmth";
import { RequestError } from "./request";
import { warmCreators } from "./warm-set";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const warming = (state: DatabaseWarmth, generation?: number) =>
  assert.throws(
    () => state.assertReady(generation),
    (e: unknown) =>
      e instanceof RequestError &&
      e.status === 503 &&
      e.reason === "warming" &&
      e.retryAfter === 5,
  );

test("startup refuses; only a complete fast set permits serving; restart invalidates old results", async () => {
  const gate = deferred();
  let identity = "first";
  const state = new DatabaseWarmth(async (c) => {
    c.identity(identity);
    await gate.promise;
  });
  warming(state);
  const run = state.refresh();
  assert.equal(state.refresh(), run, "parallel requests share one warm run");
  warming(state);
  gate.resolve();
  await run;
  const version = state.assertReady();
  state.observeIdentity("first");
  assert.equal(state.assertReady(), version);
  identity = "second";
  state.observeIdentity(identity);
  warming(state);
  await state.refresh();
  state.assertReady();
  warming(state, version);
  await state.close();
  warming(state);
});

test("creators warming visits every directory selection before the gate opens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const seen: string[] = [];
  const state = new DatabaseWarmth(async (context) => {
    context.identity("db");
    await warmCreators(
      async (path) => {
        seen.push(path);
        if (path.endsWith("window=All&sort=launches&offset=0&limit=25"))
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
      },
      async (_name, read) => read(),
    );
  });
  t.after(() => state.close());
  const run = state.refresh();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const expected = ["24h", "7d", "30d", "All"].flatMap((window) =>
    ["launches", "volume", "median"].flatMap((sort) =>
      (window === "All" ? [25, 50, 100] : [25]).map(
        (limit) =>
          `/v1/creators?window=${window}&sort=${sort}&offset=0&limit=${limit}`,
      ),
    ),
  );
  assert.deepEqual([...seen].sort(), expected.sort());
  warming(state);
  t.mock.timers.tick(1);
  await run;
  state.assertReady();
});

test("cadence detects ordinary eviction, fails closed after bounded retries, and recovers", async () => {
  let now = 0,
    mode: "fast" | "slow" | "failed" = "fast",
    calls = 0;
  const state = new DatabaseWarmth(
    async (c) => {
      calls++;
      c.identity("same-start-time");
      if (mode === "slow") c.slow("screener");
      if (mode === "failed") throw Error("read failed");
    },
    { now: () => now, retryMs: 0 },
  );
  await state.refresh();
  assert.equal(state.due, false);
  now = 300_000;
  assert.equal(state.due, true);
  mode = "slow";
  await state.refresh();
  assert.equal(calls, 4);
  warming(state);
  mode = "failed";
  await state.refresh();
  assert.equal(calls, 7);
  warming(state);
  mode = "fast";
  await state.refresh();
  state.assertReady();
  await state.close();
});

test("invalidation during an attempt cannot publish readiness; cycle cancellation leaves warming due", async () => {
  const entered = deferred(),
    release = deferred();
  let context!: WarmAttempt;
  const state = new DatabaseWarmth(
    async (c) => {
      context = c;
      c.identity("first");
      entered.resolve();
      await release.promise;
    },
    { attempts: 1 },
  );
  const run = state.refresh();
  await entered.promise;
  state.invalidate("product_statement_cancelled");
  release.resolve();
  await run;
  warming(state);
  const idle = new AbortController();
  const second = state.refresh(idle.signal);
  await Promise.resolve();
  idle.abort();
  await second;
  assert.equal(context.signal.aborted, true);
  assert.equal(state.due, true);
  warming(state);
  await state.close();
});

test("startup and periodic warm attempts run automatically without visitor traffic", async (t) => {
  const visited = deferred();
  let calls = 0;
  const state = new DatabaseWarmth(
    async (c) => {
      c.identity("database");
      if (++calls === 2) visited.resolve();
    },
    { cadenceMs: 20 },
  );
  t.after(() => state.close());
  state.start();
  // Keep the event loop alive while the production timer remains unref'd.
  const timeout = setTimeout(
    () => visited.reject(Error("cadence did not run")),
    1000,
  );
  try {
    await visited.promise;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(calls, 2);
  state.assertReady();
});

test("a physical reconnect to the same database retries exhausted startup warming without waiting for cadence", async (t) => {
  let fail = true;
  let calls = 0;
  const state = new DatabaseWarmth(
    async (c) => {
      calls++;
      c.identity("same-postmaster");
      if (fail) throw Error("network unavailable");
    },
    { attempts: 1 },
  );
  t.after(() => state.close());
  state.start();
  await state.refresh();
  assert.equal(calls, 1);
  warming(state);
  fail = false;
  state.observeIdentity("same-postmaster", true);
  await state.refresh();
  assert.equal(calls, 2);
  state.assertReady();
});

test("a restart that refuses connections reopens the gate within seconds of the database accepting, not at the next cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const flush = () => new Promise<void>((done) => setImmediate(done));
  const settle = async () => {
    for (let i = 0; i < 10; i++) await flush();
  };
  let identity = "before-restart",
    acceptsAt = 0,
    calls = 0,
    inFlight = 0,
    overlapping = false;
  const events: Record<string, unknown>[] = [];
  const state = new DatabaseWarmth(
    async (c) => {
      calls++;
      overlapping ||= ++inFlight > 1;
      try {
        await flush();
        if (Date.now() < acceptsAt)
          throw Object.assign(Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        c.identity(identity);
      } finally {
        inFlight--;
      }
    },
    { log: (event) => events.push({ at: Date.now(), ...event }) },
  );
  t.after(() => state.close());
  state.start();
  await settle();
  state.assertReady();

  // Postmaster stops at 60 s and accepts again 8 s later with a new identity.
  t.mock.timers.tick(60_000);
  acceptsAt = 68_000;
  identity = "after-restart";
  const before = calls;
  state.invalidate("database_disconnected");
  let reopenedAt: number | null = null;
  for (let at = 60_000; at < 5 * 60_000 && reopenedAt === null; at += 100) {
    await settle();
    try {
      state.assertReady();
      reopenedAt = Date.now();
    } catch {
      warming(state);
      t.mock.timers.tick(100);
    }
  }
  assert.ok(reopenedAt !== null, "the gate reopened before the cadence");
  assert.ok(
    reopenedAt - acceptsAt <= 5_000,
    `reopened ${reopenedAt - acceptsAt} ms after the database accepted`,
  );
  assert.equal(overlapping, false, "one warm attempt in flight at a time");
  // Two refused sets of three attempts (1 s, 2 s back-off), then the next
  // set warms: bounded, not a retry storm.
  assert.ok(calls - before <= 10, `${calls - before} attempts`);
  const retries = events
    .filter((e) => e.event === "database_warm_attempts_exhausted")
    .map((e) => e.retryMs);
  assert.deepEqual(retries, [1000, 2000, 4000].slice(0, retries.length));
  assert.ok(retries.length >= 2);

  // Once warm, the back-off resets and the five-minute keep-warm cadence holds.
  const warmCalls = calls;
  t.mock.timers.tick(5 * 60_000 - 1);
  await settle();
  assert.equal(calls, warmCalls);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls, warmCalls + 1);
  state.assertReady();
});

test("failed sets back off from one second to a five-second ceiling", async () => {
  const state = new DatabaseWarmth(
    async () => {
      throw Error("connect ECONNREFUSED");
    },
    { now: () => 0, attempts: 1 },
  );
  const delays = [];
  for (let i = 0; i < 6; i++) {
    await state.refresh();
    delays.push(state.delayMs);
    warming(state);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 5000, 5000, 5000]);
  await state.close();
});
