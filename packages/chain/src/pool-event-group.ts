import { toEventSelector, type Hex } from "viem";
import { contracts, swapEvent, transferEvent } from "./events";
import {
  collectPoolEvents,
  type EventHeader,
  type PoolEvents,
} from "./pool-events";
import type { Receipt } from "./audit";
import { Rpc, hex } from "./rpc";

/** Collect a bounded group of verified markets over one common range. The caller
 * must commit the whole group and its checkpoint atomically. This does not
 * discover markets or establish coverage before the supplied range. */
export async function collectPoolEventGroup(
  range: {
    fromBlock: number;
    toBlock: number;
    pools: { poolId: string; token: string }[];
  },
  rpc = new Rpc(undefined, { timeoutMs: 120000, maxRequests: 1000 }),
): Promise<PoolEvents[]> {
  const { fromBlock, toBlock } = range;
  const pools = range.pools.map((p) => ({
    poolId: p.poolId.toLowerCase(),
    token: p.token.toLowerCase(),
  }));
  const ids = new Set(pools.map((p) => p.poolId));
  const tokens = new Set(pools.map((p) => p.token));
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock ||
    toBlock - fromBlock >= 2000 ||
    pools.length < 1 ||
    pools.length > 200 ||
    ids.size !== pools.length ||
    tokens.size !== pools.length ||
    pools.some(
      (p) =>
        !/^0x[\da-f]{64}$/.test(p.poolId) || !/^0x[\da-f]{40}$/.test(p.token),
    )
  )
    throw Error("Invalid pool event group");
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || toBlock > head - 128)
    throw Error("Pool event range exceeds confirmed cutoff");
  const swapTopic = toEventSelector(swapEvent);
  const transferTopic = toEventSelector(transferEvent);
  const swaps = await rpc.logs(
    contracts.manager,
    [swapTopic, [...ids]],
    fromBlock,
    toBlock,
  );
  const transfers = await rpc.logs(
    [...tokens],
    [transferTopic],
    fromBlock,
    toBlock,
  );
  const logs = [...swaps, ...transfers];
  if (logs.length > 10000)
    throw Error("Event group exceeds 10000 logs; use a smaller range");
  // Reject unexpected evidence before partitioning; filtering it away would hide
  // a provider ignoring the requested scope. Per-pool decoding stays unchanged.
  if (
    swaps.some(
      (l) =>
        l.address.toLowerCase() !== contracts.manager ||
        l.topics[0]?.toLowerCase() !== swapTopic ||
        !ids.has(l.topics[1]?.toLowerCase()),
    ) ||
    transfers.some(
      (l) =>
        !tokens.has(l.address.toLowerCase()) ||
        l.topics[0]?.toLowerCase() !== transferTopic,
    ) ||
    logs.some(
      (l) =>
        l.removed ||
        l.topics.length !== 3 ||
        !Number.isSafeInteger(Number(l.blockNumber)) ||
        Number(l.blockNumber) < fromBlock ||
        Number(l.blockNumber) > toBlock ||
        !/^0x[\da-f]{64}$/i.test(l.transactionHash) ||
        !/^0x[\da-f]{64}$/i.test(l.blockHash) ||
        !Number.isSafeInteger(Number(l.logIndex)) ||
        Number(l.logIndex) < 0,
    )
  )
    throw Error("Unexpected event group source or range");
  if (
    new Set(
      logs.map(
        (l) => `${l.transactionHash.toLowerCase()}:${Number(l.logIndex)}`,
      ),
    ).size !== logs.length
  )
    throw Error("Duplicate event group evidence");
  const heights = [
    ...new Set([fromBlock, toBlock, ...logs.map((l) => Number(l.blockNumber))]),
  ];
  const headers = await rpc.batch<EventHeader>(
    "eth_getBlockByNumber",
    heights.map((n) => [hex(n), false]),
  );
  const hashes = [...new Set(logs.map((l) => l.transactionHash.toLowerCase()))];
  const receipts = await rpc.batch<Receipt>(
    "eth_getTransactionReceipt",
    hashes.map((h) => [h]),
  );
  if (headers.length !== heights.length || receipts.length !== hashes.length)
    throw Error("Incomplete event group evidence");
  const blocks = new Map(heights.map((n, i) => [n, headers[i]]));
  const transactions = new Map(hashes.map((h, i) => [h, receipts[i]]));
  // This adapter only exposes the immutable evidence just fetched. Every output
  // passes the existing source, receipt, amount and header validators. Nothing
  // returns to the caller until the shared cutoff is rechecked against the RPC.
  const evidence = new Rpc();
  evidence.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId") return hex(4663) as T;
    if (method === "eth_blockNumber") return hex(head) as T;
    if (method === "eth_getBlockByNumber")
      return blocks.get(Number(params[0])) as T;
    throw Error("Unsupported event group evidence request");
  };
  evidence.batch = async <T>(method: string, params: unknown[][]) => {
    if (method === "eth_getBlockByNumber")
      return params.map((p) => blocks.get(Number(p[0]))) as T[];
    if (method === "eth_getTransactionReceipt")
      return params.map((p) =>
        transactions.get(String(p[0]).toLowerCase()),
      ) as T[];
    throw Error("Unsupported event group evidence request");
  };
  evidence.logs = async (address, topics, from, to) => {
    if (from !== fromBlock || to !== toBlock)
      throw Error("Unexpected event group evidence range");
    if (
      address === contracts.manager &&
      topics[0] === swapTopic &&
      typeof topics[1] === "string" &&
      ids.has(topics[1])
    )
      return swaps.filter((l) => l.topics[1].toLowerCase() === topics[1]);
    if (
      typeof address === "string" &&
      tokens.has(address) &&
      topics[0] === transferTopic
    )
      return transfers.filter((l) => l.address.toLowerCase() === address);
    throw Error("Unexpected event group evidence scope");
  };
  const results: PoolEvents[] = [];
  for (const pool of pools)
    results.push(
      await collectPoolEvents({ ...pool, fromBlock, toBlock }, evidence),
    );
  const final = await rpc.call<EventHeader>("eth_getBlockByNumber", [
    hex(toBlock),
    false,
  ]);
  if (
    !final ||
    Number(final.number) !== toBlock ||
    final.hash.toLowerCase() !== results[0].blockHash
  )
    throw Error("Cutoff changed during event group collection");
  return results.map((result) => ({ ...result, requests: rpc.requests }));
}
