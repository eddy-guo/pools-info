import type { AnalyticsWalletSummary } from "@pools/core";

export function hasInitiatorModel(wallet: AnalyticsWalletSummary) {
  return wallet.accountingTier === "tier2" || wallet.accountingTier === "mixed";
}

export function accountingLabel(wallet: AnalyticsWalletSummary) {
  if (wallet.accountingTier === "tier2") return "Swap-based estimate";
  if (wallet.accountingTier === "mixed") return "Mixed evidence";
  if (wallet.accountingTier === "tier3" || wallet.supportedPositionCount > 0)
    return "Transfer-verified";
  return "History incomplete";
}

export function accountingExplanation(wallet: AnalyticsWalletSummary) {
  return hasInitiatorModel(wallet)
    ? "Includes a swap-only model attributed to transaction initiators. Transfers, beneficiaries and wallet balances are not verified for that portion."
    : "Uses positions reconciled against token transfers and the saved inventory cutoff. Coverage does not include all wallet activity.";
}
