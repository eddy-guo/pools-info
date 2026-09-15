import { decodeEventLog, toEventSelector, type Hex } from "viem";
import { contracts, swapEvent, type RawLog } from "./events";
import {
  instantRegistryRevision,
  instantRegistrySourceRevision,
  instantRegistryStartBlock,
} from "./deployments";
import type { Receipt } from "./audit";
import type { EventHeader } from "./pool-events";
import { Rpc, hex, blockReceiptPolicy, RpcResponseCapacity } from "./rpc";

export const broadEventPolicy = Object.freeze({
  maxBlocks: 10000,
  maxLogs: 10000,
  maxBytes: 16 * 1024 * 1024,
  evidenceChunk: 20,
});
export interface BroadRegistryCheckpoint {
  stream: "discovery:v2";
  revision: string;
  sourceRevision: string;
  throughBlock: number;
  blockHash: string;
}
export interface BroadPoolIdentity {
  poolId: string;
  token: string;
  launchBlock: number;
}
export interface BroadPoolEventRange {
  mode: "broad";
  /** Observe units at this range's canonical cutoff. Legacy callers opt out. */
  collectTokenUnits?: boolean;
  /** Transport only; omitted from saved evidence and replay. */
  receiptMode?: "transaction" | "block";
  fromBlock: number;
  toBlock: number;
  registry: BroadRegistryCheckpoint;
  /** Resolve only these observed IDs from the checkpoint's verified registry.
   * The future writer must revalidate the same dependency when committing. */
  resolvePools: (
    observedIds: readonly string[],
  ) => Promise<readonly BroadPoolIdentity[]>;
}
export interface BroadTokenUnits {
  token: string;
  block: number;
  blockHash: string;
  timestamp: number;
  decimals: number;
  totalSupply: string;
  decimalsResult: string;
  totalSupplyResult: string;
}
export interface BroadIndexedSwap {
  poolId: string;
  token: string;
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  /** Receipt.from is an initiator, never a proven beneficiary. */
  transactionSender: string;
  managerSender: string;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: number;
  side: "buy" | "sell" | null;
  ethWei: string | null;
  tokenRaw: string | null;
  supported: false;
  flags:
    | ["missing_transfer_history"]
    | ["missing_transfer_history", "unsupported_swap_signs"];
}
export interface BroadPoolEventGroup {
  mode: "broad";
  schemaVersion: 1;
  chainId: 4663;
  manager: string;
  registry: BroadRegistryCheckpoint;
  fromBlock: number;
  toBlock: number;
  fromBlockParentHash: string;
  blockHash: string;
  toTimestamp: number;
  pools: BroadPoolIdentity[];
  swaps: BroadIndexedSwap[];
  observedSwaps: number;
  unregisteredSwaps: number;
  unsupportedSwaps: number;
  /** Dated observations only; no validity beyond this exact cutoff is implied. */
  tokenUnits?: BroadTokenUnits[];
  /** One shared bundle for the whole range, including unregistered manager logs.
   * Receipts are fetched only for registered swaps. No Transfer coverage claim. */
  evidence: {
    swapLogs: RawLog[];
    receipts: Receipt[];
    headers: EventHeader[];
  };
  requests: number;
}
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const capacity = () =>
  Error("Broad event group exceeds capacity; split the range");
function checkedHeader(h: EventHeader, n: number): EventHeader {
  if (
    !h ||
    Number(h.number) !== n ||
    !hash(h.hash) ||
    !hash(h.parentHash) ||
    !integer(Number(h.timestamp))
  )
    throw Error("Invalid broad canonical header");
  return h;
}

/** Broad collection only. No cursor writes, no Transfer query, no PnL projection.
 * Called through collectPoolEventGroup's explicit broad overload. */
export async function collectBroadPoolEvents(
  range: BroadPoolEventRange,
  rpc: Rpc,
): Promise<BroadPoolEventGroup> {
  const { fromBlock, toBlock, resolvePools } = range;
  const registry = { ...range.registry };
  if (
    range.mode !== "broad" ||
    !integer(fromBlock) ||
    fromBlock < instantRegistryStartBlock ||
    !integer(toBlock) ||
    toBlock < fromBlock ||
    toBlock - fromBlock >= broadEventPolicy.maxBlocks ||
    typeof resolvePools !== "function" ||
    (range.receiptMode !== undefined &&
      range.receiptMode !== "transaction" &&
      range.receiptMode !== "block") ||
    (range.collectTokenUnits !== undefined &&
      typeof range.collectTokenUnits !== "boolean")
  )
    throw Error("Invalid broad event range");
  if (
    registry.stream !== "discovery:v2" ||
    registry.revision !== instantRegistryRevision ||
    registry.sourceRevision !== instantRegistrySourceRevision ||
    !integer(registry.throughBlock) ||
    registry.throughBlock < toBlock ||
    !hash(registry.blockHash)
  )
    throw Error("Invalid broad registry checkpoint");
  registry.blockHash = registry.blockHash.toLowerCase();
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!integer(head) || registry.throughBlock > head - 128)
    throw Error("Broad registry exceeds confirmed cutoff");
  const topic = toEventSelector(swapEvent);
  const logs = await rpc.logs(contracts.manager, [topic], fromBlock, toBlock);
  if (!Array.isArray(logs)) throw Error("Invalid broad log result");
  if (logs.length > broadEventPolicy.maxLogs) throw capacity();
  let retainedBytes = 0;
  const retain = (value: unknown) => {
    retainedBytes += Buffer.byteLength(JSON.stringify(value));
    if (retainedBytes > broadEventPolicy.maxBytes) throw capacity();
  };
  retain(logs);
  const identities = new Set<string>();
  for (const l of logs) {
    if (
      !l ||
      l.removed ||
      !address(l.address) ||
      !same(l.address, contracts.manager) ||
      !Array.isArray(l.topics) ||
      l.topics.length !== 3 ||
      l.topics.some((t) => !hash(t)) ||
      !same(l.topics[0], topic) ||
      !/^0x[\da-f]{384}$/i.test(l.data) ||
      !hash(l.blockHash) ||
      !hash(l.transactionHash) ||
      !integer(Number(l.blockNumber)) ||
      Number(l.blockNumber) < fromBlock ||
      Number(l.blockNumber) > toBlock ||
      !integer(Number(l.logIndex))
    )
      throw Error("Unexpected broad event source or range");
    const identity = `${l.transactionHash.toLowerCase()}:${Number(l.logIndex)}`;
    if (identities.has(identity)) throw Error("Duplicate broad event evidence");
    identities.add(identity);
  }
  logs.sort(
    (a, b) =>
      Number(a.blockNumber) - Number(b.blockNumber) ||
      Number(a.logIndex) - Number(b.logIndex) ||
      a.transactionHash
        .toLowerCase()
        .localeCompare(b.transactionHash.toLowerCase()),
  );
  const observedIds = [
    ...new Set(logs.map((l) => l.topics[1].toLowerCase())),
  ].sort();
  const resolved = observedIds.length
    ? await resolvePools(Object.freeze(observedIds))
    : [];
  if (!Array.isArray(resolved) || resolved.length > observedIds.length)
    throw Error("Invalid broad registry resolution");
  const requested = new Set(observedIds);
  const pools = new Map<string, BroadPoolIdentity>();
  for (const p of resolved) {
    if (
      !p ||
      !hash(p.poolId) ||
      !address(p.token) ||
      !integer(p.launchBlock) ||
      p.launchBlock < instantRegistryStartBlock ||
      p.launchBlock > registry.throughBlock ||
      !requested.has(p.poolId.toLowerCase()) ||
      pools.has(p.poolId.toLowerCase())
    )
      throw Error("Invalid broad registry resolution");
    pools.set(p.poolId.toLowerCase(), {
      poolId: p.poolId.toLowerCase(),
      token: p.token.toLowerCase(),
      launchBlock: p.launchBlock,
    });
  }
  const selected = logs.filter((l) => pools.has(l.topics[1].toLowerCase()));
  for (const l of selected)
    if (
      Number(l.blockNumber) < pools.get(l.topics[1].toLowerCase())!.launchBlock
    )
      throw Error("Broad event precedes verified launch");
  const heights = [
    ...new Set([
      fromBlock,
      toBlock,
      registry.throughBlock,
      ...logs.map((l) => Number(l.blockNumber)),
    ]),
  ].sort((a, b) => a - b);
  const headers: EventHeader[] = [];
  for (let i = 0; i < heights.length; i += broadEventPolicy.evidenceChunk) {
    const slice = heights.slice(i, i + broadEventPolicy.evidenceChunk);
    const fetched = await rpc.batch<EventHeader>(
      "eth_getBlockByNumber",
      slice.map((n) => [hex(n), false]),
    );
    if (fetched.length !== slice.length) throw Error("Missing broad headers");
    fetched.forEach((h, j) => checkedHeader(h, slice[j]));
    retain(fetched);
    headers.push(...fetched);
  }
  const blocks = new Map(headers.map((h) => [Number(h.number), h]));
  const cutoff = blocks.get(toBlock)!;
  if (!same(blocks.get(registry.throughBlock)!.hash, registry.blockHash))
    throw Error("Broad registry boundary changed");
  for (const [i, h] of headers.entries()) {
    const n = Number(h.number),
      previous = headers[i - 1];
    if (
      (n <= toBlock && Number(h.timestamp) > Number(cutoff.timestamp)) ||
      (previous && Number(h.timestamp) < Number(previous.timestamp)) ||
      (previous &&
        Number(previous.number) === n - 1 &&
        !same(h.parentHash, previous.hash))
    )
      throw Error("Inconsistent broad canonical headers");
  }
  for (const l of logs)
    if (!same(l.blockHash, blocks.get(Number(l.blockNumber))!.hash))
      throw Error("Inconsistent broad canonical log");
  const hashes = [
    ...new Set(selected.map((l) => l.transactionHash.toLowerCase())),
  ].sort();
  const receipts: Receipt[] = [];
  const receiptByHash = new Map<string, Receipt>();
  if (range.receiptMode === "block") {
    const transactionBlocks = new Map<string, number>();
    for (const log of selected) {
      const tx = log.transactionHash.toLowerCase(),
        block = Number(log.blockNumber);
      if (transactionBlocks.has(tx) && transactionBlocks.get(tx) !== block)
        throw Error("Inconsistent broad transaction block");
      transactionBlocks.set(tx, block);
    }
    const selectedBlocks = [...new Set(transactionBlocks.values())].sort(
      (a, b) => a - b,
    );
    for (
      let i = 0;
      i < selectedBlocks.length;
      i += blockReceiptPolicy.maxBatchCalls
    ) {
      const slice = selectedBlocks.slice(
        i,
        i + blockReceiptPolicy.maxBatchCalls,
      );
      const responses = await rpc.batch<(Receipt & { blockNumber: string })[]>(
        "eth_getBlockReceipts",
        slice.map((n) => [hex(n)]),
      );
      if (responses.length !== slice.length)
        throw Error("Missing broad block receipts");
      for (const [j, rows] of responses.entries()) {
        if (!Array.isArray(rows))
          throw Error("Invalid broad block receipt list");
        if (rows.length > blockReceiptPolicy.maxReceiptsPerBlock)
          throw new RpcResponseCapacity();
        const seen = new Set<string>();
        for (const row of rows) {
          if (
            !row ||
            !hash(row.transactionHash) ||
            !hash(row.blockHash) ||
            !same(row.blockHash, blocks.get(slice[j])!.hash) ||
            typeof row.blockNumber !== "string" ||
            !/^0x[0-9a-f]+$/i.test(row.blockNumber) ||
            Number(row.blockNumber) !== slice[j] ||
            seen.has(row.transactionHash.toLowerCase()) ||
            !["0x0", "0x1"].includes(row.status) ||
            !Array.isArray(row.logs)
          )
            throw Error("Invalid broad block receipt evidence");
          const tx = row.transactionHash.toLowerCase();
          seen.add(tx);
          if (transactionBlocks.has(tx)) {
            if (transactionBlocks.get(tx) !== slice[j] || receiptByHash.has(tx))
              throw Error("Inconsistent broad selected receipt block");
            retain([row]);
            receiptByHash.set(tx, row);
          }
        }
      }
    }
  }
  for (let i = 0; i < hashes.length; i += broadEventPolicy.evidenceChunk) {
    const slice = hashes.slice(i, i + broadEventPolicy.evidenceChunk);
    const fetched =
      range.receiptMode === "block"
        ? slice.map((h) => receiptByHash.get(h)!)
        : await rpc.batch<Receipt>(
            "eth_getTransactionReceipt",
            slice.map((h) => [h]),
          );
    if (fetched.length !== slice.length) throw Error("Missing broad receipts");
    for (let j = 0; j < fetched.length; j++) {
      const r = fetched[j];
      if (
        !r ||
        !hash(r.transactionHash) ||
        !same(r.transactionHash, slice[j]) ||
        !hash(r.blockHash) ||
        r.status !== "0x1" ||
        !address(r.from) ||
        !Array.isArray(r.logs)
      )
        throw Error("Invalid broad receipt");
    }
    if (range.receiptMode !== "block") retain(fetched);
    receipts.push(...fetched);
  }
  const transactions = new Map(
    receipts.map((r) => [r.transactionHash.toLowerCase(), r]),
  );
  const swaps: BroadIndexedSwap[] = selected.map((l) => {
    const r = transactions.get(l.transactionHash.toLowerCase())!;
    const matching = r.logs.filter(
      (e) => Number(e.logIndex) === Number(l.logIndex),
    );
    const e = matching[0];
    if (
      matching.length !== 1 ||
      !e ||
      e.removed ||
      !address(e.address) ||
      !same(e.address, l.address) ||
      !hash(e.transactionHash) ||
      !same(e.transactionHash, l.transactionHash) ||
      !hash(e.blockHash) ||
      !same(e.blockHash, l.blockHash) ||
      !same(r.blockHash, l.blockHash) ||
      Number(e.blockNumber) !== Number(l.blockNumber) ||
      typeof e.data !== "string" ||
      !same(e.data, l.data) ||
      !Array.isArray(e.topics) ||
      !same(e.topics.join(), l.topics.join())
    )
      throw Error("Inconsistent broad receipt evidence");
    const { args } = decodeEventLog({ abi: [swapEvent], ...l, strict: true });
    const buy = args.amount0 < 0n && args.amount1 > 0n;
    const sell = args.amount0 > 0n && args.amount1 < 0n;
    return {
      poolId: l.topics[1].toLowerCase(),
      token: pools.get(l.topics[1].toLowerCase())!.token,
      txHash: l.transactionHash.toLowerCase(),
      logIndex: Number(l.logIndex),
      block: Number(l.blockNumber),
      blockHash: l.blockHash.toLowerCase(),
      timestamp: Number(blocks.get(Number(l.blockNumber))!.timestamp),
      transactionSender: r.from.toLowerCase(),
      managerSender: args.sender.toLowerCase(),
      amount0: args.amount0.toString(),
      amount1: args.amount1.toString(),
      sqrtPriceX96: args.sqrtPriceX96.toString(),
      liquidity: args.liquidity.toString(),
      tick: args.tick,
      fee: args.fee,
      side: buy ? "buy" : sell ? "sell" : null,
      ethWei: buy
        ? (-args.amount0).toString()
        : sell
          ? args.amount0.toString()
          : null,
      tokenRaw: buy
        ? args.amount1.toString()
        : sell
          ? (-args.amount1).toString()
          : null,
      supported: false,
      flags:
        buy || sell
          ? ["missing_transfer_history"]
          : ["missing_transfer_history", "unsupported_swap_signs"],
    };
  });
  let tokenUnits: BroadTokenUnits[] | undefined;
  if (range.collectTokenUnits) {
    tokenUnits = [];
    const tokens = [...new Set([...pools.values()].map((p) => p.token))].sort();
    for (
      let i = 0;
      i < tokens.length;
      i += broadEventPolicy.evidenceChunk / 2
    ) {
      const slice = tokens.slice(i, i + broadEventPolicy.evidenceChunk / 2);
      // Pin the state calls themselves to the observed fork, not just a height.
      // Providers without canonical hash selectors fail closed; no fallback.
      const results = await rpc.batch<string>(
        "eth_call",
        slice.flatMap((token) =>
          ["0x313ce567", "0x18160ddd"].map((data) => [
            { to: token, data },
            { blockHash: cutoff.hash.toLowerCase(), requireCanonical: true },
          ]),
        ),
      );
      if (results.length !== slice.length * 2)
        throw Error("Missing broad token units results");
      retain(results);
      for (const [j, token] of slice.entries()) {
        const decimalsResult = results[j * 2],
          totalSupplyResult = results[j * 2 + 1];
        if (
          typeof decimalsResult !== "string" ||
          typeof totalSupplyResult !== "string" ||
          !/^0x[\da-f]{64}$/i.test(decimalsResult) ||
          !/^0x[\da-f]{64}$/i.test(totalSupplyResult) ||
          BigInt(decimalsResult) > 255n
        )
          throw Error("Invalid broad token units results");
        tokenUnits.push({
          token,
          block: toBlock,
          blockHash: cutoff.hash.toLowerCase(),
          timestamp: Number(cutoff.timestamp),
          decimals: Number(BigInt(decimalsResult)),
          totalSupply: BigInt(totalSupplyResult).toString(),
          decimalsResult,
          totalSupplyResult,
        });
      }
    }
  }
  const result: BroadPoolEventGroup = {
    mode: "broad",
    schemaVersion: 1,
    chainId: 4663,
    manager: contracts.manager,
    registry,
    fromBlock,
    toBlock,
    fromBlockParentHash: blocks.get(fromBlock)!.parentHash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: Number(cutoff.timestamp),
    pools: [...pools.values()].sort((a, b) => a.poolId.localeCompare(b.poolId)),
    swaps,
    observedSwaps: logs.length,
    unregisteredSwaps: logs.length - selected.length,
    unsupportedSwaps: swaps.filter((s) => s.side === null).length,
    ...(tokenUnits === undefined ? {} : { tokenUnits }),
    evidence: { swapLogs: logs, receipts, headers },
    requests: rpc.requests,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > broadEventPolicy.maxBytes)
    throw capacity();
  // These must hit the provider again, not a cached evidence adapter.
  const ends = [...new Set([fromBlock, toBlock, registry.throughBlock])];
  const final = await rpc.batch<EventHeader>(
    "eth_getBlockByNumber",
    ends.map((n) => [hex(n), false]),
  );
  if (final.length !== ends.length)
    throw Error("Missing broad boundary recheck");
  for (let i = 0; i < ends.length; i++) {
    const h = checkedHeader(final[i], ends[i]);
    if (
      !same(h.hash, blocks.get(ends[i])!.hash) ||
      !same(h.parentHash, blocks.get(ends[i])!.parentHash)
    )
      throw Error("Broad boundary changed during collection");
  }
  result.requests = rpc.requests;
  if (Buffer.byteLength(JSON.stringify(result)) > broadEventPolicy.maxBytes)
    throw capacity();
  return result;
}
