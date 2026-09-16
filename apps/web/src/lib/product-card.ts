import {
  buildAnalyticsModel,
  walletAnalytics,
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
      scope: null,
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
  };
}

/** The card's rank badge: a global card names only the rank, a pool card its pool. */
export function cardRankLabel(
  rank: number | null,
  scope: string | null,
): string | null {
  if (rank === null) return scope;
  return scope ? `#${rank} in ${scope}` : `#${rank}`;
}
