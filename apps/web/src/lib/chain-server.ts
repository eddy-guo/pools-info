import type { AnalyticsPoolDetail, ChainSnapshot } from "@pools/core";
import captured from "../../../../data/pools/index.json";
import initial from "../../../../data/snapshots/chain.json";
import { readProduct } from "./product-server";
export function capturedPoolSnapshot(
  poolId: string,
  launchTx: string,
): ChainSnapshot | undefined {
  const snapshot = (captured.snapshots as Record<string, ChainSnapshot>)[
    poolId.toLowerCase()
  ];
  return snapshot?.markets[0]?.launchTx.toLowerCase() === launchTx.toLowerCase()
    ? snapshot
    : undefined;
}
/** Shared legacy context is a preloaded snapshot. Product views read saved DB pages. */
export async function currentChainSnapshot(): Promise<ChainSnapshot> {
  return initial as ChainSnapshot;
}
export async function targetedMarketSnapshot(
  poolId: string,
  launchTx: `0x${string}`,
  _refresh = false,
): Promise<ChainSnapshot> {
  void _refresh;
  const result = await readProduct<{ analytics: AnalyticsPoolDetail | null }>(
    ["pools", poolId.toLowerCase()],
    new URLSearchParams(),
  );
  const snapshot = result.analytics?.snapshot;
  if (
    !snapshot ||
    snapshot.markets[0]?.launchTx.toLowerCase() !== launchTx.toLowerCase()
  )
    throw Error("Pool analytics are not published yet");
  return snapshot;
}
export async function auditedPoolSnapshot(
  poolId: string,
  launchTx: `0x${string}`,
  refresh = false,
) {
  const snapshot = await targetedMarketSnapshot(poolId, launchTx, refresh);
  if (!snapshot.markets[0]?.accounting?.executions)
    throw Error("Saved accounting is not published yet");
  return snapshot;
}
