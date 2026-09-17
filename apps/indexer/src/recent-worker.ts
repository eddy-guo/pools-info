import { toEventSelector } from "viem";
import {
  Rpc,
  blockTimestamp,
  collectCatalog,
  collectRecentEvents,
  collectRecentPages,
  contracts,
  launchEvent,
  observedRecentPoolIds,
  recentLaunchesFromPages,
  recentSwapsFromPages,
  swapEvent,
  tokenMetadataFactory,
  tokenMetadataTopic,
  type EventHeader,
  type HyperSyncBlockRow,
  type HyperSyncClient,
  type MulticallConfig,
  type RawLog,
} from "@pools/chain";
import {
  ensureRecentStreams,
  recentStream,
  recentCheckpoints,
  rewindRecent,
  observeRecentHead,
  knownRecentPools,
  commitRecentBatch,
  recentBatchSources,
  type Client,
  type RecentStream,
} from "@pools/db";
const hex = (n: number) => `0x${n.toString(16)}`;
export async function recentHeader(rpc: Rpc, n: number) {
  const h = await rpc.call<EventHeader>("eth_getBlockByNumber", [
    hex(n),
    false,
  ]);
  if (
    !h ||
    Number(h.number) !== n ||
    !/^0x[\da-f]{64}$/i.test(h.hash) ||
    !/^0x[\da-f]{64}$/i.test(h.parentHash) ||
    !Number.isSafeInteger(Number(h.timestamp)) ||
    Number(h.timestamp) < 0
  )
    throw Error("Missing recent header");
  return h;
}
/** Re-read the saved cursor's canonical hash from the source; when it no
 * longer matches, walk the saved checkpoints back to the newest one that
 * still does and rewind to it (discovery also rewinds the swap lane). Both
 * sources share this path and differ only in where a canonical hash is read. */
async function reconcile(
  db: Client,
  key: RecentStream["key"],
  canonicalHash: (block: number) => Promise<string>,
) {
  const s = await recentStream(db, key);
  if (s.cursor === null || (await canonicalHash(s.cursor)) === s.hash) return s;
  const checkpoints = await recentCheckpoints(db, key);
  let ancestor: number | null = null;
  for (const b of checkpoints)
    if ((await canonicalHash(b.to)) === b.hash) {
      ancestor = b.to;
      break;
    }
  // A source that matches none of up to 256 saved checkpoints is answering
  // for the wrong chain, not reorging; rewinding to null would delete every
  // checkpoint and let it commit empty batches with foreign hashes.
  if (ancestor === null && checkpoints.length > 0)
    throw Error("No matching recent checkpoint; refusing a full rewind");
  await rewindRecent(db, s, ancestor);
  console.log(
    JSON.stringify({
      event: "recent_rewind",
      stream: key,
      from: s.cursor,
      to: ancestor,
    }),
  );
  return recentStream(db, key);
}
const height = (params: unknown[]) =>
  typeof params[0] === "string" &&
  /^0x[\da-f]+$/i.test(params[0]) &&
  params[1] === false
    ? Number(params[0])
    : null;
/** One chain view per cycle: the chain id, the head and every canonical header
 * are fetched at most once per transport, and the worker creates one transport
 * per cycle. Every height the cycle touches (head, saved cursors, both
 * boundaries, each event block) is observed at most 128 blocks behind the
 * head, so the observations are mutually consistent. Consistency across cycles
 * is the reconcile's job: the next cycle re-reads the saved cursor's header
 * and walks checkpoints back to a matching ancestor before extending it. */
export function recentCycleRpc(rpc: Rpc) {
  const call = rpc.call.bind(rpc),
    batch = rpc.batch.bind(rpc);
  const once = new Map<string, unknown>();
  const headers = new Map<number, unknown>();
  rpc.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId" || method === "eth_blockNumber") {
      if (!once.has(method)) once.set(method, await call<T>(method, params));
      return once.get(method) as T;
    }
    const n = method === "eth_getBlockByNumber" ? height(params) : null;
    if (n === null) return call<T>(method, params);
    if (!headers.has(n)) headers.set(n, await call<T>(method, params));
    return headers.get(n) as T;
  };
  rpc.batch = async <T>(method: string, paramsList: unknown[][]) => {
    if (method !== "eth_getBlockByNumber") return batch<T>(method, paramsList);
    const heights = paramsList.map(height);
    if (heights.some((n) => n === null)) return batch<T>(method, paramsList);
    const missing = [
      ...new Set(heights.filter((n) => !headers.has(n!)) as number[]),
    ];
    if (missing.length) {
      const fetched = await batch<T>(
        method,
        missing.map((n) => [hex(n), false]),
      );
      if (fetched.length !== missing.length)
        throw Error("Missing recent header");
      missing.forEach((n, i) => headers.set(n, fetched[i]));
    }
    return heights.map((n) => headers.get(n!) as T);
  };
  return rpc;
}
/** Share one scope-filtered log query for the exact range between the
 * discovery collector (strategy launches plus factory metadata) and the swap
 * collector (PoolManager swaps). Each is served precisely what the provider
 * would return for its own query; anything else still hits the provider. */
export async function prepareRecentCycleRpc(
  rpc: Rpc,
  from: number,
  to: number,
) {
  const swapTopic = toEventSelector(swapEvent),
    launchTopic = toEventSelector(launchEvent);
  const discoverySources: string[] = [
      ...contracts.strategies,
      tokenMetadataFactory,
    ],
    discoveryTopics: string[][] = [[launchTopic, tokenMetadataTopic]];
  const logs = await rpc.logs(
    [contracts.manager, ...discoverySources],
    [[swapTopic, launchTopic, tokenMetadataTopic]],
    from,
    to,
  );
  if (logs.length > 10000) throw Error("Recent batch exceeds 10000 logs");
  const discovery: RawLog[] = [],
    swap: RawLog[] = [];
  for (const log of logs) {
    const addr = log.address.toLowerCase(),
      topic = log.topics[0]?.toLowerCase();
    if (addr === contracts.manager && topic === swapTopic) swap.push(log);
    else if (
      topic !== undefined &&
      discoverySources.includes(addr) &&
      discoveryTopics[0].includes(topic)
    )
      discovery.push(log);
    else throw Error("Unexpected recent combined source");
  }
  const query = rpc.logs.bind(rpc);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  rpc.logs = async (address, topics, a, b) => {
    if (a === from && b === to) {
      if (address === contracts.manager && same(topics, [swapTopic]))
        return swap;
      if (same(address, discoverySources) && same(topics, discoveryTopics))
        return discovery;
    }
    return query(address, topics, a, b);
  };
  return rpc;
}
export async function runRecentCycle(
  db: Client,
  rpc: Rpc,
  options: {
    bootstrapBlocks: number;
    batchBlocks: number;
    signal?: AbortSignal;
  },
) {
  recentCycleRpc(rpc);
  if (Number(await rpc.call<string>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<string>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < 128)
    throw Error("Invalid chain head");
  const headHeader = await recentHeader(rpc, head);
  await ensureRecentStreams(
    db,
    Math.max(0, head - 128 - options.bootstrapBlocks + 1),
  );
  await observeRecentHead(db, head, Number(headHeader.timestamp));
  const canonicalHash = async (n: number) =>
    (await recentHeader(rpc, n)).hash.toLowerCase();
  let discovery = await reconcile(db, "discovery", canonicalHash);
  const swaps = await reconcile(db, "swaps", canonicalHash);
  const swapFrom = swaps.cursor === null ? swaps.start : swaps.cursor + 1;
  const discoveryFrom =
    discovery.cursor === null ? discovery.start : discovery.cursor + 1;
  const behindDiscovery = swapFrom < discoveryFrom;
  const from = behindDiscovery ? swapFrom : discoveryFrom;
  const to = Math.min(
    head - 128,
    from + options.batchBlocks - 1,
    behindDiscovery ? discovery.cursor! : Infinity,
  );
  if (from > to || options.signal?.aborted)
    return { head, through: swaps.cursor, advanced: 0, swaps: 0, pools: 0 };
  await prepareRecentCycleRpc(rpc, from, to);
  // Both boundaries are pinned here; the collectors below observe these same
  // headers, so their cutoffs can only agree. The saved history is linked by
  // the first header's parent hash, here for discovery and at commit for both.
  const first = await recentHeader(rpc, from);
  const cutoff = await recentHeader(rpc, to);
  let pools = 0;
  if (!behindDiscovery) {
    if (discovery.hash && first.parentHash.toLowerCase() !== discovery.hash)
      throw Error("Checkpoint parent changed");
    const result = await collectCatalog(undefined, rpc, {
      fromBlock: from,
      toBlock: to,
    });
    if (cutoff.hash.toLowerCase() !== result.catalog.blockHash.toLowerCase())
      throw Error("Discovery boundary changed");
    await commitRecentBatch(db, discovery, {
      from,
      to,
      hash: cutoff.hash.toLowerCase(),
      parentHash: first.parentHash.toLowerCase(),
      timestamp: Number(cutoff.timestamp),
      pools: result.catalog.pools,
      evidence: result.evidence,
    });
    pools = result.catalog.pools.length;
    discovery = await recentStream(db, "discovery");
  }
  if (options.signal?.aborted)
    return { head, through: swaps.cursor, advanced: 0, swaps: 0, pools };
  // The combined logs are already cached for this exact range. Resolve only
  // their IDs against the verified registry instead of loading every launch.
  // collectRecentEvents still validates all logs, receipts and canonical blocks.
  const observed = await rpc.logs(
    contracts.manager,
    [toEventSelector(swapEvent)],
    from,
    to,
  );
  const ids = [...new Set(observed.map((log) => log.topics[1]?.toLowerCase()))];
  if (ids.some((id) => !id || !/^0x[\da-f]{64}$/.test(id)))
    throw Error("Unexpected recent event pool identity");
  const result = await collectRecentEvents(
    { fromBlock: from, toBlock: to, pools: await knownRecentPools(db, ids) },
    rpc,
  );
  if (
    result.blockHash !== cutoff.hash.toLowerCase() ||
    result.fromBlockParentHash !== first.parentHash.toLowerCase()
  )
    throw Error("Recent boundary changed");
  await commitRecentBatch(db, swaps, {
    from,
    to,
    hash: result.blockHash,
    parentHash: result.fromBlockParentHash,
    timestamp: result.toTimestamp,
    events: result.events,
    evidence: result.evidence,
    observedSwaps: result.observedSwaps,
    unregisteredSwaps: result.unregisteredSwaps,
    unsupportedSwaps: result.unsupportedSwaps,
  });
  return {
    head,
    through: to,
    advanced: to - from + 1,
    swaps: result.events.length,
    pools,
    observedSwaps: result.observedSwaps,
    unregisteredSwaps: result.unregisteredSwaps,
  };
}

/** One cycle with Envio HyperSync as the chain source (RECENT_SOURCE=hypersync,
 * docs/HYPERSYNC-TIP.md). The confirmation buffer, the lane order, the
 * checkpoint links and the reconciliation are the JSON-RPC cycle's; only the
 * reads move. HyperSync's archive height is the head, every canonical header
 * comes from HyperSync at most once per cycle, and one paged query serves both
 * lanes with the logs, their transactions and every block of the range. The
 * JSON-RPC provider is read only for a new launch's name and symbol. */
export async function runRecentHyperSyncCycle(
  db: Client,
  client: HyperSyncClient,
  rpc: Rpc,
  options: {
    bootstrapBlocks: number;
    batchBlocks: number;
    maxPages: number;
    signal?: AbortSignal;
    multicall?: MulticallConfig;
  },
) {
  const headers = new Map<number, Promise<HyperSyncBlockRow>>();
  const header = (n: number) => {
    if (!headers.has(n)) headers.set(n, client.header(n));
    return headers.get(n)!;
  };
  const head = await client.height();
  if (!Number.isSafeInteger(head) || head < 128)
    throw Error("Invalid chain head");
  await ensureRecentStreams(
    db,
    Math.max(0, head - 128 - options.bootstrapBlocks + 1),
  );
  await observeRecentHead(db, head, blockTimestamp(await header(head)));
  const idle = (through: number | null) => ({
    head,
    through,
    advanced: 0,
    swaps: 0,
    pools: 0,
    pages: 0,
  });
  // A cursor above the archive height (a switch from a provider whose head
  // was ahead) cannot be read back yet; wait until HyperSync reaches it.
  const saved = await Promise.all([
    recentStream(db, "discovery"),
    recentStream(db, "swaps"),
  ]);
  if (saved.some((s) => s.cursor !== null && s.cursor > head))
    return idle(saved[1].cursor);
  const canonicalHash = async (n: number) =>
    (await header(n)).hash.toLowerCase();
  let discovery = await reconcile(db, "discovery", canonicalHash);
  const swaps = await reconcile(db, "swaps", canonicalHash);
  const swapFrom = swaps.cursor === null ? swaps.start : swaps.cursor + 1;
  const discoveryFrom =
    discovery.cursor === null ? discovery.start : discovery.cursor + 1;
  const behindDiscovery = swapFrom < discoveryFrom;
  const from = behindDiscovery ? swapFrom : discoveryFrom;
  const requestedTo = Math.min(
    head - 128,
    from + options.batchBlocks - 1,
    behindDiscovery ? discovery.cursor! : Infinity,
  );
  if (from > requestedTo || options.signal?.aborted) return idle(swaps.cursor);
  // Whole pages only: a dense range ends early at a block boundary, and every
  // block of what was consumed is checked to be one parent-linked chain.
  const pages = await collectRecentPages(client, {
    fromBlock: from,
    toBlock: requestedTo,
    height: head,
    maxPages: options.maxPages,
  });
  const to = pages.toBlock;
  const first = pages.blocks.get(from)!;
  let pools = 0;
  if (!behindDiscovery) {
    if (discovery.hash && first.parent_hash.toLowerCase() !== discovery.hash)
      throw Error("Checkpoint parent changed");
    const launches = await recentLaunchesFromPages(
      pages,
      rpc,
      options.multicall,
    );
    await commitRecentBatch(db, discovery, {
      from,
      to,
      hash: launches.blockHash,
      parentHash: launches.fromBlockParentHash,
      timestamp: launches.toTimestamp,
      pools: launches.pools,
      evidence: launches.evidence,
      source: recentBatchSources.hypersync,
    });
    pools = launches.pools.length;
    discovery = await recentStream(db, "discovery");
  }
  if (options.signal?.aborted)
    return { ...idle(swaps.cursor), pools, pages: pages.pages.length };
  // Launches committed above are registered before the swap ids resolve.
  const batch = recentSwapsFromPages(
    pages,
    await knownRecentPools(db, observedRecentPoolIds(pages)),
  );
  await commitRecentBatch(db, swaps, {
    from,
    to,
    hash: batch.blockHash,
    parentHash: batch.fromBlockParentHash,
    timestamp: batch.toTimestamp,
    events: batch.events,
    evidence: batch.evidence,
    observedSwaps: batch.observedSwaps,
    unregisteredSwaps: batch.unregisteredSwaps,
    unsupportedSwaps: batch.unsupportedSwaps,
    source: recentBatchSources.hypersync,
  });
  return {
    head,
    through: to,
    advanced: to - from + 1,
    swaps: batch.events.length,
    pools,
    pages: pages.pages.length,
    observedSwaps: batch.observedSwaps,
    unregisteredSwaps: batch.unregisteredSwaps,
  };
}
