import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CatalogPool, LedgerSwap, LedgerTransfer } from "@pools/core";
import {
  contracts,
  decodeLaunch,
  decodeSwap,
  launchEvent,
  swapEvent,
  transferEvent,
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
import {
  HyperSyncClient,
  blockTimestamp,
  checkedBlockRow,
  checkedLogRow,
  checkedQuery,
  checkedRetainedBlocks,
  checkedTransactionRow,
  chunkValues,
  collectLogPages,
  headerQuery,
  hypersyncFields,
  hypersyncPolicy,
  joinedLog,
  logTopics,
  rawLogOf,
  swapLogQuery,
  transferLogQuery,
  type HyperSyncBlockRow,
  type HyperSyncLogRow,
  type HyperSyncPageRecord,
  type HyperSyncQuery,
  type HyperSyncTransactionRow,
} from "./hypersync";

/** The aggregate ledger's one-time history pass over HyperSync
 * (docs/AGGREGATE-LEDGER.md phase 2, design report section 7.1). One range
 * is three lanes over the same blocks: the strategies' TokenLaunched logs
 * with the factory metadata and the launchers' logs, the PoolManager swaps of
 * every registered pool (the registry as of the range end leads the filter),
 * and the ERC-20 transfers of every registered token. Every row is validated
 * and joined to a successful transaction and its block; the range ends on the
 * last whole page every lane completed; the launches keep their evidence in
 * the launch stream, the swaps and transfers keep only their content hash in
 * the ledger batch. Name, symbol and decimals are the one JSON-RPC read, over
 * the public RPC through Multicall3 at its head, because that RPC serves no
 * historical state. */
export const ledgerLaunchStream = "launches:agg:v1" as const;
export const ledgerPassPolicy = Object.freeze({
  /** The first launch (report section 2); nothing registered exists before. */
  startBlock: 23467030,
  /** Blocks per range; a dense range ends early on a whole page. */
  rangeBlocks: 100000,
  maxRangeBlocks: 1000000,
  /** Measured (report 3.1): 20,000 pool ids in one topics[1] selection are a
   * 1.38 MB body and 31,200 token addresses 1.40 MB; the limit is the 2 MiB
   * body, so one selection per query. */
  poolIdsPerQuery: 20000,
  tokensPerQuery: 31000,
  /** Whole pages consumed per lane query before the range is cut short. */
  maxPages: 16,
  maxLogs: 80000,
  maxBytes: 24 * 1024 * 1024,
  /** Verified launches per range; the August burst peaked near 1,200. */
  maxLaunches: 5000,
  /** The pass hands over once a fresh archive height leaves a gap this small
   * past the safety lag: on a chain that never stops producing blocks, a
   * catch-up loop that waits for an exact zero gap never exits. */
  catchUpMargin: 2000,
});
const swapTopic = toEventSelector(swapEvent),
  launchTopic = toEventSelector(launchEvent),
  transferTopic = toEventSelector(transferEvent);
const discoverySources: readonly string[] = [
  ...contracts.strategies,
  tokenMetadataFactory,
];
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const lower = (s: string) => s.toLowerCase();
const hexData = (v: string, bytes: number) =>
  new RegExp(`^0x[\\da-f]{${bytes * 2}}$`, "i").test(v);
const logOrder = (a: HyperSyncLogRow, b: HyperSyncLogRow) =>
  a.block_number - b.block_number ||
  a.log_index - b.log_index ||
  a.transaction_hash
    .toLowerCase()
    .localeCompare(b.transaction_hash.toLowerCase());

export interface LedgerBlockRange {
  fromBlock: number;
  toBlock: number;
}
function checkedRange(range: LedgerBlockRange) {
  if (
    !integer(range.fromBlock) ||
    !integer(range.toBlock) ||
    range.toBlock < range.fromBlock ||
    range.toBlock - range.fromBlock >= ledgerPassPolicy.maxRangeBlocks
  )
    throw Error("Invalid HyperSync ledger range");
}
/** The launch lane: strategy TokenLaunched and factory TokenCreated logs, and
 * every log of the launchers (the proof that the launcher ran in the launch
 * transaction), joined to transactions and to the blocks that carry them. */
export function ledgerLaunchQuery(range: LedgerBlockRange): HyperSyncQuery {
  checkedRange(range);
  return checkedQuery({
    from_block: range.fromBlock,
    to_block: range.toBlock + 1,
    logs: [
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
function checkedValues(values: readonly string[], test: RegExp, what: string) {
  const sorted = [...new Set(values.map(lower))].sort();
  for (const v of sorted) if (!test.test(v)) throw Error(what);
  return sorted;
}
/** The swap lane's queries: the registered pool ids, sorted, in selections of
 * `poolIdsPerQuery`, one selection per query. */
export function ledgerSwapQueries(
  range: LedgerBlockRange,
  poolIds: readonly string[],
): HyperSyncQuery[] {
  checkedRange(range);
  const ids = checkedValues(
    poolIds,
    /^0x[\da-f]{64}$/,
    "Invalid HyperSync pool id selection",
  );
  return chunkValues(ids, ledgerPassPolicy.poolIdsPerQuery).map((chunk) =>
    swapLogQuery(range, chunk, ledgerPassPolicy.poolIdsPerQuery),
  );
}
/** The transfer lane's queries: the registered token addresses, sorted, in
 * selections of `tokensPerQuery`, one selection per query. */
export function ledgerTransferQueries(
  range: LedgerBlockRange,
  tokens: readonly string[],
): HyperSyncQuery[] {
  checkedRange(range);
  const addresses = checkedValues(
    tokens,
    /^0x[\da-f]{40}$/,
    "Invalid HyperSync token selection",
  );
  return chunkValues(addresses, ledgerPassPolicy.tokensPerQuery).map((chunk) =>
    transferLogQuery(range, chunk, ledgerPassPolicy.tokensPerQuery),
  );
}
/** What the batch row keeps of a value-list query: the range, the number of
 * values and a digest of the sorted list, never the list itself; the list is
 * the registry as of the range end, reconstructible from the catalog. */
export interface LedgerQueryRecord {
  from_block: number;
  to_block: number;
  selection: "pool_ids" | "tokens";
  count: number;
  sha256: string;
}
export function ledgerQueryRecord(query: HyperSyncQuery): LedgerQueryRecord {
  const selection = query.logs?.[0];
  if (!selection || query.logs!.length !== 1 || query.to_block === undefined)
    throw Error("Invalid HyperSync ledger query");
  const values = selection.topics?.[1] ?? selection.address ?? [];
  const kind = selection.topics?.[1] ? "pool_ids" : "tokens";
  return {
    from_block: query.from_block,
    to_block: query.to_block,
    selection: kind,
    count: values.length,
    sha256: "0x" + createHash("sha256").update(values.join("\n")).digest("hex"),
  };
}

/** A registered pool the lanes may select: launched at or before the range
 * end, with its token and launch block. */
export interface LedgerRegistryPool {
  poolId: string;
  token: string;
  launchBlock: number;
}
export interface LedgerCatalogPool extends CatalogPool {
  /** ERC-20 decimals; null when the read did not decode to 0..36. */
  decimals: number | null;
  /** The launch log's site, which the ledger batch names per launch. */
  launchBlockHash: string;
  launchLogIndex: number;
}
/** Transaction-shaped launch evidence retained by the launch stream, beside
 * the JSON-RPC catalog variant and the recent HyperSync variant: the verified
 * launch logs, the launcher logs and factory metadata in their transactions,
 * the launch transactions, the launch blocks and the cutoff header, and the
 * raw Multicall3 replies that supplied name, symbol and decimals. */
export interface LedgerLaunchEvidence {
  source: "hypersync";
  stream: typeof ledgerLaunchStream;
  schemaVersion: 1;
  url: string;
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  logs: HyperSyncLogRow[];
  launcherLogs: HyperSyncLogRow[];
  tokenMetadataLogs: HyperSyncLogRow[];
  transactions: HyperSyncTransactionRow[];
  blocks: HyperSyncBlockRow[];
  tokenMetadataIssues: {
    transactionHash: string;
    logIndex: number;
    reason: TokenMetadataIssue | "unmatched_token" | "ambiguous_metadata";
  }[];
  /** Read at the provider's head, not the cutoff: the public RPC serves no
   * historical state, and these fields are immutable for factory tokens. */
  calls: ContractReadEvidence[];
  archiveHeight: number;
}
export interface LedgerLaunchBatch {
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  toTimestamp: number;
  pools: LedgerCatalogPool[];
  evidence: LedgerLaunchEvidence;
}
const metadataFields = ["name", "symbol", "decimals"] as const;
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
      throw Error("HyperSync ledger transactions are not unique and sorted");
    transactions.set(key, t);
  }
  const blocks = new Map<number, HyperSyncBlockRow>();
  for (const raw of evidence.blocks) {
    const b = checkedBlockRow(raw);
    if (blocks.has(b.number)) throw Error("HyperSync ledger blocks repeat");
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
function orderedLogs(
  rows: HyperSyncLogRow[],
  range: LedgerBlockRange,
  name: string,
) {
  const seen = new Set<string>();
  let previous: HyperSyncLogRow | undefined;
  return rows.map((raw) => {
    const log = checkedLogRow(raw);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (seen.has(identity)) throw Error("Duplicate HyperSync ledger evidence");
    seen.add(identity);
    if (
      log.removed === true ||
      log.block_number < range.fromBlock ||
      log.block_number > range.toBlock ||
      (previous && logOrder(previous, log) >= 0)
    )
      throw Error(`HyperSync ledger ${name} are not sorted`);
    previous = log;
    return log;
  });
}
/** Everything a launch batch claims except the contract reads, derived from
 * the retained rows alone: each launch verified by its strategy's deployment,
 * `decodeLaunch`, a successful transaction, a launcher log in that
 * transaction and the factory metadata matched to its token. Shared by the
 * collector and the verifier. */
function ledgerLaunchRows(
  range: LedgerBlockRange,
  evidence: Omit<LedgerLaunchEvidence, "calls" | "tokenMetadataIssues">,
) {
  if (
    evidence.source !== "hypersync" ||
    evidence.stream !== ledgerLaunchStream ||
    evidence.schemaVersion !== 1 ||
    typeof evidence.url !== "string" ||
    !Array.isArray(evidence.logs) ||
    !Array.isArray(evidence.launcherLogs) ||
    !Array.isArray(evidence.tokenMetadataLogs) ||
    !Array.isArray(evidence.transactions) ||
    !Array.isArray(evidence.blocks) ||
    !Array.isArray(evidence.pages) ||
    !integer(evidence.archiveHeight) ||
    evidence.archiveHeight - hypersyncPolicy.safeDistance < range.toBlock ||
    evidence.logs.length > ledgerPassPolicy.maxLaunches
  )
    throw Error("Invalid HyperSync ledger evidence");
  const expected = ledgerLaunchQuery({
    fromBlock: range.fromBlock,
    toBlock: Number(evidence.query?.to_block) - 1,
  });
  if (
    !isDeepStrictEqual(evidence.query, expected) ||
    expected.to_block! - 1 < range.toBlock ||
    evidence.pages.length < 1 ||
    evidence.pages.length > ledgerPassPolicy.maxPages
  )
    throw Error("HyperSync ledger query disagrees with the range");
  let next = range.fromBlock;
  for (const page of evidence.pages) {
    if (
      !page ||
      typeof page !== "object" ||
      page.fromBlock !== next ||
      !integer(page.nextBlock) ||
      page.nextBlock <= page.fromBlock ||
      page.archiveHeight === null ||
      !integer(page.archiveHeight) ||
      page.archiveHeight - hypersyncPolicy.safeDistance < range.toBlock
    )
      throw Error("HyperSync ledger pages disagree with the range");
    next = page.nextBlock;
  }
  if (next - 1 < range.toBlock)
    throw Error("HyperSync ledger pages disagree with the range");
  const { transactions, blocks } = checkedEvidenceRows(evidence);
  const retained = checkedRetainedBlocks([...blocks.values()], range.toBlock);
  if (!isDeepStrictEqual(retained, evidence.blocks))
    throw Error("HyperSync ledger blocks are not sorted");
  const launchLogs = orderedLogs(evidence.logs, range, "launch logs");
  const launcherLogs = orderedLogs(
    evidence.launcherLogs,
    range,
    "launcher logs",
  );
  const metadataLogs = orderedLogs(
    evidence.tokenMetadataLogs,
    range,
    "metadata logs",
  );
  const usedTransactions = new Set<string>();
  const usedBlocks = new Set<number>([range.toBlock]);
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
  for (const l of launcherLogs) {
    const t = transactions.get(l.transaction_hash.toLowerCase());
    if (
      !usedTransactions.has(l.transaction_hash.toLowerCase()) ||
      !contracts.launchers.some((a) => same(a, l.address)) ||
      !t ||
      !same(t.block_hash, l.block_hash) ||
      t.block_number !== l.block_number
    )
      throw Error("HyperSync ledger evidence retains unrelated rows");
  }
  const issues: LedgerLaunchEvidence["tokenMetadataIssues"] = [];
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
      !usedTransactions.has(txHash) ||
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
    throw Error("HyperSync ledger evidence retains unrelated rows");
  const cutoff = blocks.get(range.toBlock)!;
  return {
    launches,
    matched,
    issues,
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
  };
}
function decodedDecimals(data: Hex): number | null {
  try {
    const value = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      data,
    });
    return Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
  } catch {
    return null;
  }
}
function launchPools(
  rows: ReturnType<typeof ledgerLaunchRows>["launches"],
  matched: ReadonlyMap<string, TokenMetadata | null>,
  results: readonly Hex[],
): LedgerCatalogPool[] {
  const pools = new Map<string, LedgerCatalogPool>();
  for (const [i, { log, decoded, transaction, block }] of rows.entries()) {
    const id = decoded.poolId.toLowerCase();
    if (pools.has(id)) throw Error("Duplicate ledger launch identity");
    const at = i * metadataFields.length;
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
          data: results[at],
        }),
      ).slice(0, 160),
      symbol: String(
        decodeFunctionResult({
          abi: erc20Abi,
          functionName: "symbol",
          data: results[at + 1],
        }),
      ).slice(0, 40),
      decimals: decodedDecimals(results[at + 2]),
      launchTx: log.transaction_hash.toLowerCase(),
      launchSender: transaction.from.toLowerCase(),
      launchBlock: log.block_number,
      launchedAt: blockTimestamp(block),
      launchBlockHash: log.block_hash.toLowerCase(),
      launchLogIndex: log.log_index,
    });
  }
  return [...pools.values()].sort(
    (a, b) => a.launchBlock - b.launchBlock || a.id.localeCompare(b.id),
  );
}
/** Re-derive a launch batch from its retained evidence with no network and
 * reject any row, pool or issue the evidence does not support. */
export function verifyLedgerLaunchBatch(batch: LedgerLaunchBatch): void {
  if (
    !integer(batch.fromBlock) ||
    !integer(batch.toBlock) ||
    batch.toBlock < batch.fromBlock ||
    batch.toBlock - batch.fromBlock >= ledgerPassPolicy.maxRangeBlocks ||
    !Array.isArray(batch.evidence?.calls) ||
    !Array.isArray(batch.evidence?.tokenMetadataIssues)
  )
    throw Error("Invalid HyperSync ledger batch");
  const { evidence, ...claimed } = batch;
  const rows = ledgerLaunchRows(batch, evidence);
  const replies = new Map<string, Hex | null>();
  for (const read of expandContractReads(evidence.calls))
    replies.set(readKey(read.to, read.data), read.result);
  const results = rows.launches.flatMap(({ decoded }) =>
    metadataFields.map((field) => {
      const read = metadataRead(decoded.token, field);
      const result = replies.get(readKey(read.to, read.data));
      if (result === undefined || result === null)
        throw Error("HyperSync ledger launch calls disagree with the evidence");
      return result;
    }),
  );
  if (replies.size !== results.length)
    throw Error("HyperSync ledger evidence retains unrelated rows");
  const derived = {
    fromBlock: batch.fromBlock,
    toBlock: batch.toBlock,
    blockHash: rows.blockHash,
    toTimestamp: rows.toTimestamp,
    pools: launchPools(rows.launches, rows.matched, results),
  };
  if (
    !isDeepStrictEqual(claimed, derived) ||
    !isDeepStrictEqual(evidence.tokenMetadataIssues, rows.issues)
  )
    throw Error("HyperSync ledger rows disagree with retained evidence");
}
/** Name, symbol and decimals for the launched tokens through Multicall3 at
 * the provider's current head. `eth_chainId` guards the endpoint first. */
export async function readLaunchMetadata(
  rpc: Rpc,
  tokens: readonly string[],
  multicall: MulticallConfig = multicallConfig(),
): Promise<{ results: Hex[]; calls: ContractReadEvidence[] }> {
  if (!tokens.length) return { results: [], calls: [] };
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!integer(head) || head < 1) throw Error("Invalid chain head");
  const reads = await readContracts(
    rpc,
    tokens.flatMap((token) =>
      metadataFields.map((field) => metadataRead(token, field)),
    ),
    head,
    multicall,
  );
  return { results: reads.results, calls: reads.evidence };
}

export interface LedgerRangeInput {
  fromBlock: number;
  toBlock: number;
  /** The hash of block fromBlock - 1: the saved cursor's, or null on the
   * first range, when the from header supplies it. */
  parentHash: string | null;
  /** An archive height the caller just read from the same client. */
  height: number;
  /** Every pool registered before the range; the range's own launches join
   * the filter as they are found. */
  registry: readonly LedgerRegistryPool[];
  maxPages?: number;
  /** Launches per range; more end the range before the excess. */
  maxLaunches?: number;
  multicall?: MulticallConfig;
}
export interface LedgerRangeCollection {
  fromBlock: number;
  /** The last block every lane completed, at most the requested end. */
  toBlock: number;
  parentHash: string;
  blockHash: string;
  toTimestamp: number;
  archiveHeight: number;
  launch: LedgerLaunchBatch;
  swaps: LedgerSwap[];
  transfers: LedgerTransfer[];
  /** Manager swap logs whose amounts share a sign: not trades, skipped. */
  unsupportedSwaps: number;
  /** Pools in the swap filter as of toBlock. */
  registryPools: number;
  query: {
    launch: HyperSyncQuery;
    swaps: LedgerQueryRecord[];
    transfers: LedgerQueryRecord[];
  };
  pages: {
    launch: HyperSyncPageRecord[];
    swaps: HyperSyncPageRecord[][];
    transfers: HyperSyncPageRecord[][];
    headers: HyperSyncPageRecord[];
  };
  requests: number;
  bytes: number;
}
function checkedSwapLog(log: HyperSyncLogRow) {
  const topics = logTopics(log);
  if (
    !same(log.address, contracts.manager) ||
    topics.length !== 3 ||
    !same(topics[0], swapTopic) ||
    !hexData(log.data, 192) ||
    log.removed === true
  )
    throw Error("Unexpected HyperSync ledger swap");
  return topics;
}
function checkedTransferLog(log: HyperSyncLogRow) {
  const topics = logTopics(log);
  if (
    topics.length !== 3 ||
    !same(topics[0], transferTopic) ||
    !hexData(log.data, 32) ||
    log.removed === true
  )
    throw Error("Unexpected HyperSync ledger transfer");
  return topics;
}
/** Collect one range in whole pages, lane by lane. The launch lane runs
 * first so the range's own launches lead the swap filter; each lane query
 * may end the range early, and every later query is asked only up to the
 * shortest end so far. Rows beyond the final end are dropped; the boundary
 * header is read last and every retained block must form one parent-linked
 * chain with non-decreasing timestamps. */
export async function collectLedgerRange(
  client: HyperSyncClient,
  rpc: Rpc,
  input: LedgerRangeInput,
): Promise<LedgerRangeCollection> {
  checkedRange(input);
  const maxPages = input.maxPages ?? ledgerPassPolicy.maxPages;
  const maxLaunches = input.maxLaunches ?? ledgerPassPolicy.maxLaunches;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > ledgerPassPolicy.maxPages ||
    !Number.isSafeInteger(maxLaunches) ||
    maxLaunches < 1 ||
    maxLaunches > ledgerPassPolicy.maxLaunches ||
    !integer(input.height) ||
    (input.parentHash !== null && !hash(input.parentHash))
  )
    throw Error("Invalid HyperSync ledger range");
  if (input.toBlock > input.height - hypersyncPolicy.safeDistance)
    throw Error("HyperSync range exceeds the confirmed cutoff");
  const caps = {
    maxPages,
    maxLogs: ledgerPassPolicy.maxLogs,
    maxBytes: ledgerPassPolicy.maxBytes,
  };
  const requests0 = client.requests,
    bytes0 = client.bytes;
  const { fromBlock } = input;
  const byPool = new Map<string, LedgerRegistryPool>();
  const byToken = new Map<string, LedgerRegistryPool>();
  const register = (p: LedgerRegistryPool) => {
    const entry = {
      poolId: lower(p.poolId),
      token: lower(p.token),
      launchBlock: p.launchBlock,
    };
    if (
      !hash(entry.poolId) ||
      !address(entry.token) ||
      !integer(entry.launchBlock) ||
      byPool.has(entry.poolId) ||
      byToken.has(entry.token)
    )
      throw Error("Invalid HyperSync ledger registry");
    byPool.set(entry.poolId, entry);
    byToken.set(entry.token, entry);
  };
  for (const p of input.registry) {
    if (p.launchBlock >= fromBlock)
      throw Error("Invalid HyperSync ledger registry");
    register(p);
  }
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const blocks = new Map<number, HyperSyncBlockRow>();
  const merge = (collected: {
    transactions: Map<string, HyperSyncTransactionRow>;
    blocks: Map<number, HyperSyncBlockRow>;
  }) => {
    for (const [key, t] of collected.transactions) {
      const prior = transactions.get(key);
      if (prior && !isDeepStrictEqual(prior, t))
        throw Error("HyperSync returned conflicting transactions");
      transactions.set(key, t);
    }
    for (const [n, b] of collected.blocks) {
      const prior = blocks.get(n);
      if (prior && !isDeepStrictEqual(prior, b))
        throw Error("HyperSync returned conflicting blocks");
      blocks.set(n, b);
    }
  };
  let toBlock = input.toBlock;
  let archiveHeight = input.height;
  // 1. Launches.
  const launchQuery = ledgerLaunchQuery({ fromBlock, toBlock });
  const launchPages = await collectLogPages(client, launchQuery, caps);
  toBlock = Math.min(toBlock, launchPages.toBlock);
  archiveHeight = Math.min(archiveHeight, launchPages.archiveHeight);
  merge(launchPages);
  const launchLogs = launchPages.logs.filter(
    (l) => getInstantDeployment(l.address) && same(l.topic0, launchTopic),
  );
  // A launch burst ends the range before the launch that would exceed the
  // cap; a single block over the cap cannot be split.
  if (launchLogs.length > maxLaunches) {
    const cut = launchLogs[maxLaunches].block_number - 1;
    if (cut < fromBlock)
      throw Error("Ledger range exceeds the launch cap in one block");
    toBlock = Math.min(toBlock, cut);
  }
  const launched = launchLogs.map((log) => {
    const decoded = decodeLaunch(rawLogOf(log));
    return {
      poolId: decoded.poolId.toLowerCase(),
      token: decoded.token.toLowerCase(),
      launchBlock: log.block_number,
    };
  });
  for (const p of launched) register(p);
  // 2. Swaps, the registry as of the range end leading the filter.
  const swapLogs: HyperSyncLogRow[] = [];
  const swapRecords: LedgerQueryRecord[] = [];
  const swapPages: HyperSyncPageRecord[][] = [];
  const poolIds = [...byPool.keys()].sort();
  const poolChunks = chunkValues(poolIds, ledgerPassPolicy.poolIdsPerQuery);
  for (const chunk of poolChunks) {
    const query = swapLogQuery(
      { fromBlock, toBlock },
      chunk,
      ledgerPassPolicy.poolIdsPerQuery,
    );
    const collected = await collectLogPages(client, query, caps);
    toBlock = Math.min(toBlock, collected.toBlock);
    archiveHeight = Math.min(archiveHeight, collected.archiveHeight);
    merge(collected);
    swapLogs.push(...collected.logs);
    swapRecords.push(ledgerQueryRecord(query));
    swapPages.push(collected.pages);
  }
  // 3. Transfers of every registered token.
  const transferLogs: HyperSyncLogRow[] = [];
  const transferRecords: LedgerQueryRecord[] = [];
  const transferPages: HyperSyncPageRecord[][] = [];
  const tokens = [...byToken.keys()].sort();
  for (const chunk of chunkValues(tokens, ledgerPassPolicy.tokensPerQuery)) {
    const query = transferLogQuery(
      { fromBlock, toBlock },
      chunk,
      ledgerPassPolicy.tokensPerQuery,
    );
    const collected = await collectLogPages(client, query, caps);
    toBlock = Math.min(toBlock, collected.toBlock);
    archiveHeight = Math.min(archiveHeight, collected.archiveHeight);
    merge(collected);
    transferLogs.push(...collected.logs);
    transferRecords.push(ledgerQueryRecord(query));
    transferPages.push(collected.pages);
  }
  // 4. The boundary headers: the cutoff always, the parent on the first range.
  const headerPages: HyperSyncPageRecord[] = [];
  const header = async (n: number) => {
    const page = await client.query(headerQuery(n));
    if (
      page.blocks.length !== 1 ||
      page.blocks[0].number !== n ||
      page.archiveHeight === null ||
      page.archiveHeight - hypersyncPolicy.safeDistance < toBlock
    )
      throw Error("HyperSync returned an unexpected header");
    headerPages.push({
      fromBlock: page.fromBlock,
      nextBlock: page.nextBlock,
      archiveHeight: page.archiveHeight,
      totalExecutionTime: page.totalExecutionTime,
      rollbackGuard: page.rollbackGuard,
      logs: 0,
      transactions: 0,
      blocks: 1,
      bytes: page.bytes,
    });
    archiveHeight = Math.min(archiveHeight, page.archiveHeight);
    return page.blocks[0];
  };
  const cutoff = await header(toBlock);
  merge({ transactions: new Map(), blocks: new Map([[toBlock, cutoff]]) });
  const parentHash =
    input.parentHash === null
      ? (fromBlock === toBlock ? cutoff : await header(fromBlock)).parent_hash
      : input.parentHash;
  if (archiveHeight - hypersyncPolicy.safeDistance < toBlock)
    throw Error("HyperSync archive height below the confirmed cutoff");
  // 5. Retained rows end at the final cutoff; the chain of blocks is checked.
  const inRange = (l: HyperSyncLogRow) =>
    l.block_number >= fromBlock && l.block_number <= toBlock;
  const retainedBlocks = new Map(
    [...blocks].filter(([n]) => n >= fromBlock && n <= toBlock),
  );
  checkedRetainedBlocks([...retainedBlocks.values()], toBlock);
  const registryPools = [...byPool.values()].filter(
    (p) => p.launchBlock <= toBlock,
  ).length;
  // 6. Swap rows.
  const swaps: LedgerSwap[] = [];
  const seen = new Set<string>();
  let unsupportedSwaps = 0;
  for (const log of swapLogs.filter(inRange).sort(logOrder)) {
    const topics = checkedSwapLog(log);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (seen.has(identity)) throw Error("Duplicate HyperSync ledger evidence");
    seen.add(identity);
    const pool = byPool.get(topics[1].toLowerCase());
    if (!pool) throw Error("HyperSync swap outside the registry");
    if (log.block_number < pool.launchBlock)
      throw Error("Ledger swap precedes verified launch");
    const { transaction, block } = joinedLog(log, transactions, retainedBlocks);
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
    if (!same(d.id, pool.poolId))
      throw Error("Unexpected ledger swap pool identity");
    swaps.push({
      txHash: log.transaction_hash.toLowerCase(),
      logIndex: log.log_index,
      block: log.block_number,
      blockHash: log.block_hash.toLowerCase(),
      timestamp: blockTimestamp(block),
      poolId: pool.poolId,
      token: pool.token,
      initiator: transaction.from.toLowerCase(),
      txTo: transaction.to === null ? null : transaction.to.toLowerCase(),
      side: d.side,
      ethWei: d.ethWei,
      tokenRaw: d.tokenRaw,
      sqrtPriceX96: d.sqrtPriceX96.toString(),
      liquidity: d.liquidity.toString(),
      tick: d.tick,
    });
  }
  // 7. Transfer rows.
  const transfers: LedgerTransfer[] = [];
  for (const log of transferLogs.filter(inRange).sort(logOrder)) {
    const topics = checkedTransferLog(log);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (seen.has(identity)) throw Error("Duplicate HyperSync ledger evidence");
    seen.add(identity);
    const token = byToken.get(log.address.toLowerCase());
    if (!token) throw Error("HyperSync transfer outside the registry");
    const { block } = joinedLog(log, transactions, retainedBlocks);
    const { args } = decodeEventLog({
      abi: [transferEvent],
      data: log.data as Hex,
      topics: topics as [Hex, ...Hex[]],
      strict: true,
    });
    transfers.push({
      txHash: log.transaction_hash.toLowerCase(),
      logIndex: log.log_index,
      block: log.block_number,
      blockHash: log.block_hash.toLowerCase(),
      timestamp: blockTimestamp(block),
      token: token.token,
      from: args.from.toLowerCase(),
      to: args.to.toLowerCase(),
      value: args.value.toString(),
    });
  }
  // 8. The launch batch with its evidence, name, symbol and decimals.
  const rangeLaunchLogs = launchLogs.filter(inRange);
  const launchTransactions = new Set(
    rangeLaunchLogs.map((l) => l.transaction_hash.toLowerCase()),
  );
  const inLaunch = (l: HyperSyncLogRow) =>
    inRange(l) && launchTransactions.has(l.transaction_hash.toLowerCase());
  const launchRetained = new Map<number, HyperSyncBlockRow>([
    [toBlock, cutoff],
  ]);
  const launchTxRows = new Map<string, HyperSyncTransactionRow>();
  for (const log of rangeLaunchLogs) {
    const { transaction, block } = joinedLog(log, transactions, retainedBlocks);
    launchTxRows.set(transaction.hash.toLowerCase(), transaction);
    launchRetained.set(block.number, block);
  }
  const partial = {
    source: "hypersync" as const,
    stream: ledgerLaunchStream,
    schemaVersion: 1 as const,
    url: client.url,
    query: launchQuery,
    pages: launchPages.pages,
    logs: rangeLaunchLogs,
    launcherLogs: launchPages.logs.filter(
      (l) => inLaunch(l) && contracts.launchers.some((a) => same(a, l.address)),
    ),
    tokenMetadataLogs: launchPages.logs.filter(
      (l) =>
        inLaunch(l) &&
        same(l.address, tokenMetadataFactory) &&
        same(l.topic0, tokenMetadataTopic),
    ),
    transactions: sortedTransactions(launchTxRows.values()),
    blocks: checkedRetainedBlocks([...launchRetained.values()], toBlock),
    archiveHeight,
  };
  const rows = ledgerLaunchRows({ fromBlock, toBlock }, partial);
  const metadata = await readLaunchMetadata(
    rpc,
    rows.launches.map(({ decoded }) => decoded.token.toLowerCase()),
    input.multicall,
  );
  const launch: LedgerLaunchBatch = {
    fromBlock,
    toBlock,
    blockHash: rows.blockHash,
    toTimestamp: rows.toTimestamp,
    pools: launchPools(rows.launches, rows.matched, metadata.results),
    evidence: {
      ...partial,
      tokenMetadataIssues: rows.issues,
      calls: metadata.calls,
    },
  };
  verifyLedgerLaunchBatch(launch);
  if (!same(launch.blockHash, cutoff.hash))
    throw Error("HyperSync ledger cutoff disagrees with the header");
  return {
    fromBlock,
    toBlock,
    parentHash: parentHash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
    archiveHeight,
    launch,
    swaps,
    transfers,
    unsupportedSwaps,
    registryPools,
    query: {
      launch: launchQuery,
      swaps: swapRecords,
      transfers: transferRecords,
    },
    pages: {
      launch: launchPages.pages,
      swaps: swapPages,
      transfers: transferPages,
      headers: headerPages,
    },
    requests: client.requests - requests0,
    bytes: client.bytes - bytes0,
  };
}
/** The next range of a pass: from the cursor, at most `rangeBlocks`, never
 * past the confirmed cutoff; null once the cutoff is reached. */
export function planLedgerRange(input: {
  cursor: number | null;
  start: number;
  height: number;
  rangeBlocks: number;
}): LedgerBlockRange | null {
  if (
    !integer(input.start) ||
    !integer(input.height) ||
    (input.cursor !== null && !integer(input.cursor)) ||
    !Number.isSafeInteger(input.rangeBlocks) ||
    input.rangeBlocks < 1 ||
    input.rangeBlocks > ledgerPassPolicy.maxRangeBlocks
  )
    throw Error("Invalid HyperSync ledger range");
  const fromBlock = input.cursor === null ? input.start : input.cursor + 1;
  const safeTo = input.height - hypersyncPolicy.safeDistance;
  if (fromBlock > safeTo) return null;
  return {
    fromBlock,
    toBlock: Math.min(safeTo, fromBlock + input.rangeBlocks - 1),
  };
}
