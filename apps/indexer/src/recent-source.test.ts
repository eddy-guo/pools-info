import test from "node:test";
import assert from "node:assert/strict";
import {
  HyperSyncBudgetExceeded,
  HyperSyncPacer,
  HyperSyncRateLimitExhausted,
  HyperSyncUnauthorized,
} from "@pools/chain";
import { FakeHyperSync } from "@pools/chain/testing";
import {
  RecentGapProgress,
  recentHyperSyncClient,
  recentHyperSyncDefaults,
  recentHyperSyncSafeError,
  recentSourceConfig,
} from "./recent-source";
import {
  throwIfRateLimitExhausted,
  workerFailureExitCode,
} from "./rpc-operations";

const token = "t".repeat(24);

test("RECENT_SOURCE defaults to the JSON-RPC cycle and accepts only rpc or hypersync", () => {
  assert.deepEqual(recentSourceConfig({}), {
    source: "rpc",
    defaultBatchBlocks: 1000,
  });
  assert.deepEqual(recentSourceConfig({ RECENT_SOURCE: "rpc" }), {
    source: "rpc",
    defaultBatchBlocks: 1000,
  });
  // The token is only required once HyperSync is selected.
  assert.equal(recentSourceConfig({ ENVIO_API_TOKEN: token }).source, "rpc");
  // A Railway variable created but left blank must default to rpc, not throw.
  for (const value of ["", "  "])
    assert.deepEqual(recentSourceConfig({ RECENT_SOURCE: value }), {
      source: "rpc",
      defaultBatchBlocks: 1000,
    });
  for (const value of ["HyperSync", "alchemy", "1"])
    assert.throws(
      () => recentSourceConfig({ RECENT_SOURCE: value }),
      /Invalid RECENT_SOURCE; expected rpc or hypersync/,
    );
  assert.throws(
    () => recentSourceConfig({ RECENT_SOURCE: "hypersync" }),
    /ENVIO_API_TOKEN is required for RECENT_SOURCE=hypersync/,
  );
  assert.throws(
    () =>
      recentSourceConfig({ RECENT_SOURCE: "hypersync", ENVIO_API_TOKEN: " " }),
    /ENVIO_API_TOKEN is required/,
  );
});

test("the HyperSync source paces at 30 requests per minute or slower and never faster", () => {
  const config = recentSourceConfig({
    RECENT_SOURCE: "hypersync",
    ENVIO_API_TOKEN: token,
  });
  assert.deepEqual(config, {
    source: "hypersync",
    defaultBatchBlocks: 2000,
    url: "https://4663.hypersync.xyz",
    token,
    minIntervalMs: 2000,
    maxPages: 4,
    maxRequestsPerCycle: 300,
  });
  assert.equal(60000 / recentHyperSyncDefaults.minIntervalMs, 30);
  const env = { RECENT_SOURCE: "hypersync", ENVIO_API_TOKEN: token };
  const slower = recentSourceConfig({
    ...env,
    RECENT_HYPERSYNC_MIN_INTERVAL_MS: "5000",
    RECENT_HYPERSYNC_MAX_PAGES: "16",
  });
  assert.ok(slower.source === "hypersync");
  assert.equal(slower.minIntervalMs, 5000);
  assert.equal(slower.maxPages, 16);
  for (const value of ["1999", "1000", "0", "", "2.5", "60001"])
    assert.throws(
      () =>
        recentSourceConfig({ ...env, RECENT_HYPERSYNC_MIN_INTERVAL_MS: value }),
      /Invalid RECENT_HYPERSYNC_MIN_INTERVAL_MS/,
    );
  for (const value of ["0", "17", ""])
    assert.throws(
      () => recentSourceConfig({ ...env, RECENT_HYPERSYNC_MAX_PAGES: value }),
      /Invalid RECENT_HYPERSYNC_MAX_PAGES/,
    );
});

test("HYPERSYNC_URL is pinned to chain 4663's endpoint, with a loopback escape for tests", () => {
  const env = { RECENT_SOURCE: "hypersync", ENVIO_API_TOKEN: token };
  for (const url of [
    "https://4663.hypersync.xyz",
    "http://127.0.0.1:1",
    "http://localhost:1",
  ]) {
    const config = recentSourceConfig({ ...env, HYPERSYNC_URL: url });
    assert.ok(config.source === "hypersync");
    assert.equal(config.url, url);
  }
  for (const url of [
    "https://1.hypersync.xyz",
    "https://eth.hypersync.xyz",
    "https://evil.example/4663.hypersync.xyz",
    "not-a-url",
  ])
    assert.throws(
      () => recentSourceConfig({ ...env, HYPERSYNC_URL: url }),
      /HYPERSYNC_URL/,
    );
});

test("per-cycle clients share one pacer, so spacing and the cycle budget hold across cycles", async () => {
  const config = recentSourceConfig({
    RECENT_SOURCE: "hypersync",
    ENVIO_API_TOKEN: token,
    HYPERSYNC_URL: "http://127.0.0.1:1",
  });
  if (config.source !== "hypersync") throw Error("expected hypersync");
  const fake = new FakeHyperSync({ height: 1000 });
  // A short interval keeps the test fast; production's floor is 2,000 ms.
  const fast = { ...config, minIntervalMs: 40, maxRequestsPerCycle: 2 };
  const pacer = new HyperSyncPacer();
  // The pacer is one interval past a request's scheduled start when it leaves.
  const sent: { scheduled: number; at: number }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push({ scheduled: pacer.nextRequestAt - 40, at: Date.now() });
    return fake.fetch(input, init);
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    const client = recentHyperSyncClient(fast, pacer, { fetch });
    await client.height();
    await client.height();
    await assert.rejects(client.height(), HyperSyncBudgetExceeded);
    assert.equal(client.requests, 2);
  }
  assert.equal(sent.length, 6);
  for (const [i, request] of sent.entries()) {
    assert.ok(request.at >= request.scheduled - 1, `request ${i} left early`);
    if (i)
      assert.ok(request.scheduled - sent[i - 1].scheduled >= 40, `gap ${i}`);
  }
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${token}`);
});

test("gap-fill progress reports the gap once, its rate and remaining blocks per batch, and its totals at the confirmed tip", () => {
  let now = 0;
  const gap = new RecentGapProgress(() => now);
  const batch = (through: number, head = 10127, advanced = 2000) => ({
    head,
    through,
    advanced,
    batchBlocks: 2000,
    requests: 4,
    minIntervalMs: 2000,
  });
  // A tip cycle within one batch of the confirmed tip is not a gap.
  assert.equal(gap.observe(batch(9899, 10127, 300)), null);
  assert.equal(gap.observe({ ...batch(0), through: null }), null);
  assert.deepEqual(gap.observe(batch(1999)), {
    event: "recent_gap_fill",
    phase: "started",
    gapBlocks: 10000,
    remainingBlocks: 8000,
    estimatedBatches: 4,
    minimumMinutes: 1,
  });
  now = 8000;
  assert.deepEqual(gap.observe(batch(3999)), {
    event: "recent_gap_fill",
    phase: "progress",
    gapBlocks: 10000,
    remainingBlocks: 6000,
    blocks: 4000,
    batches: 2,
    requests: 8,
    elapsedMs: 8000,
    blocksPerSecond: 500,
    etaSeconds: 12,
  });
  now = 32000;
  gap.observe(batch(5999));
  gap.observe(batch(7999));
  assert.deepEqual(gap.observe(batch(9999)), {
    event: "recent_gap_fill",
    phase: "complete",
    gapBlocks: 10000,
    blocks: 10000,
    batches: 5,
    requests: 20,
    elapsedMs: 32000,
  });
  // The next tip cycle is quiet again.
  assert.equal(gap.observe(batch(10299, 10427, 300)), null);
});

test("HyperSync failures map to fixed descriptions, and sustained throttling stops the worker without a restart", () => {
  assert.match(
    recentHyperSyncSafeError(new HyperSyncUnauthorized(401)),
    /^hypersync_unauthorized:/,
  );
  assert.match(
    recentHyperSyncSafeError(
      Error("HyperSync archive height below the confirmed cutoff"),
    ),
    /^hypersync_behind_confirmed_cutoff:/,
  );
  for (const message of [
    "Inconsistent HyperSync canonical headers",
    "Unexpected HyperSync recent source or range",
    "HyperSync recent rows disagree with retained evidence",
    "Invalid HyperSync unregistered pool ids",
    "HyperSync swap outside the resolved registry",
  ])
    assert.match(
      recentHyperSyncSafeError(Error(message)),
      /^recent_evidence_rejected:/,
      message,
    );
  assert.match(
    recentHyperSyncSafeError(
      Error("ENVIO_API_TOKEN is required for RECENT_SOURCE=hypersync"),
    ),
    /^recent_configuration_invalid:/,
  );
  assert.equal(workerFailureExitCode(Error("anything else")), 1);
  const throttled = new HyperSyncRateLimitExhausted();
  assert.match(
    recentHyperSyncSafeError(throttled),
    /^hypersync_rate_limit_exhausted: live worker stopped/,
  );
  assert.equal(workerFailureExitCode(throttled), 75);
  assert.throws(() => throwIfRateLimitExhausted(throttled), throttled);
  // Sticky for the process, like the JSON-RPC stop.
  assert.equal(workerFailureExitCode(Error("a later close failure")), 75);
});
