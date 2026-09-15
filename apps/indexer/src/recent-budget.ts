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
