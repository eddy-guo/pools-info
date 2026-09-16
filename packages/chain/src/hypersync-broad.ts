import { decodeEventLog, toEventSelector } from "viem";
import { isDeepStrictEqual } from "node:util";
import { contracts, swapEvent } from "./events";
import {
  instantRegistryRevision,
  instantRegistrySourceRevision,
  instantRegistryStartBlock,
} from "./deployments";
import {
  broadEventPolicy,
  type BroadIndexedSwap,
  type BroadPoolEventGroup,
  type BroadPoolIdentity,
  type BroadRegistryCheckpoint,
} from "./broad-pool-events";
import {
  HyperSyncClient,
  blockTimestamp,
  checkedBlockRow,
  checkedLogRow,
  checkedRetainedBlocks,
  checkedTransactionRow,
  collectLogPages,
  hypersyncPolicy,
  joinedLog,
  logTopics,
  swapLogQuery,
  type HyperSyncBlockRow,
  type HyperSyncLogRow,
  type HyperSyncPageRecord,
  type HyperSyncQuery,
  type HyperSyncTransactionRow,
} from "./hypersync";

/** Transaction-shaped broad evidence. It sits beside the receipt-shaped
 * variant: the same group rows, counts and checkpoint, with the returned log,
 * transaction and block fields retained verbatim instead of receipts and
 * JSON-RPC headers. Unregistered manager swaps are retained as their distinct
 * pool ids and a count so the writer can re-resolve every observed id against
 * the pinned registry without storing rows no reader uses. */
export interface HyperSyncBroadEvidence {
  source: "hypersync";
  schemaVersion: 1;
  url: string;
  /** The exact first-page body; later pages differ only in from_block. */
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  /** Registered swap logs only. */
  logs: HyperSyncLogRow[];
  /** Their transactions, one per hash, sorted by hash. */
  transactions: HyperSyncTransactionRow[];
  /** Blocks of the retained logs plus the range and registry boundaries. */
  blocks: HyperSyncBlockRow[];
  unregistered: { swaps: number; poolIds: string[] };
}
/** The same group as the receipt-shaped collector, with HyperSync evidence. */
export type HyperSyncBroadGroup = Omit<BroadPoolEventGroup, "evidence"> & {
  evidence: HyperSyncBroadEvidence;
};
/** Either evidence variant is accepted by the one broad commit path. */
export type BroadGroupInput = BroadPoolEventGroup | HyperSyncBroadGroup;
export const isHyperSyncGroup = (
  group: BroadGroupInput,
): group is HyperSyncBroadGroup =>
  "source" in group.evidence && group.evidence.source === "hypersync";
export interface HyperSyncBroadRange {
  fromBlock: number;
  toBlock: number;
  registry: BroadRegistryCheckpoint;
  resolvePools: (
    observedIds: readonly string[],
  ) => Promise<readonly BroadPoolIdentity[]>;
  /** Whole pages consumed per batch before the range is cut short. */
  maxPages?: number;
  /** An archive height the caller just read from the same client. */
  height?: number;
  /** Boundary headers the caller just read from the same client; they seed
   * the retained blocks and save a read, and are rechecked by the caller. */
  headers?: readonly HyperSyncBlockRow[];
}
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const capacity = () =>
  Error("Broad event group exceeds capacity; split the range");

/** Every observed manager pool id in a group, whichever evidence variant. */
export function observedBroadPoolIds(group: BroadGroupInput): string[] {
  const ids = isHyperSyncGroup(group)
    ? [
        ...group.evidence.logs.map((l) => String(l.topic1).toLowerCase()),
        ...group.evidence.unregistered.poolIds,
      ]
    : group.evidence.swapLogs.map((l) => l.topics[1].toLowerCase());
  return [...new Set(ids)].sort();
}
function checkedSwapLog(
  log: HyperSyncLogRow,
  fromBlock: number,
  toBlock: number,
) {
  const topics = logTopics(log);
  if (
    !same(log.address, contracts.manager) ||
    topics.length !== 3 ||
    !same(topics[0], toEventSelector(swapEvent)) ||
    !/^0x[\da-f]{384}$/i.test(log.data) ||
    log.removed === true ||
    log.block_number < fromBlock ||
    log.block_number > toBlock
  )
    throw Error("Unexpected HyperSync swap source or range");
  return topics;
}
function swapRow(
  log: HyperSyncLogRow,
  pool: BroadPoolIdentity,
  transaction: HyperSyncTransactionRow,
  block: HyperSyncBlockRow,
): BroadIndexedSwap {
  const { args } = decodeEventLog({
    abi: [swapEvent],
    data: log.data as `0x${string}`,
    topics: logTopics(log) as [`0x${string}`, ...`0x${string}`[]],
    strict: true,
  });
  const buy = args.amount0 < 0n && args.amount1 > 0n;
  const sell = args.amount0 > 0n && args.amount1 < 0n;
  return {
    poolId: pool.poolId,
    token: pool.token,
    txHash: log.transaction_hash.toLowerCase(),
    logIndex: log.log_index,
    block: log.block_number,
    blockHash: log.block_hash.toLowerCase(),
    timestamp: blockTimestamp(block),
    transactionSender: transaction.from.toLowerCase(),
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
}
/** Derive the rows a HyperSync group claims from its retained evidence. Pure;
 * the registry membership itself is the writer's to re-resolve. */
function derive(
  group: Pick<
    BroadPoolEventGroup,
    "fromBlock" | "toBlock" | "registry" | "pools"
  >,
  evidence: HyperSyncBroadEvidence,
) {
  const { fromBlock, toBlock, registry } = group;
  if (
    evidence.source !== "hypersync" ||
    evidence.schemaVersion !== 1 ||
    typeof evidence.url !== "string" ||
    !Array.isArray(evidence.pages) ||
    !Array.isArray(evidence.logs) ||
    !Array.isArray(evidence.transactions) ||
    !Array.isArray(evidence.blocks) ||
    !evidence.unregistered ||
    !integer(evidence.unregistered.swaps) ||
    !Array.isArray(evidence.unregistered.poolIds) ||
    evidence.logs.length > broadEventPolicy.maxLogs ||
    evidence.unregistered.swaps > broadEventPolicy.maxLogs ||
    evidence.unregistered.poolIds.length > broadEventPolicy.maxLogs ||
    evidence.pages.length < 1 ||
    evidence.pages.length > 64
  )
    throw Error("Invalid HyperSync broad evidence");
  const expectedQuery = swapLogQuery({
    fromBlock,
    toBlock: Number(evidence.query.to_block) - 1,
  });
  if (
    !isDeepStrictEqual(evidence.query, expectedQuery) ||
    expectedQuery.to_block! - 1 < toBlock ||
    expectedQuery.to_block! - 1 - fromBlock >= broadEventPolicy.maxBlocks
  )
    throw Error("HyperSync broad query disagrees with the range");
  let next = fromBlock;
  for (const page of evidence.pages) {
    if (
      page.fromBlock !== next ||
      !integer(page.nextBlock) ||
      page.nextBlock <= page.fromBlock ||
      page.nextBlock > expectedQuery.to_block! ||
      page.archiveHeight === null ||
      !integer(page.archiveHeight) ||
      page.archiveHeight - hypersyncPolicy.safeDistance < toBlock ||
      !integer(page.logs) ||
      !integer(page.bytes)
    )
      throw Error("HyperSync broad pages disagree with the range");
    next = page.nextBlock;
  }
  if (toBlock !== Math.min(expectedQuery.to_block! - 1, next - 1))
    throw Error("HyperSync broad pages disagree with the range");
  const pools = new Map(group.pools.map((p) => [p.poolId, p]));
  const transactions = new Map<string, HyperSyncTransactionRow>();
  for (const [i, raw] of evidence.transactions.entries()) {
    const t = checkedTransactionRow(raw);
    const key = t.hash.toLowerCase();
    const previous = evidence.transactions[i - 1];
    if (
      transactions.has(key) ||
      (previous && previous.hash.toLowerCase() >= key)
    )
      throw Error("HyperSync broad transactions are not unique and sorted");
    transactions.set(key, t);
  }
  const blocks = new Map<number, HyperSyncBlockRow>();
  for (const raw of evidence.blocks) {
    const b = checkedBlockRow(raw);
    if (blocks.has(b.number)) throw Error("HyperSync broad blocks repeat");
    blocks.set(b.number, b);
  }
  const retained = checkedRetainedBlocks([...blocks.values()], toBlock);
  if (!isDeepStrictEqual(retained, evidence.blocks))
    throw Error("HyperSync broad blocks are not sorted");
  const identities = new Set<string>();
  const usedTransactions = new Set<string>();
  const usedBlocks = new Set<number>([
    fromBlock,
    toBlock,
    registry.throughBlock,
  ]);
  const swaps: BroadIndexedSwap[] = [];
  let previous: HyperSyncLogRow | undefined;
  for (const raw of evidence.logs) {
    const log = checkedLogRow(raw);
    const topics = checkedSwapLog(log, fromBlock, toBlock);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (identities.has(identity))
      throw Error("Duplicate HyperSync swap evidence");
    identities.add(identity);
    if (
      previous &&
      (previous.block_number > log.block_number ||
        (previous.block_number === log.block_number &&
          (previous.log_index > log.log_index ||
            (previous.log_index === log.log_index &&
              previous.transaction_hash.toLowerCase() >=
                log.transaction_hash.toLowerCase()))))
    )
      throw Error("HyperSync broad logs are not sorted");
    previous = log;
    const pool = pools.get(topics[1].toLowerCase());
    if (!pool || log.block_number < pool.launchBlock)
      throw Error("HyperSync swap outside the resolved registry");
    const { transaction, block } = joinedLog(log, transactions, blocks);
    usedTransactions.add(transaction.hash.toLowerCase());
    usedBlocks.add(block.number);
    swaps.push(swapRow(log, pool, transaction, block));
  }
  if (
    usedTransactions.size !== transactions.size ||
    usedBlocks.size !== blocks.size
  )
    throw Error("HyperSync broad evidence retains unrelated rows");
  const observed = new Set(swaps.map((s) => s.poolId));
  if (
    observed.size !== pools.size ||
    [...pools.keys()].some((id) => !observed.has(id))
  )
    throw Error("HyperSync broad pools disagree with the retained logs");
  const unregistered = evidence.unregistered.poolIds;
  for (const [i, id] of unregistered.entries())
    if (
      !hash(id) ||
      id !== id.toLowerCase() ||
      pools.has(id) ||
      (i > 0 && unregistered[i - 1] >= id)
    )
      throw Error("Invalid HyperSync unregistered pool ids");
  if (unregistered.length > evidence.unregistered.swaps)
    throw Error("Invalid HyperSync unregistered pool ids");
  const pinned = blocks.get(registry.throughBlock)!;
  if (!same(pinned.hash, registry.blockHash))
    throw Error("Broad registry boundary changed");
  const first = blocks.get(fromBlock)!,
    cutoff = blocks.get(toBlock)!;
  return {
    swaps,
    fromBlockParentHash: first.parent_hash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
    observedSwaps: swaps.length + evidence.unregistered.swaps,
    unregisteredSwaps: evidence.unregistered.swaps,
    unsupportedSwaps: swaps.filter((s) => s.side === null).length,
  };
}
/** Re-derive a HyperSync group from its retained evidence with no network and
 * reject any row, count or boundary the evidence does not support. */
export function verifyHyperSyncBroadGroup(group: HyperSyncBroadGroup): void {
  if (
    group.mode !== "broad" ||
    group.schemaVersion !== 1 ||
    group.chainId !== 4663 ||
    group.manager !== contracts.manager ||
    group.tokenUnits !== undefined ||
    !isHyperSyncGroup(group) ||
    !integer(group.fromBlock) ||
    group.fromBlock < instantRegistryStartBlock ||
    !integer(group.toBlock) ||
    group.toBlock < group.fromBlock ||
    group.registry.stream !== "discovery:v2" ||
    group.registry.revision !== instantRegistryRevision ||
    group.registry.sourceRevision !== instantRegistrySourceRevision ||
    !integer(group.registry.throughBlock) ||
    group.registry.throughBlock < group.toBlock ||
    !hash(group.registry.blockHash) ||
    group.registry.blockHash !== group.registry.blockHash.toLowerCase() ||
    !Array.isArray(group.pools) ||
    group.pools.length > broadEventPolicy.maxLogs ||
    group.pools.some(
      (p, i) =>
        !hash(p.poolId) ||
        p.poolId !== p.poolId.toLowerCase() ||
        !address(p.token) ||
        p.token !== p.token.toLowerCase() ||
        !integer(p.launchBlock) ||
        p.launchBlock < instantRegistryStartBlock ||
        p.launchBlock > group.registry.throughBlock ||
        (i > 0 && group.pools[i - 1].poolId >= p.poolId),
    )
  )
    throw Error("Invalid HyperSync broad group");
  const derived = derive(group, group.evidence);
  const claimed = {
    swaps: group.swaps,
    fromBlockParentHash: group.fromBlockParentHash,
    blockHash: group.blockHash,
    toTimestamp: group.toTimestamp,
    observedSwaps: group.observedSwaps,
    unregisteredSwaps: group.unregisteredSwaps,
    unsupportedSwaps: group.unsupportedSwaps,
  };
  if (!isDeepStrictEqual(claimed, derived))
    throw Error("HyperSync broad rows disagree with retained evidence");
}
/** Collect one broad range from HyperSync: every manager Swap log in the
 * range with its transaction and block, filtered locally against the pinned
 * registry. The range ends at the last block-complete page that fits the
 * broad caps, so a dense stretch shortens the batch instead of failing it. */
export async function collectHyperSyncBroadGroup(
  range: HyperSyncBroadRange,
  client: HyperSyncClient,
): Promise<HyperSyncBroadGroup> {
  const { fromBlock, resolvePools } = range;
  const registry = { ...range.registry };
  const maxPages = range.maxPages ?? 4;
  if (
    !integer(fromBlock) ||
    fromBlock < instantRegistryStartBlock ||
    !integer(range.toBlock) ||
    range.toBlock < fromBlock ||
    range.toBlock - fromBlock >= broadEventPolicy.maxBlocks ||
    typeof resolvePools !== "function" ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 16 ||
    (range.height !== undefined && !integer(range.height)) ||
    (range.headers !== undefined && !Array.isArray(range.headers))
  )
    throw Error("Invalid HyperSync broad range");
  if (
    registry.stream !== "discovery:v2" ||
    registry.revision !== instantRegistryRevision ||
    registry.sourceRevision !== instantRegistrySourceRevision ||
    !integer(registry.throughBlock) ||
    registry.throughBlock < range.toBlock ||
    !hash(registry.blockHash)
  )
    throw Error("Invalid broad registry checkpoint");
  registry.blockHash = registry.blockHash.toLowerCase();
  const height = range.height ?? (await client.height());
  if (
    !integer(height) ||
    registry.throughBlock > height - hypersyncPolicy.safeDistance ||
    range.toBlock > height - hypersyncPolicy.safeDistance
  )
    throw Error("HyperSync range exceeds the confirmed cutoff");
  const query = swapLogQuery({ fromBlock, toBlock: range.toBlock });
  const collected = await collectLogPages(client, query, {
    maxPages,
    maxLogs: broadEventPolicy.maxLogs,
    maxBytes: broadEventPolicy.maxBytes,
  });
  const toBlock = collected.toBlock;
  const identities = new Set<string>();
  for (const log of collected.logs) {
    checkedSwapLog(log, fromBlock, toBlock);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (identities.has(identity))
      throw Error("Duplicate HyperSync swap evidence");
    identities.add(identity);
  }
  const observedIds = [
    ...new Set(collected.logs.map((l) => logTopics(l)[1].toLowerCase())),
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
  const selected = collected.logs.filter((l) =>
    pools.has(logTopics(l)[1].toLowerCase()),
  );
  const blocks = new Map(collected.blocks);
  for (const raw of range.headers ?? []) {
    const h = checkedBlockRow(raw);
    const prior = blocks.get(h.number);
    if (prior && !same(prior.hash, h.hash))
      throw Error("Inconsistent HyperSync canonical headers");
    if (!prior) blocks.set(h.number, h);
  }
  const boundary = async (n: number) => {
    if (!blocks.has(n)) blocks.set(n, await client.header(n));
    return blocks.get(n)!;
  };
  const first = await boundary(fromBlock);
  const cutoff = await boundary(toBlock);
  const pinned = await boundary(registry.throughBlock);
  if (!same(pinned.hash, registry.blockHash))
    throw Error("Broad registry boundary changed");
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const retained = new Map<number, HyperSyncBlockRow>([
    [fromBlock, first],
    [toBlock, cutoff],
    [registry.throughBlock, pinned],
  ]);
  const swaps: BroadIndexedSwap[] = selected.map((log) => {
    const pool = pools.get(logTopics(log)[1].toLowerCase())!;
    if (log.block_number < pool.launchBlock)
      throw Error("Broad event precedes verified launch");
    const { transaction, block } = joinedLog(
      log,
      collected.transactions,
      blocks,
    );
    transactions.set(transaction.hash.toLowerCase(), transaction);
    retained.set(block.number, block);
    return swapRow(log, pool, transaction, block);
  });
  const evidence: HyperSyncBroadEvidence = {
    source: "hypersync",
    schemaVersion: 1,
    url: client.url,
    query,
    pages: collected.pages,
    logs: selected,
    transactions: [...transactions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, t]) => t),
    blocks: checkedRetainedBlocks([...retained.values()], toBlock),
    unregistered: {
      swaps: collected.logs.length - selected.length,
      poolIds: observedIds.filter((id) => !pools.has(id)),
    },
  };
  const result: HyperSyncBroadGroup = {
    mode: "broad",
    schemaVersion: 1,
    chainId: 4663,
    manager: contracts.manager,
    registry,
    fromBlock,
    toBlock,
    fromBlockParentHash: first.parent_hash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
    pools: [...pools.values()].sort((a, b) => a.poolId.localeCompare(b.poolId)),
    swaps,
    observedSwaps: collected.logs.length,
    unregisteredSwaps: collected.logs.length - selected.length,
    unsupportedSwaps: swaps.filter((s) => s.side === null).length,
    evidence,
    requests: client.requests,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > broadEventPolicy.maxBytes)
    throw capacity();
  verifyHyperSyncBroadGroup(result);
  return result;
}
