import { decodeEventLog, toEventSelector, type Hex } from "viem";
import { contracts, swapEvent, transferEvent, type RawLog } from "./events";
import type { Receipt } from "./audit";
import { Rpc, hex } from "./rpc";

export interface PoolEventRange {
  poolId: string;
  token: string;
  fromBlock: number;
  toBlock: number;
}
export interface EventHeader {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
}
interface EventIdentity {
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  /** The transaction initiator, not an inferred trade beneficiary. */
  transactionSender: string;
}
export interface IndexedSwap extends EventIdentity {
  decoded: {
    amount0: string;
    amount1: string;
    sqrtPriceX96: string;
    liquidity: string;
    tick: number;
    fee: number;
    sender: string;
    side: "buy" | "sell";
    ethWei: string;
    tokenRaw: string;
  } | null;
  unsupportedReason: string | null;
}
export interface IndexedTransfer extends EventIdentity {
  from: string;
  to: string;
  value: string;
}
export interface PoolEvents {
  chainId: 4663;
  poolId: string;
  token: string;
  fromBlock: number;
  toBlock: number;
  fromBlockParentHash: string;
  blockHash: string;
  toTimestamp: number;
  swaps: IndexedSwap[];
  transfers: IndexedTransfer[];
  evidence: {
    swapLogs: RawLog[];
    transferLogs: RawLog[];
    receipts: Receipt[];
    headers: EventHeader[];
  };
  requests: number;
}
const hashValid = (s: string) => /^0x[0-9a-f]{64}$/i.test(s);
const addressValid = (s: string) => /^0x[0-9a-f]{40}$/i.test(s);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Collect one complete, bounded batch. The caller must supply a verified Pools
 * market and commit evidence plus its checkpoint atomically. No PnL attribution
 * is inferred here, and unsupported swap signs remain in the raw evidence. */
export async function collectPoolEvents(
  range: PoolEventRange,
  rpc = new Rpc(undefined, { timeoutMs: 120000, maxRequests: 1000 }),
): Promise<PoolEvents> {
  const { fromBlock, toBlock } = range;
  const poolId = range.poolId.toLowerCase(),
    token = range.token.toLowerCase();
  if (
    !hashValid(poolId) ||
    !addressValid(token) ||
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock ||
    toBlock - fromBlock >= 2000
  )
    throw Error("Invalid pool event range: maximum 2000 blocks");
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || toBlock > head - 128)
    throw Error("Pool event range exceeds confirmed cutoff");
  const swapTopic = toEventSelector(swapEvent),
    transferTopic = toEventSelector(transferEvent);
  const swapLogs = await rpc.logs(
    contracts.manager,
    [swapTopic, poolId],
    fromBlock,
    toBlock,
  );
  const transferLogs = await rpc.logs(
    token,
    [transferTopic],
    fromBlock,
    toBlock,
  );
  const allLogs = [...swapLogs, ...transferLogs];
  if (allLogs.length > 10000)
    throw Error("Event batch exceeds 10000 logs; use a smaller range");
  for (const [logs, address, topic] of [
    [swapLogs, contracts.manager, swapTopic],
    [transferLogs, token, transferTopic],
  ] as const) {
    for (const log of logs) {
      if (
        log.removed ||
        log.topics.length !== 3 ||
        !same(log.address, address) ||
        !same(log.topics[0], topic) ||
        (topic === swapTopic && !same(log.topics[1] ?? "", poolId)) ||
        !hashValid(log.blockHash) ||
        !hashValid(log.transactionHash) ||
        !Number.isSafeInteger(Number(log.blockNumber)) ||
        Number(log.blockNumber) < fromBlock ||
        Number(log.blockNumber) > toBlock ||
        !Number.isSafeInteger(Number(log.logIndex)) ||
        Number(log.logIndex) < 0
      )
        throw Error("Unexpected event source or range");
    }
  }
  const identities = new Set<string>();
  for (const log of allLogs) {
    const id = `${log.transactionHash.toLowerCase()}:${Number(log.logIndex)}`;
    if (identities.has(id)) throw Error("Duplicate event evidence");
    identities.add(id);
  }
  const heights = [
    ...new Set([
      fromBlock,
      toBlock,
      ...allLogs.map((l) => Number(l.blockNumber)),
    ]),
  ];
  const headers = await rpc.batch<EventHeader>(
    "eth_getBlockByNumber",
    heights.map((n) => [hex(n), false]),
  );
  const blocks = new Map(
    headers.map((header, i) => {
      if (
        !header ||
        Number(header.number) !== heights[i] ||
        !hashValid(header.hash) ||
        !hashValid(header.parentHash) ||
        !Number.isSafeInteger(Number(header.timestamp)) ||
        Number(header.timestamp) < 0
      )
        throw Error("Missing or invalid event header");
      return [heights[i], header];
    }),
  );
  const hashes = [
    ...new Set(allLogs.map((l) => l.transactionHash.toLowerCase())),
  ];
  const receipts = await rpc.batch<Receipt>(
    "eth_getTransactionReceipt",
    hashes.map((h) => [h]),
  );
  const receiptMap = new Map(
    receipts.map((receipt, i) => {
      if (
        !receipt ||
        !same(receipt.transactionHash, hashes[i]) ||
        receipt.status !== "0x1" ||
        !addressValid(receipt.from) ||
        !Array.isArray(receipt.logs)
      )
        throw Error("Missing or invalid event receipt");
      return [hashes[i], receipt];
    }),
  );
  const identity = (log: RawLog): EventIdentity => {
    const header = blocks.get(Number(log.blockNumber))!;
    const receipt = receiptMap.get(log.transactionHash.toLowerCase())!;
    if (
      !same(header.hash, log.blockHash) ||
      !same(receipt.blockHash, log.blockHash) ||
      !receipt.logs.some(
        (entry) =>
          !entry.removed &&
          same(entry.address, log.address) &&
          Number(entry.logIndex) === Number(log.logIndex) &&
          same(entry.blockHash, log.blockHash) &&
          Number(entry.blockNumber) === Number(log.blockNumber) &&
          same(entry.transactionHash, log.transactionHash) &&
          same(entry.data, log.data) &&
          same(entry.topics.join(), log.topics.join()),
      )
    )
      throw Error("Inconsistent event receipt or canonical block");
    return {
      txHash: log.transactionHash.toLowerCase(),
      logIndex: Number(log.logIndex),
      block: Number(log.blockNumber),
      blockHash: log.blockHash.toLowerCase(),
      timestamp: Number(header.timestamp),
      transactionSender: receipt.from.toLowerCase(),
    };
  };
  const swaps: IndexedSwap[] = swapLogs.map((log) => {
    const base = identity(log);
    const { args } = decodeEventLog({ abi: [swapEvent], ...log, strict: true });
    const buy = args.amount0 < 0n && args.amount1 > 0n;
    const sell = args.amount0 > 0n && args.amount1 < 0n;
    if (!buy && !sell)
      return {
        ...base,
        decoded: null,
        unsupportedReason: "unsupported_swap_signs",
      };
    return {
      ...base,
      unsupportedReason: null,
      decoded: {
        amount0: args.amount0.toString(),
        amount1: args.amount1.toString(),
        sqrtPriceX96: args.sqrtPriceX96.toString(),
        liquidity: args.liquidity.toString(),
        tick: args.tick,
        fee: args.fee,
        sender: args.sender.toLowerCase(),
        side: buy ? "buy" : "sell",
        ethWei: (buy ? -args.amount0 : args.amount0).toString(),
        tokenRaw: (buy ? args.amount1 : -args.amount1).toString(),
      },
    };
  });
  const transfers: IndexedTransfer[] = transferLogs.map((log) => {
    const base = identity(log);
    const { args } = decodeEventLog({
      abi: [transferEvent],
      ...log,
      strict: true,
    });
    return {
      ...base,
      from: args.from.toLowerCase(),
      to: args.to.toLowerCase(),
      value: args.value.toString(),
    };
  });
  const cutoff = blocks.get(toBlock)!;
  const final = await rpc.call<EventHeader>("eth_getBlockByNumber", [
    hex(toBlock),
    false,
  ]);
  if (
    !final ||
    Number(final.number) !== toBlock ||
    !same(final.hash, cutoff.hash)
  )
    throw Error("Cutoff changed during event collection");
  return {
    chainId: 4663,
    poolId,
    token,
    fromBlock,
    toBlock,
    fromBlockParentHash: blocks.get(fromBlock)!.parentHash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: Number(cutoff.timestamp),
    swaps,
    transfers,
    evidence: { swapLogs, transferLogs, receipts, headers },
    requests: rpc.requests,
  };
}
