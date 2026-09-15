export const RECENT_TIMEOUT_MS = 120000;
export const RECENT_MAX_REQUESTS = 300;

/** Grow only after sustained spare capacity, never from partial catch-up batches. */
export function recentBatchSuccess(input: {
  batchBlocks: number;
  maxBlocks: number;
  goodCycles: number;
  advanced: number;
  elapsedMs: number;
  httpRequests: number;
}) {
  const headroom =
    input.advanced === input.batchBlocks &&
    input.elapsedMs <= RECENT_TIMEOUT_MS * 0.375 &&
    input.httpRequests <= RECENT_MAX_REQUESTS / 3;
  const goodCycles = headroom ? input.goodCycles + 1 : 0;
  return goodCycles >= 5
    ? {
        batchBlocks: Math.min(input.maxBlocks, input.batchBlocks * 2),
        goodCycles: 0,
      }
    : { batchBlocks: input.batchBlocks, goodCycles };
}

/** Split only deterministic work budgets, never credentials, invalid evidence or
 * transient transport failures. Durable cursors make smaller retries contiguous. */
export function smallerRecentBatch(error: unknown, blocks: number) {
  const message = error instanceof Error ? error.message : "";
  if (
    /^(Recent batch exceeds 10000 logs|Recent evidence exceeds budget|Catalog batch exceeds 250 launches;|Collection budget exceeded after [0-9]+ HTTP requests and [0-9]+ RPC calls)/.test(
      message,
    )
  )
    return Math.max(10, Math.floor(blocks / 2));
  return blocks;
}
