import { RpcRateLimitExhausted, type RpcRateLimitEvent } from "@pools/chain";

// Process-local and deliberately sticky. A failed DB close must not replace a
// known capacity stop with exit1 and restart the whole Railway service.
let rateLimitStopped = false;

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

/** service.ts maps this reserved exit to a clean, non-restarting stop. */
export function workerFailureExitCode(error: unknown): number {
  return rateLimitStopped || error instanceof RpcRateLimitExhausted ? 75 : 1;
}
