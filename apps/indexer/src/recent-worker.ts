import { toEventSelector } from "viem";
import {
  Rpc,
  collectCatalog,
  collectRecentEvents,
  contracts,
  launchEvent,
  swapEvent,
  type EventHeader,
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
async function reconcile(db: Client, key: RecentStream["key"], rpc: Rpc) {
  const s = await recentStream(db, key);
  if (
    s.cursor === null ||
    (await recentHeader(rpc, s.cursor)).hash.toLowerCase() === s.hash
  )
    return s;
  let ancestor: number | null = null;
  for (const b of await recentCheckpoints(db, key))
    if ((await recentHeader(rpc, b.to)).hash.toLowerCase() === b.hash) {
      ancestor = b.to;
      break;
    }
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
/** Share only immutable scope-filtered log evidence and the conservative head
 * observed at cycle start. Canonical header rechecks always hit the provider. */
export async function prepareRecentCycleRpc(
  rpc: Rpc,
  head: number,
  from: number,
  to: number,
) {
  const swapTopic = toEventSelector(swapEvent),
    launchTopic = toEventSelector(launchEvent);
  const logs = await rpc.logs(
    [contracts.manager, ...contracts.strategies],
    [[swapTopic, launchTopic]],
    from,
    to,
  );
  if (logs.length > 10000) throw Error("Recent batch exceeds 10000 logs");
  const launch: RawLog[] = [],
    swap: RawLog[] = [];
  for (const log of logs) {
    const addr = log.address.toLowerCase(),
      topic = log.topics[0]?.toLowerCase();
    if (addr === contracts.manager && topic === swapTopic) swap.push(log);
    else if (
      (contracts.strategies as readonly string[]).includes(addr) &&
      topic === launchTopic
    )
      launch.push(log);
    else throw Error("Unexpected recent combined source");
  }
  const call = rpc.call.bind(rpc),
    query = rpc.logs.bind(rpc);
  rpc.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId") return hex(4663) as T;
    if (method === "eth_blockNumber") return hex(head) as T;
    return call<T>(method, params);
  };
  rpc.logs = async (address, topics, a, b) => {
    if (a === from && b === to && topics.length === 1) {
      if (address === contracts.manager && topics[0] === swapTopic) return swap;
      if (
        Array.isArray(address) &&
        JSON.stringify(address) === JSON.stringify(contracts.strategies) &&
        topics[0] === launchTopic
      )
        return launch;
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
  let discovery = await reconcile(db, "discovery", rpc);
  const swaps = await reconcile(db, "swaps", rpc);
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
  await prepareRecentCycleRpc(rpc, head, from, to);
  let pools = 0;
  if (!behindDiscovery) {
    const first = await recentHeader(rpc, from);
    if (discovery.hash && first.parentHash.toLowerCase() !== discovery.hash)
      throw Error("Checkpoint parent changed");
    const result = await collectCatalog(undefined, rpc, {
      fromBlock: from,
      toBlock: to,
    });
    const cutoff = await recentHeader(rpc, to);
    if (
      cutoff.hash.toLowerCase() !== result.catalog.blockHash.toLowerCase() ||
      (await recentHeader(rpc, from)).hash !== first.hash
    )
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
  // Pin the common discovery cutoff as well as the swap result, even when
  // discovery advanced in an earlier cycle that was interrupted before swaps.
  if (
    discovery.cursor !== null &&
    (await recentHeader(rpc, discovery.cursor)).hash.toLowerCase() !==
      discovery.hash
  )
    throw Error("Discovery boundary changed");
  if (
    (await recentHeader(rpc, from)).hash.toLowerCase() !==
    result.evidence.headers
      .find((h) => Number(h.number) === from)!
      .hash.toLowerCase()
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
