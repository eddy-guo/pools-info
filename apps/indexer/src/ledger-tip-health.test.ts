import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { LedgerTipHealth, serveLedgerTipHealth } from "./ledger-tip-health";
import type { LedgerTipCycle } from "./ledger-tip";

const cycle = (n: number): LedgerTipCycle => ({
  head: 75000000 + n * 800 + 128,
  headTimestamp: 1790000000 + n * 80 + 13,
  cursor: 75000000 + n * 800,
  cursorTimestamp: 1790000000 + n * 80,
  lagBlocks: 128,
  lagSeconds: 13,
  range: null,
  atTip: true,
  crowd: null,
  windows: null,
  requests: 3,
  bytes: 0,
  sentBytes: 0,
  elapsedMs: 4000,
});
const minute = 60000;

test("the report follows the loop: starting steps, cycles, retries, stops, and 503 once the last cycle is older than the threshold", () => {
  let now = 1_790_000_000_000;
  const health = new LedgerTipHealth({ staleMs: 10 * minute, now: () => now });
  // Starting: fresh for the threshold measured from the process start, so a
  // deploy's healthcheck passes while this instance waits for the lock.
  health.starting("locking");
  now += 3 * minute;
  let r = health.report();
  assert.deepEqual(
    [r.ok, r.state, r.step, r.stale, r.uptimeSeconds, r.lastCycleAt, r.cursor],
    [true, "starting", "locking", false, 180, null, null],
  );
  now += 8 * minute;
  r = health.report();
  assert.deepEqual([r.ok, r.state, r.stale], [false, "starting", true]);
  // A committed cycle: cycling, its figures, fresh again.
  health.cycle(cycle(1));
  now += 90_000;
  r = health.report();
  assert.deepEqual(
    [
      r.ok,
      r.state,
      r.step,
      r.cycles,
      r.sinceLastCycleSeconds,
      r.head,
      r.cursor,
      r.cursorTimestamp,
      r.lagBlocks,
      r.lagSeconds,
      r.atTip,
      r.staleAfterSeconds,
    ],
    [
      true,
      "cycling",
      null,
      1,
      90,
      75000928,
      75000800,
      1790000080,
      128,
      13,
      true,
      600,
    ],
  );
  assert.equal(r.lastCycleAt, new Date(now - 90_000).toISOString());
  // A later starting step is ignored once the loop cycles.
  health.starting("migrating");
  assert.equal(health.report().step, null);
  // Failed cycles: retrying with the back-off and the fixed error text, still
  // 200 until the last committed cycle goes stale.
  health.failed({
    failures: 1,
    waitMs: 2000,
    error: "network_failed: ECONNREFUSED",
  });
  health.failed({
    failures: 2,
    waitMs: 4000,
    error: "network_failed: ECONNREFUSED",
  });
  r = health.report();
  assert.deepEqual(
    [r.ok, r.state, r.failures, r.waitMs, r.error, r.cursor],
    [true, "retrying", 2, 4000, "network_failed: ECONNREFUSED", 75000800],
  );
  now += 10 * minute;
  r = health.report();
  assert.deepEqual([r.ok, r.stale, r.state], [false, true, "retrying"]);
  // Exactly the threshold is still fresh; one millisecond past it is not.
  health.cycle(cycle(2));
  now += 10 * minute;
  assert.equal(health.report().ok, true);
  now += 1;
  assert.equal(health.report().ok, false);
  // A recovery clears the failure fields.
  health.cycle(cycle(3));
  r = health.report();
  assert.deepEqual(
    [r.ok, r.state, r.cycles, r.failures, r.waitMs, r.error],
    [true, "cycling", 3, 0, null, null],
  );
  // A stop is 503 at once, with the exit code the service will use, and no
  // later observation changes it.
  health.stopped(
    "throttled",
    "hypersync_rate_limit_exhausted: the tip loop stopped",
  );
  health.cycle(cycle(4));
  health.failed({ failures: 1, waitMs: 2000, error: "x" });
  r = health.report();
  assert.deepEqual(
    [r.ok, r.state, r.stopped, r.exitCode, r.error, r.cycles, r.stale],
    [
      false,
      "stopped",
      "throttled",
      75,
      "hypersync_rate_limit_exhausted: the tip loop stopped",
      3,
      false,
    ],
  );
  assert.equal(new LedgerTipHealth({ staleMs: 1000 }).report().ok, true);
  assert.throws(
    () => new LedgerTipHealth({ staleMs: 0 }),
    /Invalid LEDGER_STALE_MS/,
  );
});

test("the listener answers GET and HEAD /health with the report's status, refuses other paths and methods, and reports a port it cannot bind", async (t) => {
  let now = 1_790_000_000_000;
  const health = new LedgerTipHealth({ staleMs: 10 * minute, now: () => now });
  const events: Record<string, unknown>[] = [];
  const server = await serveLedgerTipHealth(health, {
    port: 0,
    host: "127.0.0.1",
    log: (e) => events.push(e),
  });
  assert.ok(server);
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const port = (server.address() as { port: number }).port;
  assert.deepEqual(
    [...events],
    [{ event: "ledger_tip_health_listening", port }],
  );
  const base = `http://127.0.0.1:${port}`;
  health.cycle(cycle(1));
  let response = await fetch(base + "/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  let body = await response.json();
  assert.deepEqual(
    [body.ok, body.state, body.cursor, body.head, body.lagBlocks],
    [true, "cycling", 75000800, 75000928, 128],
  );
  now += 11 * minute;
  response = await fetch(base + "/health?probe=1");
  assert.equal(response.status, 503);
  body = await response.json();
  assert.deepEqual(
    [body.ok, body.stale, body.sinceLastCycleSeconds],
    [false, true, 660],
  );
  const head = await fetch(base + "/health", { method: "HEAD" });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(base + "/")).status, 404);
  assert.equal((await fetch(base + "/ready")).status, 404);
  const post = await fetch(base + "/health", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  // A taken port is logged and reported, never thrown.
  const taken = createServer();
  taken.listen(0, "127.0.0.1");
  await once(taken, "listening");
  t.after(() => taken.close());
  const takenPort = (taken.address() as { port: number }).port;
  events.length = 0;
  assert.equal(
    await serveLedgerTipHealth(health, {
      port: takenPort,
      host: "127.0.0.1",
      log: (e) => events.push(e),
    }),
    null,
  );
  assert.deepEqual(
    [...events],
    [
      {
        event: "ledger_tip_health_unavailable",
        port: takenPort,
        code: "EADDRINUSE",
      },
    ],
  );
});
