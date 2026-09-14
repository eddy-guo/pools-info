import { toEventSelector, type Hex } from "viem";
import { contracts, decodeSwap, swapEvent, type RawLog } from "./events";
import { Rpc, hex } from "./rpc";
export interface RecentSwap {
  poolId: string;
  txHash: string;
  logIndex: number;
  block: number;
  timestamp: number;
  amount0: string;
  amount1: string;
  transactionSender: string | null;
}
export interface RecentSwaps {
  fromBlock: number;
  toBlock: number;
  toTimestamp: number;
  events: RecentSwap[];
  truncated: boolean;
  generatedAt: string;
}
export async function collectRecentSwaps(
  poolIds: string[],
  rpc = new Rpc(undefined, { timeoutMs: 12000, maxRequests: 40 }),
): Promise<RecentSwaps> {
  if (
    !poolIds.length ||
    poolIds.length > 8 ||
    poolIds.some((p) => !/^0x[0-9a-f]{64}$/.test(p))
  )
    throw Error("Invalid pools");
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < 1128) throw Error("Invalid head");
  const toBlock = head - 128,
    fromBlock = toBlock - 999;
  const logs = await rpc.logs(
    contracts.manager,
    [toEventSelector(swapEvent), poolIds],
    fromBlock,
    toBlock,
  );
  const latest = logs.slice(-50);
  const heights = [
    ...new Set([toBlock, ...latest.map((l) => Number(l.blockNumber))]),
  ];
  type Header = { number: Hex; hash: Hex; timestamp: Hex };
  const headers = await rpc.batch<Header>(
    "eth_getBlockByNumber",
    heights.map((n) => [hex(n), false]),
  );
  const blocks = new Map(
    headers.map((b, i) => {
      if (!b || Number(b.number) !== heights[i]) throw Error("Missing block");
      return [heights[i], b];
    }),
  );
  // Receipt.from is explicitly labelled transaction sender, never assumed to
  // be the buyer/beneficiary or used to calculate PnL.
  const hashes = [...new Set(latest.map((l) => l.transactionHash))];
  type Receipt = {
    transactionHash: Hex;
    blockHash: Hex;
    status: Hex;
    from: Hex;
    logs: RawLog[];
  };
  const receipts = await rpc.batch<Receipt>(
    "eth_getTransactionReceipt",
    hashes.map((h) => [h]),
  );
  const receiptMap = new Map(
    receipts.map((r, i) => {
      if (!r || r.transactionHash !== hashes[i]) throw Error("Missing receipt");
      return [r.transactionHash, r];
    }),
  );
  const events = latest.map((l) => {
    const b = blocks.get(Number(l.blockNumber))!,
      r = receiptMap.get(l.transactionHash)!;
    if (
      b.hash !== l.blockHash ||
      r.blockHash !== l.blockHash ||
      r.status !== "0x1" ||
      !r.logs.some(
        (e) =>
          e.address.toLowerCase() === contracts.manager &&
          e.logIndex === l.logIndex &&
          e.data === l.data &&
          e.topics.join() === l.topics.join(),
      )
    )
      throw Error("Inconsistent swap evidence");
    const d = decodeSwap(l);
    if (!poolIds.includes(d.id.toLowerCase())) throw Error("Unexpected pool");
    return {
      poolId: d.id,
      txHash: l.transactionHash,
      logIndex: Number(l.logIndex),
      block: Number(l.blockNumber),
      timestamp: Number(b.timestamp),
      amount0: d.amount0.toString(),
      amount1: d.amount1.toString(),
      transactionSender: /^0x[0-9a-f]{40}$/i.test(r.from) ? r.from : null,
    };
  });
  return {
    fromBlock,
    toBlock,
    toTimestamp: Number(blocks.get(toBlock)!.timestamp),
    events: events.reverse(),
    truncated: logs.length > 50,
    generatedAt: new Date().toISOString(),
  };
}
