import { toEventSelector } from "viem";
import { getInstantDeployment, launchEvent } from "@pools/chain";
import type {
  CreatorFeeRow,
  RetainedLaunchLog,
  UnresolvedCreatorFeeBatch,
} from "@pools/db";

/** The creator-fee flag for catalog pools written before migration 021
 * (`pnpm creator-fees:backfill`). The flag is the pinned registry's per
 * strategy (`packages/chain/src/deployments.ts`), keyed by the address that
 * emitted a pool's launch log, and the launch stream retains every verified
 * launch log in its batch evidence, so the fill reads those logs back from
 * the database and touches no chain source. Resumable and idempotent: only a
 * null flag is ever written, and a stopped run continues on the next batch
 * still holding one. */
const launchTopic = toEventSelector(launchEvent);

/** The flag for each retained launch log, from the registry entry of the
 * strategy that emitted it. A log that is not a launch, or one from a
 * strategy the registry does not name, is refused: the lane verified every
 * retained log against that registry when it wrote the batch, so either means
 * the evidence is not what the lane wrote. */
export function resolveCreatorFees(
  logs: readonly RetainedLaunchLog[],
): CreatorFeeRow[] {
  const rows = new Map<string, CreatorFeeRow>();
  for (const log of logs) {
    if (log.topic0 !== launchTopic) throw Error("Retained log is not a launch");
    const deployment = getInstantDeployment(log.address);
    if (!deployment) throw Error("Retained launch names an unknown strategy");
    if (rows.has(log.topic1)) throw Error("Duplicate retained launch");
    rows.set(log.topic1, {
      poolId: log.topic1,
      launchTx: log.transactionHash,
      launchBlock: log.blockNumber,
      creatorFees: deployment.creatorFees,
    });
  }
  return [...rows.values()];
}

export interface CreatorFeeBackfillDeps {
  batches(): Promise<UnresolvedCreatorFeeBatch[]>;
  logs(batchEnd: number): Promise<RetainedLaunchLog[]>;
  save(rows: CreatorFeeRow[]): Promise<number>;
  log?: (event: Record<string, unknown>) => void;
  signal?: AbortSignal;
}
export interface CreatorFeeBackfillSummary {
  batches: number;
  /** Pools the batches were selected for. */
  unresolved: number;
  /** Pools whose flag the run wrote. */
  filled: number;
  stopped: boolean;
}
/** Every batch still holding an unknown flag, oldest first: its retained
 * launch logs resolved and stored on the pools whose recorded launch they
 * name. A batch that fills fewer pools than it was selected for is reported
 * rather than hidden, since the difference is a pool whose catalog row does
 * not match its retained log. */
export async function runCreatorFeeBackfill(
  deps: CreatorFeeBackfillDeps,
): Promise<CreatorFeeBackfillSummary> {
  const log = deps.log ?? (() => {});
  const batches = await deps.batches();
  const summary: CreatorFeeBackfillSummary = {
    batches: batches.length,
    unresolved: batches.reduce((n, b) => n + b.pools, 0),
    filled: 0,
    stopped: false,
  };
  for (const batch of batches) {
    if (deps.signal?.aborted) {
      summary.stopped = true;
      break;
    }
    const rows = resolveCreatorFees(await deps.logs(batch.batchEnd));
    const filled = await deps.save(rows);
    summary.filled += filled;
    log({
      event: "creator_fees_batch",
      batchEnd: batch.batchEnd,
      launches: rows.length,
      unresolved: batch.pools,
      filled,
    });
    if (filled < batch.pools)
      log({
        event: "creator_fees_batch_short",
        batchEnd: batch.batchEnd,
        unresolved: batch.pools,
        filled,
      });
  }
  return summary;
}
