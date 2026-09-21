import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseWarmth, type WarmAttempt } from "./database-warmth";
import { RequestError } from "./request";

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
