import { decodeEventLog, toEventSelector } from "viem";
import { isDeepStrictEqual } from "node:util";
import { transferEvent } from "./events";
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
  transferLogQuery,
  type HyperSyncBlockRow,
  type HyperSyncLogRow,
  type HyperSyncPageRecord,
  type HyperSyncQuery,
  type HyperSyncTransactionRow,
} from "./hypersync";

/** Tier-3 raw material: per-token ERC-20 Transfer logs by address list, each
 * joined to its transaction initiator and block time. Nothing here is a
 * holder balance, beneficiary or basis; the pool-stream writer that consumes
 * receipt-shaped evidence today is not fed from this batch. */
export interface HyperSyncTransferRow {
  token: string;
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  /** The transaction initiator, not an inferred beneficiary. */
  transactionSender: string;
  from: string;
  to: string;
  value: string;
}
export interface HyperSyncTransferEvidence {
  source: "hypersync";
  schemaVersion: 1;
  url: string;
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  logs: HyperSyncLogRow[];
  transactions: HyperSyncTransactionRow[];
  blocks: HyperSyncBlockRow[];
}
export interface HyperSyncTransferBatch {
  chainId: 4663;
  tokens: string[];
  fromBlock: number;
  toBlock: number;
  fromBlockParentHash: string;
  blockHash: string;
  toTimestamp: number;
  transfers: HyperSyncTransferRow[];
  evidence: HyperSyncTransferEvidence;
  requests: number;
}
export interface HyperSyncTransferRange {
  tokens: readonly string[];
  fromBlock: number;
  toBlock: number;
  maxPages?: number;
}
export const hypersyncTransferPolicy = Object.freeze({
  maxBlocks: 1000000,
  maxLogs: 10000,
  maxBytes: 16 * 1024 * 1024,
  maxTokens: 200,
});
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function checkedTransferLog(
  log: HyperSyncLogRow,
  tokens: ReadonlySet<string>,
  fromBlock: number,
  toBlock: number,
) {
  const topics = logTopics(log);
  if (
    !tokens.has(log.address.toLowerCase()) ||
    topics.length !== 3 ||
    !same(topics[0], toEventSelector(transferEvent)) ||
    !/^0x[\da-f]{64}$/i.test(log.data) ||
    log.removed === true ||
    log.block_number < fromBlock ||
    log.block_number > toBlock
  )
    throw Error("Unexpected HyperSync transfer source or range");
  return topics;
}
function transferRow(
  log: HyperSyncLogRow,
  transaction: HyperSyncTransactionRow,
  block: HyperSyncBlockRow,
): HyperSyncTransferRow {
  const { args } = decodeEventLog({
    abi: [transferEvent],
    data: log.data as `0x${string}`,
    topics: logTopics(log) as [`0x${string}`, ...`0x${string}`[]],
    strict: true,
  });
  return {
    token: log.address.toLowerCase(),
    txHash: log.transaction_hash.toLowerCase(),
    logIndex: log.log_index,
    block: log.block_number,
    blockHash: log.block_hash.toLowerCase(),
    timestamp: blockTimestamp(block),
    transactionSender: transaction.from.toLowerCase(),
    from: args.from.toLowerCase(),
    to: args.to.toLowerCase(),
    value: args.value.toString(),
  };
}
function derive(batch: HyperSyncTransferBatch) {
  const { fromBlock, toBlock, evidence } = batch;
  const tokens = new Set(batch.tokens);
  const expectedQuery = transferLogQuery(
    { fromBlock, toBlock: Number(evidence.query.to_block) - 1 },
    batch.tokens,
  );
  if (
    evidence.source !== "hypersync" ||
    evidence.schemaVersion !== 1 ||
    !isDeepStrictEqual(evidence.query, expectedQuery) ||
    expectedQuery.to_block! - 1 < toBlock ||
    evidence.pages.length < 1 ||
    evidence.pages.length > 64 ||
    evidence.logs.length > hypersyncTransferPolicy.maxLogs
  )
    throw Error("Invalid HyperSync transfer evidence");
  let next = fromBlock;
  for (const page of evidence.pages) {
    if (
      page.fromBlock !== next ||
      !integer(page.nextBlock) ||
      page.nextBlock <= page.fromBlock ||
      page.nextBlock > expectedQuery.to_block! ||
      page.archiveHeight === null ||
      page.archiveHeight - hypersyncPolicy.safeDistance < toBlock
    )
      throw Error("HyperSync transfer pages disagree with the range");
    next = page.nextBlock;
  }
  if (toBlock !== Math.min(expectedQuery.to_block! - 1, next - 1))
    throw Error("HyperSync transfer pages disagree with the range");
  const transactions = new Map<string, HyperSyncTransactionRow>();
  for (const [i, raw] of evidence.transactions.entries()) {
    const t = checkedTransactionRow(raw);
    const key = t.hash.toLowerCase();
    const previous = evidence.transactions[i - 1];
    if (
      transactions.has(key) ||
      (previous && previous.hash.toLowerCase() >= key)
    )
      throw Error("HyperSync transfer transactions are not unique and sorted");
    transactions.set(key, t);
  }
  const blocks = new Map<number, HyperSyncBlockRow>();
  for (const raw of evidence.blocks) {
    const b = checkedBlockRow(raw);
    if (blocks.has(b.number)) throw Error("HyperSync transfer blocks repeat");
    blocks.set(b.number, b);
  }
  if (
    !isDeepStrictEqual(
      checkedRetainedBlocks([...blocks.values()], toBlock),
      evidence.blocks,
    )
  )
    throw Error("HyperSync transfer blocks are not sorted");
  const identities = new Set<string>();
  const usedTransactions = new Set<string>();
  const usedBlocks = new Set<number>([fromBlock, toBlock]);
  const transfers: HyperSyncTransferRow[] = [];
  let previous: HyperSyncLogRow | undefined;
  for (const raw of evidence.logs) {
    const log = checkedLogRow(raw);
    checkedTransferLog(log, tokens, fromBlock, toBlock);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (identities.has(identity))
      throw Error("Duplicate HyperSync transfer evidence");
    identities.add(identity);
    if (
      previous &&
      (previous.block_number > log.block_number ||
        (previous.block_number === log.block_number &&
          previous.log_index >= log.log_index))
    )
      throw Error("HyperSync transfer logs are not sorted");
    previous = log;
    const { transaction, block } = joinedLog(log, transactions, blocks);
    usedTransactions.add(transaction.hash.toLowerCase());
    usedBlocks.add(block.number);
    transfers.push(transferRow(log, transaction, block));
  }
  if (
    usedTransactions.size !== transactions.size ||
    usedBlocks.size !== blocks.size
  )
    throw Error("HyperSync transfer evidence retains unrelated rows");
  const first = blocks.get(fromBlock)!,
    cutoff = blocks.get(toBlock)!;
  return {
    transfers,
    fromBlockParentHash: first.parent_hash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
  };
}
export function verifyHyperSyncTransferBatch(batch: HyperSyncTransferBatch) {
  if (
    batch.chainId !== 4663 ||
    !Array.isArray(batch.tokens) ||
    !batch.tokens.length ||
    batch.tokens.length > hypersyncTransferPolicy.maxTokens ||
    batch.tokens.some(
      (t, i) =>
        !address(t) ||
        t !== t.toLowerCase() ||
        (i > 0 && batch.tokens[i - 1] >= t),
    ) ||
    !integer(batch.fromBlock) ||
    !integer(batch.toBlock) ||
    batch.toBlock < batch.fromBlock ||
    batch.toBlock - batch.fromBlock >= hypersyncTransferPolicy.maxBlocks
  )
    throw Error("Invalid HyperSync transfer batch");
  const derived = derive(batch);
  const claimed = {
    transfers: batch.transfers,
    fromBlockParentHash: batch.fromBlockParentHash,
    blockHash: batch.blockHash,
    toTimestamp: batch.toTimestamp,
  };
  if (!isDeepStrictEqual(claimed, derived))
    throw Error("HyperSync transfer rows disagree with retained evidence");
}
/** Collect Transfer logs for a token list over one range. Pages are whole, so
 * a dense stretch ends the batch early at a block-complete boundary. */
export async function collectHyperSyncTransfers(
  range: HyperSyncTransferRange,
  client: HyperSyncClient,
): Promise<HyperSyncTransferBatch> {
  const { fromBlock } = range;
  const maxPages = range.maxPages ?? 4;
  const tokens = [...new Set(range.tokens.map((t) => t.toLowerCase()))].sort();
  if (
    tokens.length !== range.tokens.length ||
    !tokens.length ||
    tokens.length > hypersyncTransferPolicy.maxTokens ||
    tokens.some((t) => !address(t)) ||
    !integer(fromBlock) ||
    !integer(range.toBlock) ||
    range.toBlock < fromBlock ||
    range.toBlock - fromBlock >= hypersyncTransferPolicy.maxBlocks ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 16
  )
    throw Error("Invalid HyperSync transfer range");
  const height = await client.height();
  if (!integer(height) || range.toBlock > height - hypersyncPolicy.safeDistance)
    throw Error("HyperSync range exceeds the confirmed cutoff");
  const query = transferLogQuery({ fromBlock, toBlock: range.toBlock }, tokens);
  const collected = await collectLogPages(client, query, {
    maxPages,
    maxLogs: hypersyncTransferPolicy.maxLogs,
    maxBytes: hypersyncTransferPolicy.maxBytes,
  });
  const toBlock = collected.toBlock;
  const tokenSet = new Set(tokens);
  const identities = new Set<string>();
  for (const log of collected.logs) {
    checkedTransferLog(log, tokenSet, fromBlock, toBlock);
    const identity = `${log.transaction_hash.toLowerCase()}:${log.log_index}`;
    if (identities.has(identity))
      throw Error("Duplicate HyperSync transfer evidence");
    identities.add(identity);
  }
  const blocks = new Map(collected.blocks);
  const boundary = async (n: number) => {
    if (!blocks.has(n)) blocks.set(n, await client.header(n));
    return blocks.get(n)!;
  };
  const first = await boundary(fromBlock);
  const cutoff = await boundary(toBlock);
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const retained = new Map<number, HyperSyncBlockRow>([
    [fromBlock, first],
    [toBlock, cutoff],
  ]);
  const transfers = collected.logs.map((log) => {
    const { transaction, block } = joinedLog(
      log,
      collected.transactions,
      blocks,
    );
    transactions.set(transaction.hash.toLowerCase(), transaction);
    retained.set(block.number, block);
    return transferRow(log, transaction, block);
  });
  const result: HyperSyncTransferBatch = {
    chainId: 4663,
    tokens,
    fromBlock,
    toBlock,
    fromBlockParentHash: first.parent_hash.toLowerCase(),
    blockHash: cutoff.hash.toLowerCase(),
    toTimestamp: blockTimestamp(cutoff),
    transfers,
    evidence: {
      source: "hypersync",
      schemaVersion: 1,
      url: client.url,
      query,
      pages: collected.pages,
      logs: collected.logs,
      transactions: [...transactions.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, t]) => t),
      blocks: checkedRetainedBlocks([...retained.values()], toBlock),
    },
    requests: client.requests,
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) > hypersyncTransferPolicy.maxBytes
  )
    throw Error("HyperSync transfer batch exceeds capacity; split the range");
  verifyHyperSyncTransferBatch(result);
  return result;
}
