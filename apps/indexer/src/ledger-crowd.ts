import {
  HyperSyncClient,
  HyperSyncRateLimitExhausted,
  HyperSyncUnauthorized,
  Rpc,
  RpcRateLimitExhausted,
  collectCrowdRange,
  crowdPassPolicy,
  hypersyncPolicy,
  multicallConfig,
  type CrowdRangeCollection,
  type MulticallConfig,
} from "@pools/chain";
import {
  applyLedgerBatch,
  commitCrowdLaunchBatch,
  crowdLaunchStreamIdentity,
  crowdLedgerStream,
  crowdPendingAuctions,
  ensureCrowdLaunchStream,
  ensureLedgerStream,
  getStream,
  ledgerBatchCreatedRows,
  ledgerCheckpoints,
  ledgerRegistry,
  ledgerStream,
  readLedgerStream,
  recomputeLedgerWindowWallets,
  rewind,
  setLedgerMode,
  walkBackLedger,
  type Client,
  type LedgerStreamState,
  type Stream,
} from "@pools/db";
import { ledgerBatchOf, type LedgerRangeProgress } from "./ledger-pass";
import { errorDetails } from "./errors";

/** The crowd lane (docs/CROWD-LAUNCHES.md) inside the ledger tip loop: the
 * pools.xyz crowd launches and their pools' trades, folded through a ledger
 * stream of their own (`ledger:crowd:v1`) that never passes the main
 * stream's cursor. From an empty stream it catches the whole history up
 * from the ledger's start block in large ranges, spending at most
 * `budgetMs` of each cycle so the main stream keeps its pace; once level it
 * follows the main cursor every cycle, about four requests. It shares the
 * loop's HyperSync client, pacer and token, so a throttle pauses the loop and
 * a rejected token stops it as in the main lane; any other failure is the
 * crowd lane's alone and the main stream carries on. */
export const ledgerCrowdDefaults = Object.freeze({
  rangeBlocks: crowdPassPolicy.rangeBlocks,
  maxRangeBlocks: crowdPassPolicy.maxRangeBlocks,
  /** Consecutive failed crowd steps back off doubling up to this many
   * cycles. */
  maxBackoffCycles: 64,
});

type Log = (event: Record<string, unknown>) => void;
const quiet: Log = () => {};
const crowdKey = crowdLedgerStream.key;

/** A block the main stream committed as a checkpoint with this hash: the
 * main stream reconciled its own cursor this cycle and its checkpoints form
 * one hash chain, so the crowd stream reads no header to trust it. */
async function mainCheckpoint(db: Client, block: number, hash: string) {
  const r = await db.query(
    "SELECT 1 FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2 AND block_hash=decode($3,'hex')",
    [ledgerStream.key, block, hash.slice(2)],
  );
  return (r.rowCount ?? 0) > 0;
}
async function canonical(
  db: Client,
  client: HyperSyncClient,
  block: number,
  hash: string,
) {
  if (await mainCheckpoint(db, block, hash)) return true;
  return (await client.header(block)).hash.toLowerCase() === hash;
}
/** Bring the crowd streams back under the main one before extending: a
 * crowd cursor past the main cursor (the main stream walked back) or off the
 * canonical chain walks the crowd ledger back to its newest checkpoint that
 * is neither, and the crowd launch stream is rewound to the crowd ledger's
 * cursor when a stop landed between a range's two commits. */
export async function reconcileLedgerCrowd(
  db: Client,
  client: HyperSyncClient,
  log: Log = quiet,
): Promise<{
  ledger: LedgerStreamState;
  launches: Stream;
  main: LedgerStreamState;
}> {
  const main = await readLedgerStream(db);
  let ledger = await ensureLedgerStream(db, "pass", crowdKey);
  let launches = await ensureCrowdLaunchStream(db);
  if (main.cursor === null) throw Error("ledger_tip_requires_pass");
  if (
    ledger.cursor !== null &&
    (ledger.cursor > main.cursor ||
      !(await canonical(db, client, ledger.cursor, ledger.hash!)))
  ) {
    let ancestor: number | null = null;
    for (const checkpoint of await ledgerCheckpoints(db, crowdKey))
      if (
        checkpoint.to <= main.cursor &&
        (await canonical(db, client, checkpoint.to, checkpoint.hash))
      ) {
        ancestor = checkpoint.to;
        break;
      }
    const removed = await walkBackLedger(db, ancestor, crowdKey);
    log({
      event: "ledger_crowd_walk_back",
      from: ledger.cursor,
      to: ancestor,
      removed: removed.removed.length,
    });
    ledger = await readLedgerStream(db, crowdKey);
  }
  if (launches.cursor !== ledger.cursor || launches.hash !== ledger.hash) {
    const ahead =
      launches.cursor !== null &&
      (ledger.cursor === null || launches.cursor > ledger.cursor);
    if (!ahead) throw Error("ledger_pass_streams_diverged");
    await rewind(db, launches, ledger.cursor);
    log({
      event: "ledger_crowd_launch_rewind",
      from: launches.cursor,
      to: ledger.cursor,
    });
    launches = await getStream(db, crowdLaunchStreamIdentity.key);
    if (launches.cursor !== ledger.cursor || launches.hash !== ledger.hash)
      throw Error("ledger_pass_streams_diverged");
  }
  return { ledger, launches, main };
}
/** The next crowd range: from the crowd cursor, at most `rangeBlocks`, never
 * past the main cursor, and ending on a main checkpoint where one lies in it
 * so the next reconcile needs no header. Null once level with the main
 * cursor. */
export async function planCrowdRange(
  db: Client,
  ledger: LedgerStreamState,
  main: LedgerStreamState,
  rangeBlocks: number,
): Promise<{ fromBlock: number; toBlock: number } | null> {
  if (main.cursor === null) return null;
  const fromBlock = ledger.cursor === null ? ledger.start : ledger.cursor + 1;
  if (fromBlock > main.cursor) return null;
  const end = Math.min(main.cursor, fromBlock + rangeBlocks - 1);
  const snapped = await db.query(
    "SELECT max(to_block)::text AS to FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block BETWEEN $2 AND $3",
    [ledgerStream.key, fromBlock, end],
  );
  return {
    fromBlock,
    toBlock: snapped.rows[0].to === null ? end : Number(snapped.rows[0].to),
  };
}
export interface LedgerCrowdRangeProgress extends LedgerRangeProgress {
  auctions: number;
  rejected: number;
  /** The crowd cursor reached the main cursor. */
  level: boolean;
}
/** One crowd range: plan, collect, commit the launches with the auctions
 * they saw created, apply the ledger batch with the windows of the wallets
 * it touched. Idle when level with the main cursor. */
export async function runLedgerCrowdRange(
  db: Client,
  client: HyperSyncClient,
  options: {
    rangeBlocks: number;
    maxPages: number;
    height: number;
    rpc: () => Rpc;
    multicall?: MulticallConfig;
    signal?: AbortSignal;
    log?: Log;
    onRange?: (
      range: { from: number; to: number; lane?: "crowd" } | null,
    ) => void;
  },
): Promise<LedgerCrowdRangeProgress | { idle: true; from: number }> {
  const started = performance.now();
  const { ledger, launches, main } = await reconcileLedgerCrowd(
    db,
    client,
    options.log,
  );
  const range = await planCrowdRange(db, ledger, main, options.rangeBlocks);
  if (!range)
    return {
      idle: true,
      from: ledger.cursor === null ? ledger.start : ledger.cursor + 1,
    };
  options.signal?.throwIfAborted();
  options.onRange?.({
    from: range.fromBlock,
    to: range.toBlock,
    lane: "crowd",
  });
  const registry = await ledgerRegistry(db, range.fromBlock - 1, "crowd");
  const pending = await crowdPendingAuctions(db, range.fromBlock);
  const c: CrowdRangeCollection = await collectCrowdRange(
    client,
    options.rpc(),
    {
      ...range,
      parentHash: ledger.hash,
      height: options.height,
      registry,
      pending,
      maxPages: options.maxPages,
      multicall: options.multicall ?? multicallConfig(),
    },
  );
  options.signal?.throwIfAborted();
  await commitCrowdLaunchBatch(db, launches, {
    from: c.fromBlock,
    to: c.toBlock,
    hash: c.blockHash,
    evidence: c.launch.evidence,
    auctions: c.launch.auctions,
    pools: c.launch.pools.map((p) => ({
      id: p.id,
      token: p.token,
      name: p.name,
      symbol: p.symbol,
      launchBlock: p.launchBlock,
      launchTx: p.launchTx,
      launchSender: p.launchSender,
      launchedAt: p.launchedAt,
      ...(p.imageUrl === undefined ? {} : { imageUrl: p.imageUrl }),
      ...(p.description === undefined ? {} : { description: p.description }),
      ...(p.externalUrl === undefined ? {} : { externalUrl: p.externalUrl }),
      decimals: p.decimals,
      totalSupplyRaw: p.totalSupplyRaw ?? null,
      supplyBlock: p.supplyBlock ?? null,
      creatorFees: p.creatorFees,
      launchType: "crowd",
    })),
  });
  const applied = await applyLedgerBatch(db, ledgerBatchOf(c), crowdKey, {
    touched: recomputeLedgerWindowWallets,
  });
  options.onRange?.(null);
  const created = applied.changed
    ? await ledgerBatchCreatedRows(db, c.toBlock, crowdKey)
    : { positions: 0, wallets: 0 };
  const level = c.toBlock >= main.cursor!;
  if (level && ledger.mode !== "tip") {
    await setLedgerMode(db, "tip", crowdKey);
    options.log?.({ event: "ledger_crowd_level", cursor: c.toBlock });
  }
  const pages =
    c.pages.launch.length +
    c.pages.creations.reduce((n, p) => n + p.length, 0) +
    c.pages.claims.reduce((n, p) => n + p.length, 0) +
    c.pages.swaps.reduce((n, p) => n + p.length, 0) +
    c.pages.transfers.reduce((n, p) => n + p.length, 0) +
    c.pages.headers.length;
  return {
    idle: false,
    from: c.fromBlock,
    to: c.toBlock,
    blocks: c.toBlock - c.fromBlock + 1,
    launches: c.launch.pools.length,
    auctions: c.launch.auctions.length,
    rejected: c.launch.evidence.rejected.length,
    swaps: c.swaps.length,
    unsupportedSwaps: c.unsupportedSwaps,
    transfers: c.transfers.length,
    attributed: applied.attributed,
    unattributed: applied.unattributed,
    unregisteredSwaps: applied.unregisteredSwaps,
    positionsChanged: applied.positions,
    newPositions: created.positions,
    newWallets: created.wallets,
    registryPools: c.registryPools,
    swapSelection: "pool_ids",
    // The crowd lane lists its few tokens every range; it never probes.
    transferSelection: "tokens",
    unregisteredTransfers: 0,
    transferPages: c.pages.transfers.reduce((n, p) => n + p.length, 0),
    transferFallbackRequests: 0,
    pages,
    requests: c.requests,
    bytes: c.bytes,
    sentBytes: c.sentBytes,
    elapsedMs: Math.round(performance.now() - started),
    archiveHeight: c.archiveHeight,
    replayed: !applied.changed,
    rangeBlocks: options.rangeBlocks,
    cut: c.toBlock < range.toBlock,
    singlePage:
      c.pages.launch.length === 1 &&
      c.pages.swaps.every((p) => p.length === 1) &&
      c.pages.transfers.every((p) => p.length === 1),
    level,
  };
}
export interface LedgerCrowdStep {
  ranges: LedgerCrowdRangeProgress[];
  /** The crowd cursor is level with the main cursor. */
  level: boolean;
  /** The next range size, grown by quiet ranges and reset by cut ones. */
  rangeBlocks: number;
  /** A failure the crowd lane logged and absorbed, or null. */
  failed: string | null;
}
/** Failures a crowd step must hand to the loop: the token and its rate are
 * the main lane's too. */
export const crowdStopsTheLoop = (error: unknown) =>
  error instanceof HyperSyncRateLimitExhausted ||
  error instanceof RpcRateLimitExhausted ||
  error instanceof HyperSyncUnauthorized;
/** Crowd ranges until level with the main cursor, `budgetMs` elapsed or an
 * abort. Every range commits or fails alone. */
export async function runLedgerCrowdStep(
  db: Client,
  client: HyperSyncClient,
  options: {
    rangeBlocks: number;
    maxRangeBlocks: number;
    maxPages: number;
    height: number;
    budgetMs: number;
    rpc: () => Rpc;
    multicall?: MulticallConfig;
    signal?: AbortSignal;
    log?: Log;
    safeError: (error: unknown) => string;
    onRange?: (
      range: { from: number; to: number; lane?: "crowd" } | null,
    ) => void;
  },
): Promise<LedgerCrowdStep> {
  const started = performance.now();
  const step: LedgerCrowdStep = {
    ranges: [],
    level: false,
    rangeBlocks: options.rangeBlocks,
    failed: null,
  };
  if (options.height < hypersyncPolicy.safeDistance) return step;
  for (;;) {
    if (options.signal?.aborted) return step;
    let result: Awaited<ReturnType<typeof runLedgerCrowdRange>>;
    try {
      result = await runLedgerCrowdRange(db, client, {
        ...options,
        rangeBlocks: step.rangeBlocks,
      });
    } catch (error) {
      options.onRange?.(null);
      if (options.signal?.aborted || crowdStopsTheLoop(error)) throw error;
      step.failed = options.safeError(error);
      options.log?.({
        event: "ledger_crowd_failed",
        error: step.failed,
        ...errorDetails(error),
      });
      return step;
    }
    if (result.idle) {
      step.level = true;
      return step;
    }
    step.ranges.push(result);
    step.level = result.level;
    step.rangeBlocks = result.cut
      ? ledgerCrowdDefaults.rangeBlocks
      : result.singlePage
        ? Math.min(options.maxRangeBlocks, step.rangeBlocks * 2)
        : step.rangeBlocks;
    if (step.level || performance.now() - started >= options.budgetMs)
      return step;
  }
}
