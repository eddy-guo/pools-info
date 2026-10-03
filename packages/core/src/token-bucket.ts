/**
 * Per-key token buckets with a bounded key set: the fairness primitive the
 * read API and the website's product proxy share. Each key starts full and
 * refills continuously up to its capacity; a request that costs more than the
 * key holds is refused with the whole seconds until the refill covers it, and
 * spends nothing. The least recently seen key is dropped once the set is
 * full, so the memory a stranger can make this hold is fixed. Keys are never
 * reported back; callers keep them out of logs and responses.
 */
export interface TokenBucketPolicy {
  /** Tokens a fresh or long-idle key holds: the burst it may spend at once. */
  capacity: number;
  /** Tokens a key regains per second, up to the capacity. */
  refillPerSecond: number;
  /** Keys tracked at once. */
  maxKeys: number;
}
export type TokenBucketAnswer =
  { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };
export interface TokenBuckets {
  /** Spends `cost` tokens of `key` if it holds them; a refusal spends nothing. */
  take(key: string, cost: number): TokenBucketAnswer;
  /** Returns tokens a tracked key was charged for work it never received. */
  refund(key: string, tokens: number): void;
  /** Keys tracked right now. */
  readonly size: number;
}
export function createTokenBuckets(
  policy: TokenBucketPolicy,
  now: () => number = Date.now,
): TokenBuckets {
  const { capacity, refillPerSecond, maxKeys } = policy;
  if (!(capacity > 0) || !(refillPerSecond > 0) || !(maxKeys >= 1))
    throw Error("Token bucket policy must be positive");
  // Insertion order is recency: a touched key is re-inserted at the end and
  // the first key is the one dropped.
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key, cost) {
      if (!(cost >= 0)) throw Error("Token cost must be non-negative");
      const at = now();
      let bucket = buckets.get(key);
      if (bucket) {
        buckets.delete(key);
        // A clock that steps backwards refills nothing rather than debiting.
        const elapsed = Math.max(0, at - bucket.at) / 1000;
        bucket.tokens = Math.min(
          capacity,
          bucket.tokens + elapsed * refillPerSecond,
        );
        bucket.at = at;
      } else {
        while (buckets.size >= maxKeys)
          buckets.delete(buckets.keys().next().value!);
        bucket = { tokens: capacity, at };
      }
      buckets.set(key, bucket);
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost;
        return { ok: true, remaining: bucket.tokens };
      }
      // Whole seconds until the refill covers the shortfall; the epsilon keeps
      // a quotient like 6.000000000000001 from rounding up to a seventh second.
      return {
        ok: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((cost - bucket.tokens) / refillPerSecond - 1e-9),
        ),
      };
    },
    refund(key, tokens) {
      const bucket = buckets.get(key);
      if (bucket) bucket.tokens = Math.min(capacity, bucket.tokens + tokens);
    },
    get size() {
      return buckets.size;
    },
  };
}
