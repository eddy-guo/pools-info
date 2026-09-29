import type { AnalyticsWalletSummary } from "@pools/core";
import { countLabel } from "./plural";

/**
 * What the ledger's `unattributed_swap_activity` flag covers, in the words
 * the wallet header and the board rows disclose it with: the position's
 * token moved in a transaction whose swap the ledger could not attribute to
 * one wallet. In practice that is a swap pooled with other wallets' tokens
 * (a sell routed through a batch-sell contract, a buy whose tokens fanned
 * out to many wallets); a transaction with several swaps of one pool is left
 * unattributed the same way, so the label names the general case too. The
 * position's cost and proceeds then count in no figure (realized, net,
 * ROI, win rate, best sale, the curve), which is what the caption discloses.
 */
export const UNATTRIBUTED_SWAP_REASON = "pooled or unattributed swap";

/** The positions the read excluded for an unattributed swap, or 0 where the
    read carries no breakdown (the accounting fallback serves `null`). */
export function unattributedSwapExclusions(
  w: Pick<AnalyticsWalletSummary, "excludedByFlag">,
) {
  return w.excludedByFlag?.unattributed_swap_activity ?? 0;
}

/** The one-line disclosure a wallet's figures carry when at least one of
    its positions was excluded for an unattributed swap, counted as the rest
    of the site counts ("1 position", "1,234 positions"); null when there is
    nothing to disclose, so the surface renders no caption at all rather
    than a zero. The count is that flag's alone: the read's
    `excludedPositionCount` also holds positions excluded for other reasons,
    which this line does not describe. */
export function excludedPositionsCaption(
  w: Pick<AnalyticsWalletSummary, "excludedByFlag">,
) {
  const count = unattributedSwapExclusions(w);
  return count > 0
    ? `${countLabel(count, "position")} excluded (${UNATTRIBUTED_SWAP_REASON})`
    : null;
}
