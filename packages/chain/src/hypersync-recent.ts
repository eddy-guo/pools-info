import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import { isDeepStrictEqual } from "node:util";
import type { CatalogPool } from "@pools/core";
import {
  contracts,
  decodeLaunch,
  decodeSwap,
  launchEvent,
  swapEvent,
} from "./events";
import { getInstantDeployment } from "./deployments";
import {
  decodeTokenMetadata,
  tokenMetadataFactory,
  tokenMetadataTopic,
  type TokenMetadata,
  type TokenMetadataIssue,
} from "./token-metadata";
import {
  expandContractReads,
  multicallConfig,
  readContracts,
  type ContractReadEvidence,
  type MulticallConfig,
} from "./multicall";
import type { Rpc } from "./rpc";
import type { RecentPoolIdentity, VerifiedRecentSwap } from "./recent-events";
import {
  HyperSyncClient,
  blockTimestamp,
  checkedBlockRow,
  checkedLogRow,
  checkedQuery,
  checkedRetainedBlocks,
  checkedTransactionRow,
  collectLogPages,
  hypersyncFields,
  hypersyncPolicy,
  joinedLog,
  logTopics,
  rawLogOf,
  type HyperSyncBlockRow,
  type HyperSyncLogRow,
  type HyperSyncPageRecord,
  type HyperSyncQuery,
  type HyperSyncTransactionRow,
} from "./hypersync";

/** The live tip worker's HyperSync source (docs/HYPERSYNC-TIP.md). One query
 * per cycle serves both recent lanes: PoolManager swaps, strategy launches
 * with factory metadata, and the launcher's own logs, joined to their
 * transactions and to every block of the range. The evidence keeps the recent
 * batch schema and content hash; only its rows change shape: the returned
 * log, transaction and block fields are retained verbatim where the JSON-RPC
 * path retained receipts and headers, labelled by `source` and `stream`. */
export const hypersyncRecentStream = "recent:hypersync:v1" as const;
export const hypersyncRecentPolicy = Object.freeze({
  /** commitRecentBatch bounds a batch below 2,000 blocks. */
  maxBlocks: 2000,
  /** Observed logs per batch, the recent lane's existing cap. */
  maxLogs: 10000,
  /** Verified launches per batch, the catalog collector's existing cap. */
  maxLaunches: 250,
  /** Whole pages consumed per cycle before the range is cut short. */
  maxPages: 16,
  /** Response bytes consumed per cycle. */
  maxBytes: 24 * 1024 * 1024,
});
const swapTopic = toEventSelector(swapEvent),
  launchTopic = toEventSelector(launchEvent);
const discoverySources: readonly string[] = [
  ...contracts.strategies,
  tokenMetadataFactory,
];
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hexData = (v: string, bytes: number) =>
  new RegExp(`^0x[\\da-f]{${bytes * 2}}$`, "i").test(v);
/** Whether retained recent evidence is the HyperSync variant; the writer
 * dispatches its verification on this, as the broad writer does. */
export function isHyperSyncRecentEvidence(evidence: unknown): boolean {
  return (
    !!evidence &&
    typeof evidence === "object" &&
    "source" in evidence &&
    evidence.source === "hypersync"
  );
}
const provenance = <T extends { source: string; stream: string }>(e: T) =>
  e.source === "hypersync" && e.stream === hypersyncRecentStream;

/** Both lanes' logs and the launcher's, joined to transactions and to every
 * block of the range so the boundary headers and the parent-link chain come
 * with the page and no header read follows. */
export function recentLogQuery(range: {
  fromBlock: number;
  toBlock: number;
}): HyperSyncQuery {
  if (
    !integer(range.fromBlock) ||
    !integer(range.toBlock) ||
    range.toBlock < range.fromBlock ||
    range.toBlock - range.fromBlock >= hypersyncRecentPolicy.maxBlocks
  )
    throw Error("Invalid HyperSync recent range");
  return checkedQuery({
    from_block: range.fromBlock,
    to_block: range.toBlock + 1,
    include_all_blocks: true,
    logs: [
      { address: [contracts.manager], topics: [[swapTopic]] },
      {
        address: [...discoverySources],
        topics: [[launchTopic, tokenMetadataTopic]],
      },
      { address: [...contracts.launchers] },
    ],
    field_selection: {
      block: [...hypersyncFields.block],
      transaction: [...hypersyncFields.transaction],
      log: [...hypersyncFields.log],
    },
    max_num_logs: hypersyncPolicy.maxLogsPerPage,
  });
}
export interface HyperSyncRecentPages {
  url: string;
  /** The exact first-page body; later pages differ only in from_block. */
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  /** Every returned log, sorted by block, log index and hash. */
  logs: HyperSyncLogRow[];
  transactions: ReadonlyMap<string, HyperSyncTransactionRow>;
  /** Every block from fromBlock through toBlock, parent-linked. */
  blocks: ReadonlyMap<number, HyperSyncBlockRow>;
  fromBlock: number;
  /** The last block-complete page's end, at most the requested end. */
  toBlock: number;
  archiveHeight: number;
}
/** Collect one confirmed range in whole pages. The range ends at the last
 * complete page that fits the caps, so a dense stretch shortens the batch
 * instead of failing it, and every block of the consumed range is checked to
 * form one parent-linked chain with non-decreasing timestamps. */
export async function collectRecentPages(
  client: HyperSyncClient,
  range: {
    fromBlock: number;
    toBlock: number;
    /** An archive height the caller just read from the same client. */
    height: number;
    maxPages?: number;
  },
): Promise<HyperSyncRecentPages> {
  const maxPages = range.maxPages ?? 4;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > hypersyncRecentPolicy.maxPages ||
    !integer(range.height)
  )
    throw Error("Invalid HyperSync recent range");
  const query = recentLogQuery(range);
  if (range.toBlock > range.height - hypersyncPolicy.safeDistance)
    throw Error("HyperSync range exceeds the confirmed cutoff");
  const collected = await collectLogPages(client, query, {
    maxPages,
    maxLogs: hypersyncRecentPolicy.maxLogs,
    maxBytes: hypersyncRecentPolicy.maxBytes,
  });
  const { fromBlock } = range,
    { toBlock } = collected;
  for (let n = fromBlock; n <= toBlock; n++) {
    const block = collected.blocks.get(n);
    if (!block) throw Error("HyperSync recent page is missing headers");
    const previous = collected.blocks.get(n - 1);
    if (
      previous &&
      (!same(block.parent_hash, previous.hash) ||
        blockTimestamp(block) < blockTimestamp(previous))
    )
      throw Error("Inconsistent HyperSync canonical headers");
  }
  // An address OR and a topic OR are a cross product; every returned log must
  // belong to one of the three selections exactly, as on the JSON-RPC path.
  for (const log of collected.logs)
    if (
      log.block_number < fromBlock ||
      log.block_number > toBlock ||
      !(
        (same(log.address, contracts.manager) && same(log.topic0, swapTopic)) ||
        (discoverySources.some((a) => same(a, log.address)) &&
          (same(log.topic0, launchTopic) ||
            same(log.topic0, tokenMetadataTopic))) ||
        contracts.launchers.some((a) => same(a, log.address))
      )
    )
      throw Error("Unexpected HyperSync recent source or range");
  return {
    url: client.url,
    query,
    pages: collected.pages,
    logs: collected.logs,
    transactions: collected.transactions,
    blocks: collected.blocks,
    fromBlock,
    toBlock,
    archiveHeight: collected.archiveHeight,
  };
}

/** The distinct pool ids of the manager swaps a cycle observed, for resolving
 * only those against the registry before the swap batch is built. */
export function observedRecentPoolIds(pages: HyperSyncRecentPages): string[] {
  const ids = new Set<string>();
  for (const log of pages.logs)
    if (same(log.address, contracts.manager) && same(log.topic0, swapTopic)) {
      if (!hash(log.topic1))
        throw Error("Unexpected recent event pool identity");
      ids.add(log.topic1.toLowerCase());
    }
  return [...ids].sort();
}
/** Transaction-shaped recent swap evidence. Where the JSON-RPC variant kept
 * `logs`, `headers` and `receipts`, this keeps the registered swap logs, their
 * transactions (`from` is the initiator, `status` the receipt status) and the
 * blocks the batch depends on. Unregistered manager swaps are kept as their
 * distinct pool ids and a count, as in the broad variant. */
export interface HyperSyncRecentSwapEvidence {
  source: "hypersync";
  stream: typeof hypersyncRecentStream;
  schemaVersion: 1;
  url: string;
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  /** Registered manager swap logs, sorted by block, log index and hash. */
  logs: HyperSyncLogRow[];
  /** Their transactions, one per hash, sorted by hash. */
  transactions: HyperSyncTransactionRow[];
  /** The from and to boundaries plus each retained log's block, ascending. */
  blocks: HyperSyncBlockRow[];
  unregistered: { swaps: number; poolIds: string[] };
}
export interface HyperSyncRecentSwapBatch {
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  fromBlockParentHash: string;
  toTimestamp: number;
  events: VerifiedRecentSwap[];
  observedSwaps: number;
  unregisteredSwaps: number;
  unsupportedSwaps: number;
  evidence: HyperSyncRecentSwapEvidence;
}
function checkedPools(pools: readonly RecentPoolIdentity[]) {
  if (pools.length > 10000) throw Error("Invalid recent event range");
  const map = new Map<string, RecentPoolIdentity>();
  for (const p of pools) {
    if (
      !hash(p.id) ||
      !address(p.token) ||
      !integer(p.launchBlock) ||
      map.has(p.id.toLowerCase())
    )
      throw Error("Invalid recent pool identity");
    map.set(p.id.toLowerCase(), p);
  }
  return map;
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
    !same(topics[0], swapTopic) ||
    !hexData(log.data, 192) ||
    log.removed === true ||
    log.block_number < fromBlock ||
    log.block_number > toBlock
  )
    throw Error("Unexpected HyperSync recent source or range");
  return topics;
}
function checkedPageRecords(
  evidence: { query: HyperSyncQuery; pages: HyperSyncPageRecord[] },
  fromBlock: number,
  toBlock: number,
) {
  const end = Number(evidence.query?.to_block) - 1;
  if (
    !integer(end) ||
    end < toBlock ||
    end - fromBlock >= hypersyncRecentPolicy.maxBlocks
  )
    throw Error("HyperSync recent query disagrees with the range");
  const expected = recentLogQuery({ fromBlock, toBlock: end });
  if (
    !isDeepStrictEqual(evidence.query, expected) ||
    !Array.isArray(evidence.pages) ||
    evidence.pages.length < 1 ||
    evidence.pages.length > hypersyncRecentPolicy.maxPages ||
    expected.to_block! - 1 < toBlock
  )
    throw Error("HyperSync recent query disagrees with the range");
  let next = fromBlock;
  for (const page of evidence.pages) {
    if (
      !page ||
      typeof page !== "object" ||
      page.fromBlock !== next ||
      !integer(page.nextBlock) ||
      page.nextBlock <= page.fromBlock ||
      page.nextBlock > expected.to_block! ||
      page.archiveHeight === null ||
      !integer(page.archiveHeight) ||
      page.archiveHeight - hypersyncPolicy.safeDistance < toBlock ||
      !integer(page.logs) ||
      !integer(page.bytes)
    )
      throw Error("HyperSync recent pages disagree with the range");
    next = page.nextBlock;
  }
  if (toBlock !== Math.min(expected.to_block! - 1, next - 1))
    throw Error("HyperSync recent pages disagree with the range");
}
function checkedEvidenceRows(evidence: {
  transactions: HyperSyncTransactionRow[];
  blocks: HyperSyncBlockRow[];
}) {
  const transactions = new Map<string, HyperSyncTransactionRow>();
  for (const [i, raw] of evidence.transactions.entries()) {
    const t = checkedTransactionRow(raw);
    const key = t.hash.toLowerCase();
    const previous = evidence.transactions[i - 1];
    if (
      transactions.has(key) ||
      (previous && previous.hash.toLowerCase() >= key)
    )
      throw Error("HyperSync recent transactions are not unique and sorted");
    transactions.set(key, t);
  }
  const blocks = new Map<number, HyperSyncBlockRow>();
  for (const raw of evidence.blocks) {
    const b = checkedBlockRow(raw);
    if (blocks.has(b.number)) throw Error("HyperSync recent blocks repeat");
    blocks.set(b.number, b);
  }
  return { transactions, blocks };
}
const sortedTransactions = (rows: Iterable<HyperSyncTransactionRow>) =>
  [...rows].sort((a, b) => {
    const x = a.hash.toLowerCase(),
      y = b.hash.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
/** Derive the rows a swap batch claims from its retained evidence. Pure; the
 * registry membership itself is the writer's to re-resolve at commit. */
function deriveSwaps(
  range: { fromBlock: number; toBlock: number },
  evidence: HyperSyncRecentSwapEvidence,
  pools: ReadonlyMap<string, RecentPoolIdentity>,
) {
  const { fromBlock, toBlock } = range;
  if (
    !provenance(evidence) ||
    evidence.schemaVersion !== 1 ||
    typeof evidence.url !== "string" ||
    !Array.isArray(evidence.logs) ||
    !Array.isArray(evidence.transactions) ||
    !Array.isArray(evidence.blocks) ||
    !evidence.unregistered ||
    !integer(evidence.unregistered.swaps) ||
    !Array.isArray(evidence.unregistered.poolIds) ||
    evidence.logs.length + evidence.unregistered.swaps >
      hypersyncRecentPolicy.maxLogs ||
    evidence.unregistered.poolIds.length > evidence.unregistered.swaps
  )
    throw Error("Invalid HyperSync recent evidence");
  checkedPageRecords(evidence, fromBlock, toBlock);
  const { transactions, blocks } = checkedEvidenceRows(evidence);
  const retained = checkedRetainedBlocks([...blocks.values()], toBlock);
  if (!isDeepStrictEqual(retained, evidence.blocks))
    throw Error("HyperSync recent blocks are not sorted");
  const identities = new Set<string>();
  const usedTransactions = new Set<string>();
  const usedBlocks = new Set<number>([fromBlock, toBlock]);
  const events: VerifiedRecentSwap[] = [];
  let unsupportedSwaps = 0;
  let previous: HyperSyncLogRow | undefined;
  for (const raw of evidence.logs) {
    const log = checkedLogRow(raw);
    const topics = checkedSwapLog(log, fromBlock, toBlock);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (identities.has(identity))
      throw Error("Duplicate HyperSync recent evidence");
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
      throw Error("HyperSync recent logs are not sorted");
    previous = log;
    const pool = pools.get(topics[1].toLowerCase());
    if (!pool) throw Error("HyperSync swap outside the resolved registry");
    if (log.block_number < pool.launchBlock)
      throw Error("Recent event precedes verified launch");
    const { transaction, block } = joinedLog(log, transactions, blocks);
    usedTransactions.add(transaction.hash.toLowerCase());
    usedBlocks.add(block.number);
    let d: ReturnType<typeof decodeSwap>;
    try {
      d = decodeSwap(rawLogOf(log));
    } catch (e) {
      if (e instanceof Error && e.message === "Unsupported swap signs") {
        unsupportedSwaps++;
        continue;
      }
      throw e;
    }
    if (!same(d.id, pool.id))
      throw Error("Unexpected recent event pool identity");
    events.push({
      poolId: pool.id.toLowerCase(),
      token: pool.token.toLowerCase(),
      txHash: log.transaction_hash.toLowerCase(),
      logIndex: log.log_index,
      block: log.block_number,
      blockHash: log.block_hash.toLowerCase(),
      timestamp: blockTimestamp(block),
      // The initiator of the transaction, never the beneficiary of the swap.
      transactionSender: transaction.from.toLowerCase(),
      amount0: d.amount0.toString(),
      amount1: d.amount1.toString(),
      ethWei: d.ethWei,
      tokenRaw: d.tokenRaw,
      side: d.side,
    });
  }
  if (
    usedTransactions.size !== transactions.size ||
    usedBlocks.size !== blocks.size
  )
    throw Error("HyperSync recent evidence retains unrelated rows");
  const unregistered = evidence.unregistered.poolIds;
  for (const [i, id] of unregistered.entries())
    if (
      !hash(id) ||
      id !== id.toLowerCase() ||
      pools.has(id) ||
      (i > 0 && unregistered[i - 1] >= id)
    )
      throw Error("Invalid HyperSync unregistered pool ids");
  const first = blocks.get(fromBlock)!,
    cutoff = blocks.get(toBlock)!;
  return {
    fromBlock,
    toBlock,
    blockHash: cutoff.hash.toLowerCase(),
    fromBlockParentHash: first.parent_hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
    events,
    observedSwaps: evidence.logs.length + evidence.unregistered.swaps,
    unregisteredSwaps: evidence.unregistered.swaps,
    unsupportedSwaps,
  };
}
/** Re-derive a swap batch from its retained evidence with no network and
 * reject any row, count or boundary the evidence does not support. */
export function verifyHyperSyncRecentSwaps(
  batch: HyperSyncRecentSwapBatch,
  pools: readonly RecentPoolIdentity[],
): void {
  if (
    !integer(batch.fromBlock) ||
    !integer(batch.toBlock) ||
    batch.toBlock < batch.fromBlock ||
    batch.toBlock - batch.fromBlock >= hypersyncRecentPolicy.maxBlocks
  )
    throw Error("Invalid HyperSync recent batch");
  const { evidence, ...claimed } = batch;
  const derived = deriveSwaps(batch, evidence, checkedPools(pools));
  if (!isDeepStrictEqual(claimed, derived))
    throw Error("HyperSync recent rows disagree with retained evidence");
}
/** The swap lane's batch from one cycle's pages: every manager swap in the
 * range is observed, the registered ones are retained with their transaction
 * and block, and the result is re-derived from the retained evidence before
 * it is returned. */
export function recentSwapsFromPages(
  pages: HyperSyncRecentPages,
  pools: readonly RecentPoolIdentity[],
): HyperSyncRecentSwapBatch {
  const { fromBlock, toBlock } = pages;
  const registry = checkedPools(pools);
  const observed = pages.logs.filter(
    (l) => same(l.address, contracts.manager) && same(l.topic0, swapTopic),
  );
  if (observed.length > hypersyncRecentPolicy.maxLogs)
    throw Error("Recent batch exceeds 10000 logs");
  const identities = new Set<string>();
  const observedIds = new Set<string>();
  for (const log of observed) {
    const topics = checkedSwapLog(log, fromBlock, toBlock);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (identities.has(identity))
      throw Error("Duplicate HyperSync recent evidence");
    identities.add(identity);
    observedIds.add(topics[1].toLowerCase());
  }
  const selected = observed.filter((l) =>
    registry.has(logTopics(l)[1].toLowerCase()),
  );
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const retained = new Map<number, HyperSyncBlockRow>();
  for (const n of [fromBlock, toBlock]) {
    const block = pages.blocks.get(n);
    if (!block) throw Error("HyperSync recent page is missing headers");
    retained.set(n, block);
  }
  for (const log of selected) {
    const { transaction, block } = joinedLog(
      log,
      pages.transactions,
      pages.blocks,
    );
    transactions.set(transaction.hash.toLowerCase(), transaction);
    retained.set(block.number, block);
  }
  const evidence: HyperSyncRecentSwapEvidence = {
    source: "hypersync",
    stream: hypersyncRecentStream,
    schemaVersion: 1,
    url: pages.url,
    query: pages.query,
    pages: pages.pages,
    logs: selected,
    transactions: sortedTransactions(transactions.values()),
    blocks: checkedRetainedBlocks([...retained.values()], toBlock),
    unregistered: {
      swaps: observed.length - selected.length,
      poolIds: [...observedIds].filter((id) => !registry.has(id)).sort(),
    },
  };
  return { ...deriveSwaps(pages, evidence, registry), evidence };
}

/** Transaction-shaped recent launch evidence. Where the JSON-RPC catalog
 * variant kept `logs`, `receipts` and `headers`, this keeps the verified
 * launch logs, the launcher's logs in those transactions (the receipt check
 * that the launcher ran), the factory metadata logs, the launch transactions
 * (`from` is the launch sender) and the blocks the batch depends on. The
 * token name and symbol are still contract reads and stay as `calls`. */
export interface HyperSyncRecentLaunchEvidence {
  source: "hypersync";
  stream: typeof hypersyncRecentStream;
  schemaVersion: 1;
  url: string;
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  /** Verified strategy TokenLaunched logs, sorted by block, index and hash. */
  logs: HyperSyncLogRow[];
  /** Launcher logs sharing a launch transaction, in the same order. */
  launcherLogs: HyperSyncLogRow[];
  /** Factory TokenCreated logs sharing a launch transaction. */
  tokenMetadataLogs: HyperSyncLogRow[];
  /** The launch transactions, one per hash, sorted by hash. */
  transactions: HyperSyncTransactionRow[];
  /** The from and to boundaries plus each launch block, ascending. */
  blocks: HyperSyncBlockRow[];
  tokenMetadataIssues: {
    transactionHash: string;
    logIndex: number;
    reason: TokenMetadataIssue | "unmatched_token" | "ambiguous_metadata";
  }[];
  /** Raw name and symbol replies from the JSON-RPC provider at the cutoff. */
  calls: ContractReadEvidence[];
}
export interface HyperSyncRecentLaunchBatch {
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  fromBlockParentHash: string;
  toTimestamp: number;
  pools: CatalogPool[];
  evidence: HyperSyncRecentLaunchEvidence;
}
const metadataFields = ["name", "symbol"] as const;
const readKey = (to: string, data: string) =>
  `${to.toLowerCase()}:${data.toLowerCase()}`;
const metadataRead = (token: string, field: (typeof metadataFields)[number]) =>
  ({
    to: token as Hex,
    data: encodeFunctionData({ abi: erc20Abi, functionName: field }),
  }) as const;
function presentation(metadata: TokenMetadata | null | undefined) {
  if (!metadata) return {};
  const { token: _token, ...fields } = metadata;
  return fields;
}
/** Everything a launch batch claims except the contract reads: the verified
 * launches with their transaction, block and launcher proof, and the matched
 * factory metadata. Shared by the collector and the verifier. */
function launchRows(
  range: { fromBlock: number; toBlock: number },
  evidence: Omit<
    HyperSyncRecentLaunchEvidence,
    "calls" | "tokenMetadataIssues"
  >,
) {
  const { fromBlock, toBlock } = range;
  if (
    !provenance(evidence) ||
    evidence.schemaVersion !== 1 ||
    typeof evidence.url !== "string" ||
    !Array.isArray(evidence.logs) ||
    !Array.isArray(evidence.launcherLogs) ||
    !Array.isArray(evidence.tokenMetadataLogs) ||
    !Array.isArray(evidence.transactions) ||
    !Array.isArray(evidence.blocks) ||
    evidence.logs.length > hypersyncRecentPolicy.maxLaunches
  )
    throw Error("Invalid HyperSync recent evidence");
  checkedPageRecords(evidence, fromBlock, toBlock);
  const { transactions, blocks } = checkedEvidenceRows(evidence);
  const retained = checkedRetainedBlocks([...blocks.values()], toBlock);
  if (!isDeepStrictEqual(retained, evidence.blocks))
    throw Error("HyperSync recent blocks are not sorted");
  const ordered = (rows: HyperSyncLogRow[], name: string) => {
    const seen = new Set<string>();
    let previous: HyperSyncLogRow | undefined;
    return rows.map((raw) => {
      const log = checkedLogRow(raw);
      const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
      if (seen.has(identity))
        throw Error("Duplicate HyperSync recent evidence");
      seen.add(identity);
      if (
        log.removed === true ||
        log.block_number < fromBlock ||
        log.block_number > toBlock ||
        (previous &&
          (previous.block_number > log.block_number ||
            (previous.block_number === log.block_number &&
              (previous.log_index > log.log_index ||
                (previous.log_index === log.log_index &&
                  previous.transaction_hash.toLowerCase() >=
                    log.transaction_hash.toLowerCase())))))
      )
        throw Error(`HyperSync recent ${name} are not sorted`);
      previous = log;
      return log;
    });
  };
  const launchLogs = ordered(evidence.logs, "launch logs");
  const launcherLogs = ordered(evidence.launcherLogs, "launcher logs");
  const metadataLogs = ordered(evidence.tokenMetadataLogs, "metadata logs");
  const usedTransactions = new Set<string>();
  const usedBlocks = new Set<number>([fromBlock, toBlock]);
  const launches = launchLogs.map((log) => {
    const deployment = getInstantDeployment(log.address);
    if (!deployment || !same(log.topic0, launchTopic))
      throw Error("Unexpected launch source");
    if (log.block_number < deployment.deployedAtBlock)
      throw Error("Launch precedes verified deployment");
    const decoded = decodeLaunch(rawLogOf(log));
    const { transaction, block } = joinedLog(log, transactions, blocks);
    const txHash = log.transaction_hash.toLowerCase();
    if (
      !launcherLogs.some(
        (l) =>
          l.transaction_hash.toLowerCase() === txHash &&
          same(l.address, deployment.launcher) &&
          same(l.block_hash, log.block_hash) &&
          l.block_number === log.block_number,
      )
    )
      throw Error("Unverified catalog launch");
    usedTransactions.add(txHash);
    usedBlocks.add(block.number);
    return { log, decoded, transaction, block };
  });
  const launchTransactions = new Set(usedTransactions);
  for (const l of launcherLogs) {
    const t = transactions.get(l.transaction_hash.toLowerCase());
    if (
      !launchTransactions.has(l.transaction_hash.toLowerCase()) ||
      !contracts.launchers.some((a) => same(a, l.address)) ||
      !t ||
      !same(t.block_hash, l.block_hash) ||
      t.block_number !== l.block_number
    )
      throw Error("HyperSync recent evidence retains unrelated rows");
  }
  const issues: HyperSyncRecentLaunchEvidence["tokenMetadataIssues"] = [];
  const matched = new Map<string, TokenMetadata | null>();
  const identities = new Set(
    launches.map(
      (l) =>
        `${l.log.transaction_hash.toLowerCase()}:${l.decoded.token.toLowerCase()}`,
    ),
  );
  for (const l of metadataLogs) {
    const txHash = l.transaction_hash.toLowerCase();
    const t = transactions.get(txHash);
    if (
      !launchTransactions.has(txHash) ||
      !same(l.address, tokenMetadataFactory) ||
      !same(l.topic0, tokenMetadataTopic) ||
      !t ||
      !same(t.block_hash, l.block_hash) ||
      t.block_number !== l.block_number
    )
      throw Error("Unverified catalog token metadata");
    const { metadata, issues: found } = decodeTokenMetadata(rawLogOf(l));
    for (const reason of found)
      issues.push({ transactionHash: txHash, logIndex: l.log_index, reason });
    if (!metadata) continue;
    const key = `${txHash}:${metadata.token}`;
    if (!identities.has(key)) {
      issues.push({
        transactionHash: txHash,
        logIndex: l.log_index,
        reason: "unmatched_token",
      });
      continue;
    }
    if (matched.has(key)) {
      matched.set(key, null);
      issues.push({
        transactionHash: txHash,
        logIndex: l.log_index,
        reason: "ambiguous_metadata",
      });
    } else matched.set(key, metadata);
  }
  if (
    usedTransactions.size !== transactions.size ||
    usedBlocks.size !== blocks.size
  )
    throw Error("HyperSync recent evidence retains unrelated rows");
  const first = blocks.get(fromBlock)!,
    cutoff = blocks.get(toBlock)!;
  return {
    launches,
    matched,
    issues,
    blockHash: cutoff.hash.toLowerCase(),
    fromBlockParentHash: first.parent_hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
  };
}
function launchPools(
  rows: ReturnType<typeof launchRows>["launches"],
  matched: ReadonlyMap<string, TokenMetadata | null>,
  results: readonly Hex[],
): CatalogPool[] {
  const pools = new Map<string, CatalogPool>();
  for (const [i, { log, decoded, transaction, block }] of rows.entries()) {
    const id = decoded.poolId.toLowerCase();
    if (pools.has(id)) throw Error("Duplicate recent launch identity");
    pools.set(id, {
      ...presentation(
        matched.get(
          `${log.transaction_hash.toLowerCase()}:${decoded.token.toLowerCase()}`,
        ),
      ),
      id,
      token: decoded.token.toLowerCase(),
      name: String(
        decodeFunctionResult({
          abi: erc20Abi,
          functionName: "name",
          data: results[i * 2],
        }),
      ).slice(0, 160),
      symbol: String(
        decodeFunctionResult({
          abi: erc20Abi,
          functionName: "symbol",
          data: results[i * 2 + 1],
        }),
      ).slice(0, 40),
      launchTx: log.transaction_hash.toLowerCase(),
      // The transaction initiator, exactly what receipt.from supplied before.
      launchSender: transaction.from.toLowerCase(),
      launchBlock: log.block_number,
      launchedAt: blockTimestamp(block),
    });
  }
  return [...pools.values()].sort(
    (a, b) => b.launchBlock - a.launchBlock || a.id.localeCompare(b.id),
  );
}
/** Re-derive a launch batch from its retained evidence with no network: the
 * launches from the logs, transactions and blocks, and each name and symbol
 * from the retained contract-read replies. */
export function verifyHyperSyncRecentLaunches(
  batch: HyperSyncRecentLaunchBatch,
): void {
  if (
    !integer(batch.fromBlock) ||
    !integer(batch.toBlock) ||
    batch.toBlock < batch.fromBlock ||
    batch.toBlock - batch.fromBlock >= hypersyncRecentPolicy.maxBlocks ||
    !Array.isArray(batch.evidence?.calls) ||
    !Array.isArray(batch.evidence?.tokenMetadataIssues)
  )
    throw Error("Invalid HyperSync recent batch");
  const { evidence, ...claimed } = batch;
  const rows = launchRows(batch, evidence);
  const replies = new Map<string, Hex | null>();
  for (const read of expandContractReads(evidence.calls))
    replies.set(readKey(read.to, read.data), read.result);
  const results = rows.launches.flatMap(({ decoded }) =>
    metadataFields.map((field) => {
      const read = metadataRead(decoded.token, field);
      const result = replies.get(readKey(read.to, read.data));
      if (result === undefined || result === null)
        throw Error("HyperSync recent launch calls disagree with the evidence");
      return result;
    }),
  );
  if (replies.size !== results.length)
    throw Error("HyperSync recent evidence retains unrelated rows");
  const derived = {
    fromBlock: batch.fromBlock,
    toBlock: batch.toBlock,
    blockHash: rows.blockHash,
    fromBlockParentHash: rows.fromBlockParentHash,
    toTimestamp: rows.toTimestamp,
    pools: launchPools(rows.launches, rows.matched, results),
  };
  if (
    !isDeepStrictEqual(claimed, derived) ||
    !isDeepStrictEqual(evidence.tokenMetadataIssues, rows.issues)
  )
    throw Error("HyperSync recent rows disagree with retained evidence");
}
/** The discovery lane's batch from one cycle's pages. The launches, their
 * senders, timestamps and launcher proof come from the pages; only the token
 * name and symbol are read from the JSON-RPC provider, as bounded Multicall3
 * aggregates at the cutoff, and only when the range holds a launch. */
export async function recentLaunchesFromPages(
  pages: HyperSyncRecentPages,
  rpc: Rpc,
  multicall: MulticallConfig = multicallConfig(),
): Promise<HyperSyncRecentLaunchBatch> {
  const { fromBlock, toBlock } = pages;
  const launchLogs = pages.logs.filter(
    (l) => getInstantDeployment(l.address) && same(l.topic0, launchTopic),
  );
  if (launchLogs.length > hypersyncRecentPolicy.maxLaunches)
    throw Error(
      "Catalog batch exceeds 250 launches; split the scan before publishing",
    );
  const launchTransactions = new Set(
    launchLogs.map((l) => l.transaction_hash.toLowerCase()),
  );
  const inLaunch = (l: HyperSyncLogRow) =>
    launchTransactions.has(l.transaction_hash.toLowerCase());
  const launcherLogs = pages.logs.filter(
    (l) => inLaunch(l) && contracts.launchers.some((a) => same(a, l.address)),
  );
  const tokenMetadataLogs = pages.logs.filter(
    (l) =>
      inLaunch(l) &&
      same(l.address, tokenMetadataFactory) &&
      same(l.topic0, tokenMetadataTopic),
  );
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const retained = new Map<number, HyperSyncBlockRow>();
  for (const n of [fromBlock, toBlock]) {
    const block = pages.blocks.get(n);
    if (!block) throw Error("HyperSync recent page is missing headers");
    retained.set(n, block);
  }
  for (const log of launchLogs) {
    const { transaction, block } = joinedLog(
      log,
      pages.transactions,
      pages.blocks,
    );
    transactions.set(transaction.hash.toLowerCase(), transaction);
    retained.set(block.number, block);
  }
  const partial = {
    source: "hypersync" as const,
    stream: hypersyncRecentStream,
    schemaVersion: 1 as const,
    url: pages.url,
    query: pages.query,
    pages: pages.pages,
    logs: launchLogs,
    launcherLogs,
    tokenMetadataLogs,
    transactions: sortedTransactions(transactions.values()),
    blocks: checkedRetainedBlocks([...retained.values()], toBlock),
  };
  const rows = launchRows(pages, partial);
  let calls: ContractReadEvidence[] = [];
  let results: Hex[] = [];
  if (rows.launches.length) {
    if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
      throw Error("Wrong chain");
    const reads = await readContracts(
      rpc,
      rows.launches.flatMap(({ decoded }) =>
        metadataFields.map((field) => metadataRead(decoded.token, field)),
      ),
      toBlock,
      multicall,
    );
    calls = reads.evidence;
    results = reads.results;
  }
  const batch: HyperSyncRecentLaunchBatch = {
    fromBlock,
    toBlock,
    blockHash: rows.blockHash,
    fromBlockParentHash: rows.fromBlockParentHash,
    toTimestamp: rows.toTimestamp,
    pools: launchPools(rows.launches, rows.matched, results),
    evidence: { ...partial, tokenMetadataIssues: rows.issues, calls },
  };
  verifyHyperSyncRecentLaunches(batch);
  return batch;
}
