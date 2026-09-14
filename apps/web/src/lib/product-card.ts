import {
  buildAnalyticsModel,
  walletAnalytics,
  type AnalyticsWalletSummary,
  type AnalyticsWalletResponse,
  type AnalyticsPoolDetail,
  type LiveWindow,
} from "@pools/core";
import { readProduct } from "./product-server";

export async function readCardWallet(
  address: string,
  window: LiveWindow,
  poolId?: string,
  launchTx?: string,
) {
  if (!poolId)
    return {
      result: await readProduct<AnalyticsWalletResponse>(
        ["wallets", address],
        new URLSearchParams({ window }),
      ),
      scope: "processed pools",
      global: true,
    };
  const saved = await readProduct<{ analytics: AnalyticsPoolDetail | null }>(
    ["pools", poolId],
    new URLSearchParams({ window }),
  );
  const publication = saved.analytics,
    market = publication?.snapshot.markets[0];
  if (
    !publication ||
    !market ||
    market.id.toLowerCase() !== poolId ||
    (launchTx && market.launchTx.toLowerCase() !== launchTx)
  )
    throw Error("Requested pool capture unavailable");
  const result = walletAnalytics(
    buildAnalyticsModel([market], [publication]),
    address,
    window,
  );
  return {
    result: { ...result, delivery: saved.delivery },
    scope: `${market.symbol} pool`,
    global: false,
  };
}

/** Card freshness belongs to this wallet's captures, not a newer unrelated pool. */
export function walletCaptureLabel(
  wallet: Pick<AnalyticsWalletSummary, "asOf" | "oldestAsOf">,
): string {
  const stamp = (n: number) =>
    new Date(n * 1000).toISOString().slice(0, 19).replace("T", " ");
  if (wallet.asOf === null || !Number.isFinite(wallet.asOf))
    return "Wallet cutoff unavailable";
  if (wallet.oldestAsOf !== null && wallet.oldestAsOf < wallet.asOf)
    return `Wallet captures ${stamp(wallet.oldestAsOf)} to ${stamp(wallet.asOf)} UTC`;
  return `Wallet captured ${stamp(wallet.asOf)} UTC`;
}
