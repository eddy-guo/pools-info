import { toEventSelector, type Hex } from "viem";
import { contracts, decodeSwap, swapEvent, type RawLog } from "./events";
import type { Receipt } from "./audit";
import type { EventHeader } from "./pool-events";
import { Rpc, hex } from "./rpc";
export interface RecentPoolIdentity {
  id: string;
  token: string;
  launchBlock: number;
}
export interface VerifiedRecentSwap {
  poolId: string;
  token: string;
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  transactionSender: string;
  amount0: string;
  amount1: string;
  ethWei: string;
  tokenRaw: string;
  side: "buy" | "sell";
}
export interface RecentEventBatch {
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  fromBlockParentHash: string;
  toTimestamp: number;
  events: VerifiedRecentSwap[];
  observedSwaps: number;
  unregisteredSwaps: number;
  unsupportedSwaps: number;
  evidence: { logs: RawLog[]; headers: EventHeader[]; receipts: Receipt[] };
}
const hash = (s: string) => /^0x[\da-f]{64}$/i.test(s),
  address = (s: string) => /^0x[\da-f]{40}$/i.test(s);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Scan the manager once, discard unregistered IDs before expensive receipts and
 * headers, and retain unsupported registered swaps as evidence without PnL. */
export async function collectRecentEvents(
  range: { fromBlock: number; toBlock: number; pools: RecentPoolIdentity[] },
  rpc = new Rpc(),
): Promise<RecentEventBatch> {
  const { fromBlock, toBlock } = range;
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock ||
    toBlock - fromBlock >= 2000 ||
    range.pools.length > 10000
  )
    throw Error("Invalid recent event range");
  const pools = new Map<string, RecentPoolIdentity>();
  for (const p of range.pools) {
    if (
      !hash(p.id) ||
      !address(p.token) ||
      !Number.isSafeInteger(p.launchBlock) ||
      p.launchBlock < 0 ||
      pools.has(p.id.toLowerCase())
    )
      throw Error("Invalid recent pool identity");
    pools.set(p.id.toLowerCase(), p);
  }
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || toBlock > head - 128)
    throw Error("Recent event range exceeds confirmed cutoff");
  const logs = await rpc.logs(
    contracts.manager,
    [toEventSelector(swapEvent)],
    fromBlock,
    toBlock,
  );
  if (logs.length > 10000) throw Error("Recent batch exceeds 10000 logs");
  const seen = new Set<string>();
  const selected: RawLog[] = [];
  for (const l of logs) {
    if (
      l.removed ||
      !same(l.address, contracts.manager) ||
      l.topics.length !== 3 ||
      !same(l.topics[0], toEventSelector(swapEvent)) ||
      !hash(l.topics[1]) ||
      !hash(l.blockHash) ||
      !hash(l.transactionHash) ||
      !Number.isSafeInteger(Number(l.blockNumber)) ||
      Number(l.blockNumber) < fromBlock ||
      Number(l.blockNumber) > toBlock ||
      !Number.isSafeInteger(Number(l.logIndex)) ||
      Number(l.logIndex) < 0
    )
      throw Error("Unexpected recent event source or range");
    const id = `${l.transactionHash.toLowerCase()}:${Number(l.logIndex)}`;
    if (seen.has(id)) throw Error("Duplicate recent event evidence");
    seen.add(id);
    const p = pools.get(l.topics[1].toLowerCase());
    if (!p) continue;
    if (Number(l.blockNumber) < p.launchBlock)
      throw Error("Recent event precedes verified launch");
    selected.push(l);
  }
  const heights = [
    ...new Set([
      fromBlock,
      toBlock,
      ...selected.map((l) => Number(l.blockNumber)),
    ]),
  ];
  const headers = await rpc.batch<EventHeader>(
    "eth_getBlockByNumber",
    heights.map((n) => [hex(n), false]),
  );
  if (headers.length !== heights.length) throw Error("Missing recent header");
  const blocks = new Map(
    headers.map((h, i) => {
      if (
        !h ||
        Number(h.number) !== heights[i] ||
        !hash(h.hash) ||
        !hash(h.parentHash) ||
        !Number.isSafeInteger(Number(h.timestamp)) ||
        Number(h.timestamp) < 0
      )
        throw Error("Missing recent header");
      return [heights[i], h];
    }),
  );
  const hashes = [
    ...new Set(selected.map((l) => l.transactionHash.toLowerCase())),
  ];
  const receipts = await rpc.batch<Receipt>(
    "eth_getTransactionReceipt",
    hashes.map((h) => [h]),
  );
  if (receipts.length !== hashes.length) throw Error("Missing recent receipt");
  const byHash = new Map(
    receipts.map((r, i) => {
      if (
        !r ||
        !same(r.transactionHash, hashes[i]) ||
        r.status !== "0x1" ||
        !address(r.from) ||
        !Array.isArray(r.logs)
      )
        throw Error("Missing recent receipt");
      return [hashes[i], r];
    }),
  );
  const events: VerifiedRecentSwap[] = [];
  let unsupportedSwaps = 0;
  for (const l of selected) {
    const h = blocks.get(Number(l.blockNumber))!,
      r = byHash.get(l.transactionHash.toLowerCase())!;
    if (
      Number(h.timestamp) > Number(blocks.get(toBlock)!.timestamp) ||
      !same(h.hash, l.blockHash) ||
      !same(r.blockHash, l.blockHash) ||
      !r.logs.some(
        (e) =>
          !e.removed &&
          same(e.address, l.address) &&
          Number(e.logIndex) === Number(l.logIndex) &&
          same(e.transactionHash, l.transactionHash) &&
          same(e.blockHash, l.blockHash) &&
          Number(e.blockNumber) === Number(l.blockNumber) &&
          same(e.data, l.data) &&
          same(e.topics.join(), l.topics.join()),
      )
    )
      throw Error("Inconsistent recent receipt or canonical block");
    let d: ReturnType<typeof decodeSwap>;
    try {
      d = decodeSwap(l);
    } catch (e) {
      if (e instanceof Error && e.message === "Unsupported swap signs") {
        unsupportedSwaps++;
        continue;
      }
      throw e;
    }
    events.push({
      poolId: d.id.toLowerCase(),
      token: pools.get(d.id.toLowerCase())!.token.toLowerCase(),
      txHash: l.transactionHash.toLowerCase(),
      logIndex: Number(l.logIndex),
      block: Number(l.blockNumber),
      blockHash: l.blockHash.toLowerCase(),
      timestamp: Number(h.timestamp),
      transactionSender: r.from.toLowerCase(),
      amount0: d.amount0.toString(),
      amount1: d.amount1.toString(),
      ethWei: d.ethWei,
      tokenRaw: d.tokenRaw,
      side: d.side,
    });
  }
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
    throw Error("Recent cutoff changed during collection");
  return {
    fromBlock,
    toBlock,
    blockHash: cutoff.hash.toLowerCase(),
    fromBlockParentHash: blocks.get(fromBlock)!.parentHash.toLowerCase(),
    toTimestamp: Number(cutoff.timestamp),
    events,
    observedSwaps: logs.length,
    unregisteredSwaps: logs.length - selected.length,
    unsupportedSwaps,
    evidence: { logs: selected, headers, receipts },
  };
}
