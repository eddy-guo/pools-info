import { decodeFunctionResult, erc20Abi, type Hex } from "viem";
import { isDeepStrictEqual } from "node:util";
import type { LedgerSwap, LedgerTransfer } from "@pools/core";
import {
  crowdAuctionOf,
  crowdFactory,
  crowdLaunchers,
  crowdRegistryRevision,
  crowdStrategies,
  crowdTopics,
  decodeCrowdMigration,
  migrationMatches,
  type CrowdAuction,
  type CrowdRejection,
} from "./crowd";
import {
  decodeTokenMetadata,
  tokenMetadataFactory,
  tokenMetadataTopic,
  type TokenMetadata,
} from "./token-metadata";
import {
  expandContractReads,
  type ContractReadEvidence,
  type MulticallConfig,
} from "./multicall";
import type { Rpc } from "./rpc";
import {
  HyperSyncClient,
  blockTimestamp,
  checkedQuery,
  checkedRetainedBlocks,
  collectLogPages,
  headerQuery,
  hypersyncFields,
  hypersyncPolicy,
  joinedLog,
  rawLogOf,
  swapLogQuery,
  transferLogQuery,
  type HyperSyncBlockRow,
  type HyperSyncLogRow,
  type HyperSyncPageRecord,
  type HyperSyncQuery,
  type HyperSyncTransactionRow,
} from "./hypersync";
import {
  checkedEvidenceRows,
  currentLaunchSchema,
  decodedDecimals,
  decodedSupply,
  launchReadFields,
  ledgerChunks,
  ledgerPassPolicy,
  ledgerQueryRecord,
  ledgerTradeRows,
  logOrder,
  metadataRead,
  orderedLogs,
  presentation,
  readKey,
  readLaunchMetadata,
  sortedTransactions,
  type LedgerCatalogPool,
  type LedgerQueryRecord,
  type LedgerRegistryPool,
} from "./hypersync-ledger";
import { contracts } from "./events";

/** The crowd lane of the aggregate ledger (docs/CROWD-LAUNCHES.md): the
 * pools.xyz crowd launches, verified from their own events, and the swaps
 * and transfers of the pools they created, over the same HyperSync transport
 * and pages as the main lane. A crowd launch spans two transactions: the
 * creation (the factory's AuctionCreated and the strategy's InitializerCreated
 * through the LiquidityLauncher) and, hours or days later, the permissionless
 * migration (the strategy's Migrated). The launch lane selects the factory
 * and strategy events only; a creation of the template is remembered by the
 * caller (crowd_auctions) and, when its Migrated log arrives, its creation
 * block is read again with the launcher and metadata logs, so every launch
 * batch verifies from the rows it retains alone. */
export const crowdLaunchStream = "launches:crowd:v1" as const;
export const crowdPassPolicy = Object.freeze({
  /** The same start as the main ledger: no template auction precedes it (the
   * first was created at block 28,575,416). */
  startBlock: ledgerPassPolicy.startBlock,
  /** Blocks per range while catching up; a quiet range doubles the next up
   * to maxRangeBlocks. Crowd rows are a small share of the chain, so the
   * catch-up is bounded by requests rather than by pages. */
  rangeBlocks: 100000,
  maxRangeBlocks: ledgerPassPolicy.maxRangeBlocks,
  /** Graduations per range; a burst ends the range before the excess. */
  maxLaunches: 200,
});

export interface CrowdCatalogPool extends LedgerCatalogPool {
  launchType: "crowd";
  auction: string;
}
/** A migration of a template auction the lane saw, and what its creation
 * block said when read again. */
export interface CrowdLaunchEvidence {
  source: "hypersync";
  stream: typeof crowdLaunchStream;
  schemaVersion: 1;
  registryRevision: typeof crowdRegistryRevision;
  url: string;
  query: HyperSyncQuery;
  pages: HyperSyncPageRecord[];
  /** The range's template creations: each AuctionCreated with the
   * InitializerCreated of the same auction in the same transaction. */
  creations: HyperSyncLogRow[];
  /** The range's Migrated logs of template auctions, in log order. */
  migrations: HyperSyncLogRow[];
  /** The migration blocks and the cutoff header. */
  blocks: HyperSyncBlockRow[];
  /** Per migration, in the same order: its creation block read again with
   * the launcher's and the metadata factory's logs. */
  launches: {
    query: HyperSyncQuery;
    pages: HyperSyncPageRecord[];
    logs: HyperSyncLogRow[];
    transactions: HyperSyncTransactionRow[];
    blocks: HyperSyncBlockRow[];
  }[];
  claims: {
    query: HyperSyncQuery;
    pages: HyperSyncPageRecord[];
    logs: HyperSyncLogRow[];
    transactions: HyperSyncTransactionRow[];
    blocks: HyperSyncBlockRow[];
  }[];
  /** Migrations of template auctions that were not admitted, and why. */
  rejected: { auction: string; reason: CrowdLaunchRejection }[];
  tokenMetadataIssues: {
    transactionHash: string;
    logIndex: number;
    reason: string;
  }[];
  /** name, symbol, decimals and totalSupply of each admitted token, read at
   * the provider's head as the main lane reads them. */
  calls: ContractReadEvidence[];
  archiveHeight: number;
}
export type CrowdLaunchRejection =
  CrowdRejection | "no_launcher" | "pool_mismatch";
export interface CrowdLaunchBatch {
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  toTimestamp: number;
  pools: CrowdCatalogPool[];
  /** Template auctions created in the range, for the caller to remember. */
  auctions: CrowdAuction[];
  claims: LedgerTransfer[];
  evidence: CrowdLaunchEvidence;
}

const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const lower = (s: string) => s.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);
const strategyAddresses = crowdStrategies.map((s) => s.strategy);

function checkedRange(range: { fromBlock: number; toBlock: number }) {
  if (
    !integer(range.fromBlock) ||
    !integer(range.toBlock) ||
    range.toBlock < range.fromBlock ||
    range.toBlock - range.fromBlock >= ledgerPassPolicy.maxRangeBlocks
  )
    throw Error("Invalid HyperSync crowd range");
}
/** The launch lane: every auction the factory creates and every
 * registration and migration of the two strategies. No transactions: a
 * creation is remembered by its logs, and a migration's creation is read
 * again, with its transaction, when the migration arrives. */
export function crowdLaunchQuery(range: {
  fromBlock: number;
  toBlock: number;
}): HyperSyncQuery {
  checkedRange(range);
  return checkedQuery({
    from_block: range.fromBlock,
    to_block: range.toBlock + 1,
    logs: [
      {
        address: [crowdFactory.address],
        topics: [[crowdTopics.auctionCreated]],
      },
      {
        address: [...strategyAddresses],
        topics: [[crowdTopics.initializerCreated, crowdTopics.migrated]],
      },
    ],
    field_selection: {
      block: [...hypersyncFields.block],
      log: [...hypersyncFields.log],
    },
    max_num_logs: hypersyncPolicy.maxLogsPerPage,
  });
}
/** A creation block read again: the launchers' logs (the proof pools.xyz's
 * LiquidityLauncher ran in the creation), the metadata factory's
 * TokenCreated, and the auction's two creation logs, with transactions. */
export function crowdCreationQuery(block: number): HyperSyncQuery {
  if (!integer(block)) throw Error("Invalid HyperSync crowd range");
  return checkedQuery({
    from_block: block,
    to_block: block + 1,
    logs: [
      { address: [...crowdLaunchers] },
      { address: [tokenMetadataFactory], topics: [[tokenMetadataTopic]] },
      {
        address: [crowdFactory.address],
        topics: [[crowdTopics.auctionCreated]],
      },
      {
        address: [...strategyAddresses],
        topics: [[crowdTopics.initializerCreated]],
      },
    ],
    field_selection: {
      block: [...hypersyncFields.block],
      transaction: [...hypersyncFields.transaction],
      log: [...hypersyncFields.log],
    },
    max_num_logs: hypersyncPolicy.maxLogsPerPage,
  });
}

const isCreated = (l: HyperSyncLogRow) =>
  same(l.address, crowdFactory.address) &&
  same(l.topic0, crowdTopics.auctionCreated);
const isInitializer = (l: HyperSyncLogRow) =>
  strategyAddresses.some((a) => same(a, l.address)) &&
  same(l.topic0, crowdTopics.initializerCreated);
const isMigrated = (l: HyperSyncLogRow) =>
  strategyAddresses.some((a) => same(a, l.address)) &&
  same(l.topic0, crowdTopics.migrated);
/** The template auctions created by these logs, each with its two logs:
 * every AuctionCreated paired with the InitializerCreated naming the same
 * auction in the same transaction. Unpaired or non-template creations are
 * other launchpads' auctions and are left out. */
export function crowdCreations(logs: readonly HyperSyncLogRow[]) {
  const initializers = new Map<string, HyperSyncLogRow>();
  for (const l of logs)
    if (isInitializer(l) && l.topic1)
      initializers.set(
        `${lower(l.transaction_hash)}:${lower("0x" + l.topic1.slice(26))}`,
        l,
      );
  const found: {
    auction: CrowdAuction;
    created: HyperSyncLogRow;
    initializer: HyperSyncLogRow;
  }[] = [];
  const rejected: { auction: string; reason: CrowdRejection }[] = [];
  for (const created of logs) {
    if (!isCreated(created) || !created.topic1) continue;
    const auction = lower("0x" + created.topic1.slice(26));
    const initializer = initializers.get(
      `${lower(created.transaction_hash)}:${auction}`,
    );
    if (!initializer) continue;
    const result = crowdAuctionOf(rawLogOf(created), rawLogOf(initializer));
    if (typeof result === "string") rejected.push({ auction, reason: result });
    else found.push({ auction: result, created, initializer });
  }
  return { found, rejected };
}
/** What a creation block read again says about the auction it declares:
 * its creator and metadata, or why its migration is not admitted. */
function launchOf(
  auction: CrowdAuction,
  migration: HyperSyncLogRow,
  read: CrowdLaunchEvidence["launches"][number],
):
  | {
      auction: CrowdAuction;
      creator: string;
      metadata: TokenMetadata | null;
      issues: CrowdLaunchEvidence["tokenMetadataIssues"];
    }
  | CrowdLaunchRejection {
  const tx = auction.createdTx;
  const inTx = (l: HyperSyncLogRow) => lower(l.transaction_hash) === tx;
  const again = crowdCreations(read.logs.filter(inTx)).found.find(
    (c) => c.auction.auction === auction.auction,
  );
  if (!again) throw invalid();
  const transactions = new Map(
    read.transactions.map((t) => [lower(t.hash), t]),
  );
  const blocks = new Map(read.blocks.map((b) => [b.number, b]));
  const { transaction } = joinedLog(again.created, transactions, blocks);
  if (
    !read.logs.some(
      (l) => inTx(l) && crowdLaunchers.some((a) => same(a, l.address)),
    )
  )
    return "no_launcher";
  if (!migrationMatches(auction, decodeCrowdMigration(rawLogOf(migration))))
    return "pool_mismatch";
  const issues: CrowdLaunchEvidence["tokenMetadataIssues"] = [];
  const candidates: TokenMetadata[] = [];
  for (const l of read.logs.filter(
    (l) =>
      inTx(l) &&
      same(l.address, tokenMetadataFactory) &&
      same(l.topic0, tokenMetadataTopic),
  )) {
    const decoded = decodeTokenMetadata(rawLogOf(l));
    for (const reason of decoded.issues)
      issues.push({ transactionHash: tx, logIndex: l.log_index, reason });
    if (decoded.metadata?.token === auction.token)
      candidates.push(decoded.metadata);
    else if (decoded.metadata)
      issues.push({
        transactionHash: tx,
        logIndex: l.log_index,
        reason: "unmatched_token",
      });
  }
  if (candidates.length > 1)
    issues.push({
      transactionHash: tx,
      logIndex: -1,
      reason: "ambiguous_metadata",
    });
  return {
    auction,
    creator: lower(transaction.from),
    metadata: candidates.length === 1 ? candidates[0] : null,
    issues,
  };
}
function checkedPages(
  pages: readonly HyperSyncPageRecord[],
  fromBlock: number,
  toBlock: number,
) {
  let next = fromBlock;
  if (!Array.isArray(pages) || pages.length < 1) throw invalid();
  for (const page of pages) {
    if (
      !page ||
      typeof page !== "object" ||
      page.fromBlock !== next ||
      !integer(page.nextBlock) ||
      page.nextBlock <= page.fromBlock ||
      page.archiveHeight === null ||
      !integer(page.archiveHeight) ||
      page.archiveHeight - hypersyncPolicy.safeDistance < toBlock
    )
      throw invalid();
    next = page.nextBlock;
  }
  if (next - 1 < toBlock) throw invalid();
}
const invalid = () => Error("Invalid HyperSync crowd evidence");
/** Everything a crowd launch batch claims except the contract reads,
 * derived from its retained rows alone. Shared by collector and verifier. */
function crowdLaunchRows(
  range: { fromBlock: number; toBlock: number },
  evidence: Omit<
    CrowdLaunchEvidence,
    "calls" | "tokenMetadataIssues" | "rejected"
  >,
) {
  if (
    evidence.source !== "hypersync" ||
    evidence.stream !== crowdLaunchStream ||
    evidence.schemaVersion !== 1 ||
    evidence.registryRevision !== crowdRegistryRevision ||
    typeof evidence.url !== "string" ||
    !Array.isArray(evidence.creations) ||
    !Array.isArray(evidence.migrations) ||
    !Array.isArray(evidence.launches) ||
    !Array.isArray(evidence.blocks) ||
    !integer(evidence.archiveHeight) ||
    evidence.archiveHeight - hypersyncPolicy.safeDistance < range.toBlock ||
    evidence.migrations.length > crowdPassPolicy.maxLaunches ||
    evidence.launches.length !== evidence.migrations.length
  )
    throw invalid();
  const expected = crowdLaunchQuery({
    fromBlock: range.fromBlock,
    toBlock: Number(evidence.query?.to_block) - 1,
  });
  if (
    !isDeepStrictEqual(evidence.query, expected) ||
    expected.to_block! - 1 < range.toBlock ||
    evidence.pages.length > ledgerPassPolicy.maxPages
  )
    throw invalid();
  checkedPages(evidence.pages, range.fromBlock, range.toBlock);
  const creationLogs = orderedLogs(evidence.creations, range, "creations");
  const { found, rejected: notTemplate } = crowdCreations(creationLogs);
  // Only template creations are retained, each exactly by its two logs.
  if (
    notTemplate.length ||
    found.length * 2 !== creationLogs.length ||
    new Set(found.map((f) => f.auction.auction)).size !== found.length
  )
    throw Error("HyperSync crowd evidence retains unrelated rows");
  const migrations = orderedLogs(evidence.migrations, range, "migrations");
  const blocks = new Map<number, HyperSyncBlockRow>();
  for (const b of checkedRetainedBlocks(evidence.blocks, range.toBlock))
    blocks.set(b.number, b);
  if (!isDeepStrictEqual([...blocks.values()], evidence.blocks))
    throw Error("HyperSync crowd blocks are not sorted");
  const used = new Set<number>([range.toBlock]);
  const auctions = new Set<string>();
  const launches = migrations.map((migration, i) => {
    if (!isMigrated(migration)) throw invalid();
    const m = decodeCrowdMigration(rawLogOf(migration));
    if (auctions.has(m.auction)) throw invalid();
    auctions.add(m.auction);
    const block = blocks.get(migration.block_number);
    if (!block || !same(block.hash, migration.block_hash)) throw invalid();
    used.add(block.number);
    const read = evidence.launches[i];
    const { transactions, blocks: readBlocks } = checkedEvidenceRows(read);
    const readBlock = [...readBlocks.keys()];
    if (
      readBlock.length !== 1 ||
      readBlock[0] >= migration.block_number ||
      !isDeepStrictEqual(read.query, crowdCreationQuery(readBlock[0])) ||
      read.pages.length > ledgerPassPolicy.maxPages
    )
      throw invalid();
    checkedPages(read.pages, readBlock[0], readBlock[0]);
    const readLogs = orderedLogs(
      read.logs,
      { fromBlock: readBlock[0], toBlock: readBlock[0] },
      "creation logs",
    );
    // The auction as the creation block declares it.
    const declared = crowdCreations(readLogs).found.find(
      (c) => c.auction.auction === m.auction,
    );
    if (!declared) throw invalid();
    const tx = declared.auction.createdTx;
    // The read retains the creation transaction's logs of the query and
    // nothing else.
    if (
      readLogs.some((l) => lower(l.transaction_hash) !== tx) ||
      transactions.size !== 1 ||
      !transactions.has(tx)
    )
      throw Error("HyperSync crowd evidence retains unrelated rows");
    const launch = launchOf(declared.auction, migration, {
      ...read,
      logs: readLogs,
    });
    return { migration, block, launch, declared: declared.auction };
  });
  if (used.size !== blocks.size)
    throw Error("HyperSync crowd evidence retains unrelated rows");
  const cutoff = blocks.get(range.toBlock)!;
  return {
    auctions: found.map((f) => f.auction),
    launches,
    blockHash: lower(cutoff.hash),
    toTimestamp: blockTimestamp(cutoff),
  };
}
function crowdPools(
  launches: ReturnType<typeof crowdLaunchRows>["launches"],
  results: readonly Hex[],
  readBlock: number | null,
) {
  const pools: CrowdCatalogPool[] = [];
  const rejected: CrowdLaunchEvidence["rejected"] = [];
  const issues: CrowdLaunchEvidence["tokenMetadataIssues"] = [];
  const fields = launchReadFields[currentLaunchSchema];
  let at = 0;
  for (const { migration, block, launch, declared } of launches) {
    if (typeof launch === "string") {
      rejected.push({ auction: declared.auction, reason: launch });
      continue;
    }
    issues.push(...launch.issues);
    const supply = decodedSupply(results[at + 3]);
    pools.push({
      ...presentation(launch.metadata),
      id: launch.auction.poolId,
      token: launch.auction.token,
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
      creatorFees: launch.auction.creatorFees,
      totalSupplyRaw: supply,
      supplyBlock: supply === null ? null : readBlock,
      launchTx: lower(migration.transaction_hash),
      launchSender: launch.creator,
      launchBlock: migration.block_number,
      launchedAt: blockTimestamp(block),
      launchBlockHash: lower(migration.block_hash),
      launchLogIndex: migration.log_index,
      launchType: "crowd",
      auction: launch.auction.auction,
    });
    at += fields.length;
  }
  return { pools, rejected, issues };
}
const admittedTokens = (
  launches: ReturnType<typeof crowdLaunchRows>["launches"],
) =>
  launches.flatMap(({ launch }) =>
    typeof launch === "string" ? [] : [launch.auction.token],
  );
const claimQuery = (auction: CrowdAuction, migrationBlock: number) => {
  const query = transferLogQuery(
    { fromBlock: auction.createdBlock, toBlock: migrationBlock - 1 },
    [auction.token],
    ledgerPassPolicy.tokensPerQuery,
  );
  query.logs![0].topics!.push(
    [auction.auction, auction.strategy].map(
      (address) => `0x${address.slice(2).padStart(64, "0")}`,
    ),
  );
  return checkedQuery(query);
};
function crowdClaimRows(
  launches: ReturnType<typeof crowdLaunchRows>["launches"],
  reads: CrowdLaunchEvidence["claims"],
): LedgerTransfer[] {
  const admitted = launches.filter((l) => typeof l.launch !== "string");
  if (!Array.isArray(reads) || reads.length !== admitted.length)
    throw invalid();
  return admitted.flatMap(({ migration, launch, declared }, i) => {
    if (typeof launch === "string") throw invalid();
    const read = reads[i];
    const query = claimQuery(declared, migration.block_number);
    if (!isDeepStrictEqual(read.query, query)) throw invalid();
    checkedPages(read.pages, declared.createdBlock, migration.block_number - 1);
    const logs = orderedLogs(
      read.logs,
      {
        fromBlock: declared.createdBlock,
        toBlock: migration.block_number - 1,
      },
      "claims",
    );
    const { transactions, blocks } = checkedEvidenceRows(read);
    const rows = ledgerTradeRows([], logs, {
      fromBlock: declared.createdBlock,
      toBlock: migration.block_number - 1,
      byPool: new Map(),
      byToken: new Map([
        [
          declared.token,
          {
            poolId: declared.poolId,
            token: declared.token,
            launchBlock: migration.block_number,
          },
        ],
      ]),
      manager: false,
      transactions,
      blocks,
    }).transfers;
    if (
      rows.some(
        (r) => r.from !== declared.auction && r.from !== declared.strategy,
      )
    )
      throw invalid();
    return rows.filter(
      (r) =>
        r.to !== declared.auction &&
        r.to !== declared.strategy &&
        r.to !== "0x0000000000000000000000000000000000000000" &&
        r.to !== contracts.manager &&
        BigInt(r.value) > 0n,
    );
  });
}
/** Re-derive a crowd launch batch from its retained evidence with no network
 * and reject any pool, auction, rejection or issue it does not support. */
export function verifyCrowdLaunchBatch(batch: CrowdLaunchBatch): void {
  if (
    !integer(batch.fromBlock) ||
    !integer(batch.toBlock) ||
    batch.toBlock < batch.fromBlock ||
    batch.toBlock - batch.fromBlock >= ledgerPassPolicy.maxRangeBlocks ||
    !Array.isArray(batch.evidence?.calls) ||
    !Array.isArray(batch.evidence?.rejected) ||
    !Array.isArray(batch.evidence?.tokenMetadataIssues)
  )
    throw invalid();
  const { evidence, ...claimed } = batch;
  const rows = crowdLaunchRows(batch, evidence);
  const claims = crowdClaimRows(rows.launches, evidence.claims);
  const replies = new Map<string, Hex | null>();
  const readBlocks = new Set<string>();
  for (const read of expandContractReads(evidence.calls)) {
    replies.set(readKey(read.to, read.data), read.result);
    readBlocks.add(read.block.toLowerCase());
  }
  if (readBlocks.size > 1)
    throw Error("HyperSync crowd launch calls disagree with the evidence");
  const results = admittedTokens(rows.launches).flatMap((token) =>
    launchReadFields[currentLaunchSchema].map((field) => {
      const read = metadataRead(token, field);
      const result = replies.get(readKey(read.to, read.data));
      if (result === undefined || result === null)
        throw Error("HyperSync crowd launch calls disagree with the evidence");
      return result;
    }),
  );
  if (replies.size !== results.length)
    throw Error("HyperSync crowd evidence retains unrelated rows");
  const [readBlock] = readBlocks;
  const derived = crowdPools(
    rows.launches,
    results,
    readBlock === undefined ? null : Number(readBlock),
  );
  if (
    !isDeepStrictEqual(claimed, {
      fromBlock: batch.fromBlock,
      toBlock: batch.toBlock,
      blockHash: rows.blockHash,
      toTimestamp: rows.toTimestamp,
      pools: derived.pools,
      auctions: rows.auctions,
      claims,
    }) ||
    !isDeepStrictEqual(evidence.rejected, derived.rejected) ||
    !isDeepStrictEqual(evidence.tokenMetadataIssues, derived.issues)
  )
    throw Error("HyperSync crowd rows disagree with retained evidence");
}

export interface CrowdRangeInput {
  fromBlock: number;
  toBlock: number;
  /** The hash of block fromBlock - 1, or null on the first range. */
  parentHash: string | null;
  height: number;
  /** Every crowd pool registered before the range. */
  registry: readonly LedgerRegistryPool[];
  /** Template auctions seen created before the range and not yet migrated. */
  pending: readonly { auction: string; createdBlock: number }[];
  maxPages?: number;
  multicall?: MulticallConfig;
}
export interface CrowdRangeCollection {
  fromBlock: number;
  toBlock: number;
  parentHash: string;
  blockHash: string;
  toTimestamp: number;
  archiveHeight: number;
  launch: CrowdLaunchBatch;
  swaps: LedgerSwap[];
  transfers: LedgerTransfer[];
  claims: LedgerTransfer[];
  unsupportedSwaps: number;
  swapSelection: "pool_ids";
  unregisteredSwaps: 0;
  registryPools: number;
  query: {
    launch: HyperSyncQuery;
    creations: HyperSyncQuery[];
    claims: HyperSyncQuery[];
    swaps: LedgerQueryRecord[];
    transfers: LedgerQueryRecord[];
  };
  pages: {
    launch: HyperSyncPageRecord[];
    creations: HyperSyncPageRecord[][];
    claims: HyperSyncPageRecord[][];
    swaps: HyperSyncPageRecord[][];
    transfers: HyperSyncPageRecord[][];
    headers: HyperSyncPageRecord[];
  };
  requests: number;
  bytes: number;
  sentBytes: number;
}
/** Collect one crowd range in whole pages: the launch lane first (so a pool
 * graduating in the range joins the filters), each graduation's creation
 * block read again, then the swaps of every crowd pool by pool id and the
 * transfers of every crowd token, then the cutoff header. Every later query
 * is asked only up to the shortest end so far. */
export async function collectCrowdRange(
  client: HyperSyncClient,
  rpc: Rpc,
  input: CrowdRangeInput,
): Promise<CrowdRangeCollection> {
  checkedRange(input);
  const maxPages = input.maxPages ?? ledgerPassPolicy.maxPages;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > ledgerPassPolicy.maxPages ||
    !integer(input.height) ||
    (input.parentHash !== null && !hash(input.parentHash))
  )
    throw Error("Invalid HyperSync crowd range");
  if (input.toBlock > input.height - hypersyncPolicy.safeDistance)
    throw Error("HyperSync range exceeds the confirmed cutoff");
  const caps = {
    maxPages,
    maxLogs: ledgerPassPolicy.maxLogs,
    maxBytes: ledgerPassPolicy.maxBytes,
  };
  const requests0 = client.requests,
    bytes0 = client.bytes,
    sentBytes0 = client.sentBytes;
  const { fromBlock } = input;
  let toBlock = input.toBlock;
  let archiveHeight = input.height;
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
      !integer(entry.launchBlock) ||
      byPool.has(entry.poolId) ||
      byToken.has(entry.token)
    )
      throw Error("Invalid HyperSync crowd registry");
    byPool.set(entry.poolId, entry);
    byToken.set(entry.token, entry);
  };
  for (const p of input.registry) {
    if (p.launchBlock >= fromBlock)
      throw Error("Invalid HyperSync crowd registry");
    register(p);
  }
  // Where each remembered auction was created.
  const known = new Map<string, number>();
  for (const a of input.pending) {
    if (
      !integer(a.createdBlock) ||
      a.createdBlock >= fromBlock ||
      known.has(lower(a.auction))
    )
      throw Error("Invalid HyperSync crowd registry");
    known.set(lower(a.auction), a.createdBlock);
  }
  // 1. The launch lane.
  const launchQuery = crowdLaunchQuery({ fromBlock, toBlock });
  const launchPages = await collectLogPages(client, launchQuery, caps);
  toBlock = Math.min(toBlock, launchPages.toBlock);
  archiveHeight = Math.min(archiveHeight, launchPages.archiveHeight);
  const laneLogs = launchPages.logs.filter((l) => l.block_number <= toBlock);
  const created = crowdCreations(laneLogs).found;
  for (const c of created) known.set(c.auction.auction, c.auction.createdBlock);
  const auctionOf = (l: HyperSyncLogRow) => lower("0x" + l.topic1!.slice(26));
  let migrations = laneLogs.filter((l) => {
    if (!isMigrated(l) || !l.topic1) return false;
    const createdBlock = known.get(auctionOf(l));
    return createdBlock !== undefined && createdBlock < l.block_number;
  });
  // A graduation burst ends the range before the excess; one block over the
  // cap cannot be split.
  if (migrations.length > crowdPassPolicy.maxLaunches) {
    const cut = migrations[crowdPassPolicy.maxLaunches].block_number - 1;
    if (cut < fromBlock)
      throw Error("Ledger range exceeds the launch cap in one block");
    toBlock = cut;
    migrations = migrations.filter((l) => l.block_number <= toBlock);
  }
  // 2. Each graduation's creation block, read again.
  const creationQueries: HyperSyncQuery[] = [];
  const creationPages: HyperSyncPageRecord[][] = [];
  const reads: CrowdLaunchEvidence["launches"] = [];
  const declared: CrowdAuction[] = [];
  for (const m of migrations) {
    const createdBlock = known.get(auctionOf(m))!;
    const query = crowdCreationQuery(createdBlock);
    const collected = await collectLogPages(client, query, caps);
    if (collected.toBlock !== createdBlock)
      throw Error("HyperSync crowd creation read was cut short");
    archiveHeight = Math.min(archiveHeight, collected.archiveHeight);
    // The auction as its creation block declares it, read again: the
    // remembered index is never the evidence.
    const auction = crowdCreations(collected.logs).found.find(
      (c) => c.auction.auction === auctionOf(m),
    )?.auction;
    if (!auction) throw Error("HyperSync crowd creation not found");
    declared.push(auction);
    const tx = auction.createdTx;
    const logs = collected.logs.filter((l) => lower(l.transaction_hash) === tx);
    const transaction = collected.transactions.get(tx);
    reads.push({
      query,
      pages: collected.pages,
      logs,
      transactions: transaction ? [transaction] : [],
      blocks: [...collected.blocks.values()].filter(
        (b) => b.number === createdBlock,
      ),
    });
    creationQueries.push(query);
    creationPages.push(collected.pages);
  }
  const blockRows = new Map(launchPages.blocks);
  const launched = migrations.map((m, i) => ({
    migration: m,
    read: reads[i],
    auction: declared[i],
  }));
  for (const { migration, read, auction } of launched) {
    const outcome = launchOf(auction, migration, read);
    if (typeof outcome !== "string")
      register({
        poolId: auction.poolId,
        token: auction.token,
        launchBlock: migration.block_number,
      });
  }
  // 3. Swaps of every crowd pool, by pool id.
  const swapLogs: HyperSyncLogRow[] = [];
  const swapRecords: LedgerQueryRecord[] = [];
  const swapPages: HyperSyncPageRecord[][] = [];
  const transactions = new Map<string, HyperSyncTransactionRow>();
  const tradeBlocks = new Map<number, HyperSyncBlockRow>();
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
      const prior = tradeBlocks.get(n) ?? blockRows.get(n);
      if (prior && !isDeepStrictEqual(prior, b))
        throw Error("HyperSync returned conflicting blocks");
      tradeBlocks.set(n, b);
    }
  };
  const poolIds = [...byPool.keys()].sort();
  for (const chunk of ledgerChunks(poolIds, ledgerPassPolicy.poolIdsPerQuery)) {
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
  // 4. Transfers of every crowd token.
  const transferLogs: HyperSyncLogRow[] = [];
  const transferRecords: LedgerQueryRecord[] = [];
  const transferPages: HyperSyncPageRecord[][] = [];
  const tokens = [...byToken.keys()].sort();
  for (const chunk of ledgerChunks(tokens, ledgerPassPolicy.tokensPerQuery)) {
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
  // 5. The boundary headers: the cutoff always, the parent on the first range.
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
  const parentHash =
    input.parentHash === null
      ? (fromBlock === toBlock ? cutoff : await header(fromBlock)).parent_hash
      : input.parentHash;
  if (archiveHeight - hypersyncPolicy.safeDistance < toBlock)
    throw Error("HyperSync archive height below the confirmed cutoff");
  const inRange = (n: number) => n >= fromBlock && n <= toBlock;
  const allBlocks = new Map<number, HyperSyncBlockRow>();
  for (const [n, b] of [...blockRows, ...tradeBlocks])
    if (inRange(n)) allBlocks.set(n, b);
  const prior = allBlocks.get(toBlock);
  if (prior && !isDeepStrictEqual(prior, cutoff))
    throw Error("HyperSync returned conflicting blocks");
  allBlocks.set(toBlock, cutoff);
  // A migration's block is joined to its log; a page without it is refused.
  for (const { migration } of launched) {
    const block = allBlocks.get(migration.block_number);
    if (
      migration.block_number <= toBlock &&
      (!block || !same(block.hash, migration.block_hash))
    )
      throw Error("HyperSync crowd migration lacks its block");
  }
  checkedRetainedBlocks([...allBlocks.values()], toBlock);
  // 6. Swap and transfer rows, each crowd token's from its pool's migration.
  const trades = ledgerTradeRows(swapLogs, transferLogs, {
    fromBlock,
    toBlock,
    byPool: new Map([...byPool].filter(([, p]) => p.launchBlock <= toBlock)),
    byToken: new Map([...byToken].filter(([, p]) => p.launchBlock <= toBlock)),
    manager: false,
    transactions,
    blocks: allBlocks,
    transfersFromLaunch: true,
  });
  // 7. The launch batch: what the final range holds.
  const kept = launched.filter(
    ({ migration }) => migration.block_number <= toBlock,
  );
  const claimReads: CrowdLaunchEvidence["claims"] = [];
  for (const { migration, auction, read } of kept) {
    if (typeof launchOf(auction, migration, read) === "string") continue;
    const query = claimQuery(auction, migration.block_number);
    const collected = await collectLogPages(client, query, caps);
    if (collected.toBlock !== migration.block_number - 1)
      throw Error("HyperSync crowd claim read was cut short");
    archiveHeight = Math.min(archiveHeight, collected.archiveHeight);
    claimReads.push({
      query,
      pages: collected.pages,
      logs: collected.logs,
      transactions: sortedTransactions(collected.transactions.values()),
      blocks: [...collected.blocks.values()].sort(
        (a, b) => a.number - b.number,
      ),
    });
  }
  const partial = {
    source: "hypersync" as const,
    stream: crowdLaunchStream,
    schemaVersion: 1 as const,
    registryRevision: crowdRegistryRevision,
    url: client.url,
    query: launchQuery,
    pages: launchPages.pages,
    creations: created
      .filter((c) => c.created.block_number <= toBlock)
      .flatMap((c) => [c.created, c.initializer])
      .sort(logOrder),
    migrations: kept.map((k) => k.migration),
    blocks: checkedRetainedBlocks(
      [
        cutoff,
        ...kept.map(({ migration }) => allBlocks.get(migration.block_number)!),
      ].filter(
        (b, i, all) => all.findIndex((x) => x.number === b.number) === i,
      ),
      toBlock,
    ),
    launches: kept.map((k) => ({
      ...k.read,
      transactions: sortedTransactions(k.read.transactions),
    })),
    claims: claimReads,
    archiveHeight,
  };
  const rows = crowdLaunchRows({ fromBlock, toBlock }, partial);
  const claims = crowdClaimRows(rows.launches, claimReads);
  const metadata = await readLaunchMetadata(
    rpc,
    admittedTokens(rows.launches),
    input.multicall,
  );
  const readBlocks = new Set(metadata.calls.map((c) => c.block.toLowerCase()));
  if (readBlocks.size > 1) throw Error("Launch metadata reads span blocks");
  const [readBlock] = readBlocks;
  const derived = crowdPools(
    rows.launches,
    metadata.results,
    readBlock === undefined ? null : Number(readBlock),
  );
  const launch: CrowdLaunchBatch = {
    fromBlock,
    toBlock,
    blockHash: rows.blockHash,
    toTimestamp: rows.toTimestamp,
    pools: derived.pools,
    auctions: rows.auctions,
    claims,
    evidence: {
      ...partial,
      rejected: derived.rejected,
      tokenMetadataIssues: derived.issues,
      calls: metadata.calls,
    },
  };
  verifyCrowdLaunchBatch(launch);
  if (!same(launch.blockHash, cutoff.hash))
    throw Error("HyperSync crowd cutoff disagrees with the header");
  return {
    fromBlock,
    toBlock,
    parentHash: lower(parentHash),
    blockHash: lower(cutoff.hash),
    toTimestamp: blockTimestamp(cutoff),
    archiveHeight,
    launch,
    swaps: trades.swaps,
    transfers: trades.transfers,
    claims,
    unsupportedSwaps: trades.unsupportedSwaps,
    swapSelection: "pool_ids",
    unregisteredSwaps: 0,
    registryPools: [...byPool.values()].filter((p) => p.launchBlock <= toBlock)
      .length,
    query: {
      launch: launchQuery,
      creations: creationQueries,
      claims: claimReads.map((r) => r.query),
      swaps: swapRecords,
      transfers: transferRecords,
    },
    pages: {
      launch: launchPages.pages,
      creations: creationPages,
      claims: claimReads.map((r) => r.pages),
      swaps: swapPages,
      transfers: transferPages,
      headers: headerPages,
    },
    requests: client.requests - requests0,
    bytes: client.bytes - bytes0,
    sentBytes: client.sentBytes - sentBytes0,
  };
}
