import { RpcRateLimitExhausted, type RpcRateLimitEvent } from "@pools/chain";
import { BroadSingleBlockOverflow } from "./broad-budget";

// Process-local and deliberately sticky. A failed DB close must not replace a
// known capacity stop with exit1 and restart the whole Railway service.
let rateLimitStopped = false;
let broadCapacityStopped = false;

export function rpcRateLimitObserver(worker: "main" | "recent" | "analytics") {
  return (event: RpcRateLimitEvent) => {
    if (event.attempt >= 4) rateLimitStopped = true;
    console.error(
      JSON.stringify({ event: "rpc_rate_limited", worker, ...event }),
    );
  };
}

/** A fresh client, smaller batch or pool fallback must not restart exhausted work. */
export function throwIfRateLimitExhausted(error: unknown): void {
  if (error instanceof RpcRateLimitExhausted) {
    rateLimitStopped = true;
    throw error;
  }
}

/** A one-block capacity stop also survives a database-close failure. */
export function throwIfBroadCapacityOverflow(error: unknown): void {
  if (error instanceof BroadSingleBlockOverflow) {
    broadCapacityStopped = true;
    console.error(
      JSON.stringify({
        event: "broad_single_block_overflow",
        block: error.block,
      }),
    );
    throw error;
  }
}

/** service.ts maps this reserved exit to a clean, non-restarting stop. */
export function workerFailureExitCode(error: unknown): number {
  if (rateLimitStopped || error instanceof RpcRateLimitExhausted) return 75;
  return broadCapacityStopped || error instanceof BroadSingleBlockOverflow
    ? 76
    : 1;
}
