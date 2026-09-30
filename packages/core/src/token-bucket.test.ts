import assert from "node:assert/strict";
import test from "node:test";
import { createTokenBuckets, type TokenBucketAnswer } from "./token-bucket";

/** Fractional refills drift in the last binary digits; compare to a nanotoken. */
const settled = (answer: TokenBucketAnswer) =>
  answer.ok
    ? { ok: true, remaining: Math.round(answer.remaining * 1e9) / 1e9 }
    : answer;

test("a key spends its burst, refills continuously and names an accurate retry", () => {
  let now = 0;
  const buckets = createTokenBuckets(
    { capacity: 6, refillPerSecond: 0.1, maxKeys: 10 },
    () => now,
  );
  assert.deepEqual(settled(buckets.take("a", 4)), { ok: true, remaining: 2 });
  // 4 tokens short of a 6-token cost at 0.1 per second is 40 whole seconds.
  assert.deepEqual(settled(buckets.take("a", 6)), {
    ok: false,
    retryAfterSeconds: 40,
  });
  // A refusal spent nothing.
  assert.deepEqual(settled(buckets.take("a", 2)), { ok: true, remaining: 0 });
  assert.deepEqual(settled(buckets.take("a", 1)), {
    ok: false,
    retryAfterSeconds: 10,
  });
  now = 9999;
  assert.equal(buckets.take("a", 1).ok, false);
  now = 10000;
  assert.deepEqual(settled(buckets.take("a", 1)), { ok: true, remaining: 0 });
  // Refill never exceeds the capacity, and a free request is always admitted.
  now = 10000 + 3_600_000;
  assert.deepEqual(settled(buckets.take("a", 0)), { ok: true, remaining: 6 });
  // Time moving backwards refills nothing and debits nothing.
  now = 0;
  assert.deepEqual(settled(buckets.take("a", 6)), { ok: true, remaining: 0 });
  assert.deepEqual(settled(buckets.take("a", 1)), {
    ok: false,
    retryAfterSeconds: 10,
  });
});

test("keys are independent and the least recently seen is dropped past the bound", () => {
  const buckets = createTokenBuckets(
    { capacity: 2, refillPerSecond: 1, maxKeys: 2 },
    () => 0,
  );
  assert.equal(buckets.take("a", 2).ok, true);
  assert.equal(buckets.take("a", 1).ok, false);
  // Another key is untouched by a's exhaustion.
  assert.equal(buckets.take("b", 1).ok, true);
  assert.equal(buckets.size, 2);
  // Touching a makes b the least recent; a third key drops b, not a.
  assert.equal(buckets.take("a", 1).ok, false);
  assert.equal(buckets.take("c", 1).ok, true);
  assert.equal(buckets.size, 2);
  assert.equal(buckets.take("a", 1).ok, false);
  // b comes back as a fresh key with its whole burst, and drops c.
  assert.deepEqual(settled(buckets.take("b", 2)), { ok: true, remaining: 0 });
  assert.equal(buckets.size, 2);
});

test("a refund returns what a refused request was charged, never past the capacity", () => {
  const buckets = createTokenBuckets(
    { capacity: 5, refillPerSecond: 1, maxKeys: 2 },
    () => 0,
  );
  assert.equal(settled(buckets.take("a", 5)).ok, true);
  assert.equal(buckets.take("a", 1).ok, false);
  buckets.refund("a", 2);
  assert.deepEqual(settled(buckets.take("a", 2)), { ok: true, remaining: 0 });
  buckets.refund("a", 50);
  assert.deepEqual(settled(buckets.take("a", 5)), { ok: true, remaining: 0 });
  // An untracked key is not created by a refund.
  buckets.refund("b", 5);
  assert.equal(buckets.size, 1);
  // Ten tokens a minute is a sixth of a token each second: one token short is
  // six seconds, not the seventh a floating-point quotient would round up to.
  const slow = createTokenBuckets(
    { capacity: 10, refillPerSecond: 10 / 60, maxKeys: 1 },
    () => 0,
  );
  assert.equal(slow.take("a", 9).ok, true);
  assert.deepEqual(slow.take("a", 2), { ok: false, retryAfterSeconds: 6 });
});

test("a policy without a positive capacity, refill or bound is refused", () => {
  for (const policy of [
    { capacity: 0, refillPerSecond: 1, maxKeys: 1 },
    { capacity: 1, refillPerSecond: 0, maxKeys: 1 },
    { capacity: 1, refillPerSecond: 1, maxKeys: 0 },
    { capacity: NaN, refillPerSecond: 1, maxKeys: 1 },
  ])
    assert.throws(() => createTokenBuckets(policy), /positive/);
  assert.throws(
    () =>
      createTokenBuckets({ capacity: 1, refillPerSecond: 1, maxKeys: 1 }).take(
        "a",
        -1,
      ),
    /non-negative/,
  );
});
