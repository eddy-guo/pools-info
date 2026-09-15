import { RpcResponseCapacity } from "@pools/chain";

/** 1000 blocks is the verified operational limit, independent of DTO capacity. */
export const BROAD_MAX_BLOCKS = 1000;
// Bound each catch-up attempt before main checks discovery again. These are
// collection limits, not a provider quota or an estimate of billed work.
export const BROAD_RPC_TIMEOUT_MS = 30000;
export const BROAD_RPC_MAX_REQUESTS = 100;
export function broadBatchBlocks(
  value = process.env.INDEXER_BROAD_BATCH_BLOCKS,
) {
  const blocks = Number(value ?? BROAD_MAX_BLOCKS);
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > BROAD_MAX_BLOCKS)
    throw Error("Invalid INDEXER_BROAD_BATCH_BLOCKS");
  return blocks;
}
export function isBroadCapacity(error: unknown) {
  return (
    error instanceof BroadRangeCapacity ||
    error instanceof RpcResponseCapacity ||
    (error instanceof Error &&
      /^(Broad event group exceeds capacity; split the range|Collection budget exceeded after [0-9]+ HTTP requests and [0-9]+ RPC calls)$/.test(
        error.message,
      ))
  );
}
export class BroadRangeCapacity extends Error {
  constructor(
    message: string,
    readonly from: number,
    readonly to: number,
  ) {
    super(message);
    this.name = "BroadRangeCapacity";
  }
}
export class BroadSingleBlockOverflow extends Error {
  constructor(readonly block: number | null) {
    super("Broad single-block range exceeds capacity; stop before resuming");
    this.name = "BroadSingleBlockOverflow";
  }
}
/** Split only the whole uncommitted range. Evidence/source failures and sustained
 * throttling retain their types and never trigger smaller-range retries. */
export class BroadBatchBudget {
  private blocks: number;
  private successes = 0;
  constructor(private readonly maximum: number) {
    this.blocks = broadBatchBlocks(String(maximum));
  }
  async run<T extends { advanced: number; rpcCalls: number }>(
    attempt: (blocks: number) => Promise<T>,
    options: {
      signal?: AbortSignal;
      onReduce?: (previous: number, next: number) => void;
    } = {},
  ): Promise<T | null> {
    options.signal?.throwIfAborted();
    try {
      const result = await attempt(this.blocks);
      this.successes =
        result.advanced === this.blocks && result.rpcCalls <= 100
          ? this.successes + 1
          : 0;
      if (this.successes >= 5) {
        this.blocks = Math.min(this.maximum, this.blocks * 2);
        this.successes = 0;
      }
      return result;
    } catch (error) {
      this.successes = 0;
      if (!isBroadCapacity(error) || options.signal?.aborted) throw error;
      const width =
        error instanceof BroadRangeCapacity
          ? error.to - error.from + 1
          : this.blocks;
      if (width === 1 || this.blocks === 1)
        throw new BroadSingleBlockOverflow(
          error instanceof BroadRangeCapacity ? error.from : null,
        );
      const previous = this.blocks;
      this.blocks = Math.max(1, Math.floor(Math.min(width, this.blocks) / 2));
      options.onReduce?.(previous, this.blocks);
      // No RPC retry here: discovery gets the next main cycle first.
      return null;
    }
  }
}
