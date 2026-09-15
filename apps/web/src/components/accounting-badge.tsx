import type { AnalyticsWalletSummary } from "@pools/core";
import { accountingExplanation, accountingLabel } from "@/lib/accounting-evidence";

export function AccountingBadge({ wallet }: { wallet: AnalyticsWalletSummary }) {
  return (
    <span className="evidence-badge" title={accountingExplanation(wallet)}>
      {accountingLabel(wallet)}
    </span>
  );
}
