import { collectPoolEventGroup, type Rpc } from "@pools/chain";
import {
  broadRangeCheckpoint,
  broadStreamIdentity,
  commitPoolGroup,
  ensureBroadStream,
  markAttempt,
  resolveBroadPools,
  type Client,
} from "@pools/db";
import { canonicalHeader, reconcileStream } from "./checkpoints";
import {
  broadBatchBlocks,
  BroadBatchBudget,
  BroadRangeCapacity,
  isBroadCapacity,
} from "./broad-budget";
import { safeError, errorDetails } from "./errors";
import type { MeteredRpc, RpcMethodCounts } from "./rpc-telemetry";

export function broadV1Enabled(value = process.env.INDEXER_BROAD_V1_ENABLED) {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw Error("Invalid INDEXER_BROAD_V1_ENABLED; expected 0 or 1");
}
export interface BroadProgress {
  advanced: number;
  committed: boolean;
  behind: boolean;
  waitingForDiscovery: boolean;
  from: number;
  to: number;
  discoveryThroughBlock: number | null;
  observedSwaps: number;
  registeredSwaps: number;
  unsupportedSwaps: number;
  httpRequests: number;
  rpcCalls: number;
  methodCountsBeforeRetries: RpcMethodCounts | null;
  elapsedMs: number;
  lagBlocks: number;
}
export interface BroadDeferredProgress extends Omit<
  BroadProgress,
  | "from"
  | "to"
  | "observedSwaps"
  | "registeredSwaps"
  | "unsupportedSwaps"
  | "lagBlocks"
> {
  deferred: true;
  capacitySplits: number;
  from: null;
  to: null;
  attemptedFrom: number | null;
  attemptedTo: number | null;
  observedSwaps: null;
  registeredSwaps: null;
  unsupportedSwaps: null;
  lagBlocks: null;
}
/** One global range under main's existing writer lock. No deep finance or
 * discovery cursor mutation; only canonical broad reconciliation can rewind. */
export async function runBroadBatch(
  db: Client,
  rpc: Rpc,
  batchBlocks: number,
  signal?: AbortSignal,
): Promise<BroadProgress> {
  broadBatchBlocks(String(batchBlocks));
  const started = performance.now();
  let stage = "chain_check",
    from: number | null = null,
    to: number | null = null;
  const counters = () => ({
    httpRequests: rpc.requests,
    rpcCalls: rpc.calls,
    methodCountsBeforeRetries: (rpc as MeteredRpc).methodCounts ?? null,
    elapsedMs: Math.round(performance.now() - started),
  });
  try {
    signal?.throwIfAborted();
    if (Number(await rpc.call<string>("eth_chainId", [])) !== 4663)
      throw Error("Wrong chain");
    stage = "checkpoint_reconcile";
    const stream = await reconcileStream(db, await ensureBroadStream(db), rpc);
    stage = "head_read";
    const head = Number(await rpc.call<string>("eth_blockNumber", []));
    if (!Number.isSafeInteger(head) || head < 128)
      throw Error("Invalid chain head");
    const confirmed = head - 128;
    from = stream.cursor === null ? stream.start : stream.cursor + 1;
    to = Math.min(confirmed, from + batchBlocks - 1);
    const idle = (waitingForDiscovery: boolean): BroadProgress => ({
      advanced: 0,
      committed: false,
      behind: false,
      waitingForDiscovery,
      from: from!,
      to: to!,
      discoveryThroughBlock: null,
      observedSwaps: 0,
      registeredSwaps: 0,
      unsupportedSwaps: 0,
      ...counters(),
      lagBlocks: Math.max(0, confirmed - (stream.cursor ?? stream.start - 1)),
    });
    if (from > to) return idle(false);
    signal?.throwIfAborted();
    stage = "registry_pin";
    const range = await broadRangeCheckpoint(db, from, to);
    if (!range) return idle(true);
    to = range.toBlock;
    const { registry } = range;
    if (
      (await canonicalHeader(rpc, registry.throughBlock)).hash !==
      registry.blockHash
    )
      throw Error("Broad registry boundary changed");
    const first = await canonicalHeader(rpc, from);
    if (stream.hash && first.parentHash !== stream.hash)
      throw Error("Checkpoint parent changed");
    await markAttempt(db, stream.key);
    stage = "broad_collect";
    const group = await collectPoolEventGroup(
      {
        mode: "broad",
        fromBlock: from,
        toBlock: to,
        registry,
        resolvePools: (ids) => resolveBroadPools(db, ids, registry),
      },
      rpc,
    );
    signal?.throwIfAborted();
    stage = "broad_boundary_check";
    if (
      group.fromBlockParentHash !== first.parentHash ||
      (await canonicalHeader(rpc, from)).hash !== first.hash ||
      (await canonicalHeader(rpc, to)).hash !== group.blockHash ||
      (await canonicalHeader(rpc, registry.throughBlock)).hash !==
        registry.blockHash
    )
      throw Error("Broad boundary changed during collection");
    signal?.throwIfAborted();
    stage = "broad_commit";
    const committed = await commitPoolGroup(db, {
      mode: "broad",
      expected: stream,
      group,
    });
    return {
      advanced: committed ? to - from + 1 : 0,
      committed,
      behind: to < confirmed,
      waitingForDiscovery: false,
      from,
      to,
      discoveryThroughBlock: registry.throughBlock,
      observedSwaps: group.observedSwaps,
      registeredSwaps: group.swaps.length,
      unsupportedSwaps: group.unsupportedSwaps,
      ...counters(),
      lagBlocks: Math.max(0, confirmed - to),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "broad_operation_failed",
        stream: broadStreamIdentity.key,
        stage,
        from,
        to,
        ...counters(),
        error: safeError(error),
        ...errorDetails(error),
      }),
    );
    if (isBroadCapacity(error) && from !== null && to !== null && from <= to)
      throw new BroadRangeCapacity((error as Error).message, from, to);
    throw error;
  }
}
/** Default-off must not construct an RPC client or create a broad stream. Each
 * successful run commits at most one range before main checks discovery again. */
export class BroadScheduler {
  readonly enabled: boolean;
  readonly maximumBlocks: number | null;
  private readonly budget?: BroadBatchBudget;
  constructor(
    enabled = process.env.INDEXER_BROAD_V1_ENABLED,
    batchBlocks = process.env.INDEXER_BROAD_BATCH_BLOCKS,
  ) {
    this.enabled = broadV1Enabled(enabled);
    this.maximumBlocks = this.enabled ? broadBatchBlocks(batchBlocks) : null;
    if (this.maximumBlocks !== null)
      this.budget = new BroadBatchBudget(this.maximumBlocks);
  }
  async run(
    db: Client,
    createRpc: () => Rpc,
    options: {
      signal?: AbortSignal;
      onReduce?: (previous: number, next: number) => void;
    } = {},
  ): Promise<
    | (BroadProgress & { deferred: false; capacitySplits: number })
    | BroadDeferredProgress
    | null
  > {
    if (!this.budget) return null;
    const started = performance.now();
    const attempt: {
      rpc: MeteredRpc | null;
      range: BroadRangeCapacity | null;
    } = { rpc: null, range: null };
    const result = await this.budget.run(
      async (blocks) => {
        const rpc = createRpc();
        attempt.rpc = rpc;
        try {
          return await runBroadBatch(db, rpc, blocks, options.signal);
        } catch (error) {
          if (error instanceof BroadRangeCapacity) attempt.range = error;
          throw error;
        }
      },
      {
        signal: options.signal,
        onReduce: options.onReduce,
      },
    );
    const counters = {
      httpRequests: attempt.rpc?.requests ?? 0,
      rpcCalls: attempt.rpc?.calls ?? 0,
      methodCountsBeforeRetries: attempt.rpc?.methodCounts ?? null,
      capacitySplits: result ? 0 : 1,
      elapsedMs: Math.round(performance.now() - started),
    };
    if (!result) {
      const range = attempt.range;
      return {
        ...counters,
        deferred: true,
        advanced: 0,
        committed: false,
        behind: true,
        waitingForDiscovery: false,
        from: null,
        to: null,
        attemptedFrom: range?.from ?? null,
        attemptedTo: range?.to ?? null,
        discoveryThroughBlock: null,
        observedSwaps: null,
        registeredSwaps: null,
        unsupportedSwaps: null,
        lagBlocks: null,
      };
    }
    return { ...result, ...counters, deferred: false };
  }
}
