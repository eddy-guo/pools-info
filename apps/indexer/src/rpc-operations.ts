import {
  HyperSyncPageCapacity,
  HyperSyncRateLimitExhausted,
  HyperSyncUnauthorized,
  RpcRateLimitExhausted,
  type RpcRateLimitEvent,
} from "@pools/chain";
import { BroadSingleBlockOverflow } from "./broad-budget";

// Process-local and deliberately sticky. A failed DB close must not replace a
// known capacity stop with exit1 and restart the whole Railway service.
let rateLimitStopped = false;
let broadCapacityStopped = false;
let hypersyncPageCapacityStopped = false;
let hypersyncUnauthorizedStopped = false;

export function rpcRateLimitObserver(worker: "main" | "recent" | "analytics") {
  return (event: RpcRateLimitEvent) => {
    if (event.attempt >= 4) rateLimitStopped = true;
    console.error(
      JSON.stringify({ event: "rpc_rate_limited", worker, ...event }),
    );
  };
}

const exhausted = (error: unknown) =>
  error instanceof RpcRateLimitExhausted ||
  error instanceof HyperSyncRateLimitExhausted;
/** A fresh client, smaller batch or pool fallback must not restart exhausted
 * work. HyperSync's sustained 429s stop the live worker the same way. */
export function throwIfRateLimitExhausted(error: unknown): void {
  if (exhausted(error)) {
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

/** A HyperSync page over its own caps is the same shape of indivisible-range
 * stop as the broad worker's; it also survives a database-close failure. */
export function throwIfHyperSyncPageCapacity(error: unknown): void {
  if (error instanceof HyperSyncPageCapacity) {
    hypersyncPageCapacityStopped = true;
    throw error;
  }
}

/** A rejected token cannot recover by restarting; sticky for the same reason
 * as the other reserved stops. */
export function throwIfHyperSyncUnauthorized(error: unknown): void {
  if (error instanceof HyperSyncUnauthorized) {
    hypersyncUnauthorizedStopped = true;
    throw error;
  }
}

/** service.ts maps these reserved exits to a clean, non-restarting stop:
 * 75 an exhausted RPC or HyperSync rate limit, 76 an indivisible range (the
 * broad worker's single-block overflow, or a HyperSync page over its own
 * caps), 77 a HyperSync token Envio rejected. */
export function workerFailureExitCode(error: unknown): number {
  if (rateLimitStopped || exhausted(error)) return 75;
  if (hypersyncUnauthorizedStopped || error instanceof HyperSyncUnauthorized)
    return 77;
  return broadCapacityStopped ||
    hypersyncPageCapacityStopped ||
    error instanceof BroadSingleBlockOverflow ||
    error instanceof HyperSyncPageCapacity
    ? 76
    : 1;
}
