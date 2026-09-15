import test from "node:test";
import assert from "node:assert/strict";
import { PoolBatchBudget } from "./pool-budget";
const exhausted = () =>
  Error("Collection budget exceeded after 122 HTTP requests and 291 RPC calls");

test("dense pools shrink, retain their hint, and do not resize unrelated pools", async () => {
  const budget = new PoolBatchBudget(1000);
  const sizes: number[] = [];
  const result = await budget.run(["pool:a"], async (size) => {
    sizes.push(size);
    if (size > 250) throw exhausted();
    return "committed";
  });
  assert.equal(result, "committed");
  assert.deepEqual(sizes, [1000, 500, 250]);
  assert.equal(await budget.run(["pool:a"], async (n) => n), 250);
  assert.equal(await budget.run(["pool:b"], async (n) => n), 1000);
  assert.equal(await budget.run(["pool:a", "pool:b"], async (n) => n), 250);
});

test("identity, transport, database and canonical failures never shrink or retry", async () => {
  for (const message of [
    "Wrong chain",
    "RPC HTTP 429",
    "RPC HTTP 403",
    "Inconsistent event receipt or canonical block",
    "Stale checkpoint or noncontiguous batch",
  ]) {
    let calls = 0;
    const budget = new PoolBatchBudget(1000);
    const error = Error(message);
    await assert.rejects(
      budget.run(["pool:a"], async () => {
        calls++;
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(calls, 1);
    assert.equal(await budget.run(["pool:a"], async (n) => n), 1000);
  }
});

test("splitting is bounded at one block and cancellation prevents another attempt", async () => {
  const sizes: number[] = [];
  await assert.rejects(
    new PoolBatchBudget(3).run(["pool:a"], async (size) => {
      sizes.push(size);
      throw exhausted();
    }),
    /Collection budget/,
  );
  assert.deepEqual(sizes, [3, 1]);
  const stop = new AbortController();
  let calls = 0;
  await assert.rejects(
    new PoolBatchBudget(10).run(
      ["pool:a"],
      async () => {
        calls++;
        stop.abort();
        throw exhausted();
      },
      { signal: stop.signal },
    ),
    /Collection budget/,
  );
  assert.equal(calls, 1);
});
