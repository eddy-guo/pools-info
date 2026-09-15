import {
  collectCatalog,
  instantRegistryRevision,
  instantRegistrySourceRevision,
  instantRegistryStartBlock,
  type Rpc,
} from "@pools/chain";
import {
  commitBatch,
  discoveryV2Identity,
  ensureDiscoveryV2,
  markAttempt,
  type Client,
} from "@pools/db";
import { canonicalHeader, reconcileStream } from "./checkpoints";

export function discoveryV2Enabled(
  value = process.env.INDEXER_DISCOVERY_V2_ENABLED,
): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw Error("Invalid INDEXER_DISCOVERY_V2_ENABLED; expected 0 or 1");
}

export function discoveryBatchBlocks(
  value = process.env.INDEXER_DISCOVERY_BATCH_BLOCKS,
): number {
  const blocks = Number(value ?? 10000);
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 10000)
    throw Error("Invalid INDEXER_DISCOVERY_BATCH_BLOCKS");
  return blocks;
}

/** The fixed v2 identity must remain tied to the collector's verified registry. */
export function checkDiscoveryRegistry() {
  if (
    discoveryV2Identity.start !== instantRegistryStartBlock ||
    discoveryV2Identity.registryRevision !== instantRegistryRevision ||
    discoveryV2Identity.registrySourceRevision !== instantRegistrySourceRevision
  )
    throw Error(
      "Discovery v2 compiled registry changed; create a new versioned stream",
    );
}

export interface DiscoveryProgress {
  advanced: number;
  behind: boolean;
  from: number;
  to: number;
  pools: number;
  poolsWithImages: number;
  httpRequests: number;
  rpcCalls: number;
}

/** One canonical contiguous batch. Collection happens outside the commit transaction. */
export async function runDiscoveryBatch(
  db: Client,
  client: Rpc,
  batchBlocks: number,
  signal?: AbortSignal,
): Promise<DiscoveryProgress> {
  discoveryBatchBlocks(String(batchBlocks));
  checkDiscoveryRegistry();
  signal?.throwIfAborted();
  if (Number(await client.call<string>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const stream = await reconcileStream(db, await ensureDiscoveryV2(db), client);
  const head = Number(await client.call<string>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < 128)
    throw Error("Invalid chain head");
  const confirmed = head - 128;
  const from = stream.cursor === null ? stream.start : stream.cursor + 1;
  const to = Math.min(confirmed, from + batchBlocks - 1);
  if (from > to)
    return {
      advanced: 0,
      behind: false,
      from,
      to,
      pools: 0,
      poolsWithImages: 0,
      httpRequests: client.requests,
      rpcCalls: client.calls,
    };
  signal?.throwIfAborted();
  await markAttempt(db, stream.key);
  const first = await canonicalHeader(client, from);
  if (stream.hash && first.parentHash !== stream.hash)
    throw Error("Checkpoint parent changed");
  const result = await collectCatalog(undefined, client, {
    fromBlock: from,
    toBlock: to,
  });
  signal?.throwIfAborted();
  if (
    (await canonicalHeader(client, from)).hash !== first.hash ||
    (await canonicalHeader(client, to)).hash !== result.catalog.blockHash
  )
    throw Error("Discovery boundary changed");
  await commitBatch(db, stream, {
    from,
    to,
    hash: result.catalog.blockHash,
    evidence: {
      ...result.evidence,
      registryRevision: discoveryV2Identity.registryRevision,
      registrySourceRevision: discoveryV2Identity.registrySourceRevision,
    },
    pools: result.catalog.pools,
  });
  return {
    advanced: to - from + 1,
    behind: to < confirmed,
    from,
    to,
    pools: result.catalog.pools.length,
    poolsWithImages: result.catalog.pools.filter((p) => p.imageUrl).length,
    httpRequests: client.requests,
    rpcCalls: client.calls,
  };
}

/** Only proven capacity failures shrink a scan. Invalid evidence remains an error. */
export class DiscoveryBatchBudget {
  private blocks: number;
  private successes = 0;
  constructor(private readonly maximum: number) {
    this.blocks = discoveryBatchBlocks(String(maximum));
  }

  async run<T extends Pick<DiscoveryProgress, "advanced" | "rpcCalls">>(
    attempt: (blocks: number) => Promise<T>,
    options: {
      signal?: AbortSignal;
      onReduce?: (previous: number, next: number) => void;
    } = {},
  ): Promise<T> {
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        const result = await attempt(this.blocks);
        // A dense launch burst should not permanently shrink the rest of history.
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
        const message = error instanceof Error ? error.message : "";
        const capacity =
          /^(Collection budget exceeded after [0-9]+ HTTP requests and [0-9]+ RPC calls|Catalog batch exceeds (?:250 launches|10000 discovery logs); split the scan before publishing)$/.test(
            message,
          );
        if (!capacity || this.blocks === 1 || options.signal?.aborted)
          throw error;
        const previous = this.blocks;
        this.blocks = Math.max(1, Math.floor(previous / 2));
        options.onReduce?.(previous, this.blocks);
      }
    }
  }
}

/** Disabled scheduling performs no discovery database or RPC work, including setup. */
export class DiscoveryScheduler {
  readonly enabled: boolean;
  private readonly budget?: DiscoveryBatchBudget;

  constructor(
    enabled = process.env.INDEXER_DISCOVERY_V2_ENABLED,
    batchBlocks = process.env.INDEXER_DISCOVERY_BATCH_BLOCKS,
  ) {
    this.enabled = discoveryV2Enabled(enabled);
    if (this.enabled) {
      checkDiscoveryRegistry();
      this.budget = new DiscoveryBatchBudget(discoveryBatchBlocks(batchBlocks));
    }
  }

  async run(
    db: Client,
    createRpc: () => Rpc,
    options: {
      signal?: AbortSignal;
      onReduce?: (previous: number, next: number) => void;
    } = {},
  ): Promise<DiscoveryProgress | null> {
    if (!this.budget) return null;
    return this.budget.run(
      (size) => runDiscoveryBatch(db, createRpc(), size, options.signal),
      options,
    );
  }
}
