import { unstable_cache } from "next/cache";
import { collectSnapshot, Rpc } from "@pools/chain";
import type { ChainSnapshot } from "@pools/core";
import captured from "../../../../data/pools/index.json";

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

let pending: Promise<ChainSnapshot> | undefined;
async function refresh() {
  // Coalesce concurrent cold requests in this function instance. The Next data
  // cache shares successful results across requests; a failed refresh throws.
  pending ??= collectSnapshot({ rpc: new Rpc(undefined, { timeoutMs: 90000 }) })
    .then(({ snapshot }) => snapshot)
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
// Retain the documented Data Cache API while existing static routes use the
// non-Cache-Components model. No provider credentials enter the cache key.
export const currentChainSnapshot = unstable_cache(
  refresh,
  ["chain-markets-v4"],
  { revalidate: 60 },
);

const audits = new Map<string, Promise<ChainSnapshot>>();
async function audit(poolId: string, launchTx: `0x${string}`) {
  const key = `${poolId}:${launchTx}`;
  let pending = audits.get(key);
  if (!pending) {
    pending = collectSnapshot({
      target: { poolId, launchTx },
      poolLimit: 1,
      includeAccounting: true,
      rpc: new Rpc(undefined, { timeoutMs: 180000, maxRequests: 10000 }),
    })
      .then((r) => r.snapshot)
      .finally(() => audits.delete(key));
    audits.set(key, pending);
  }
  return pending;
}
const liveAuditedPoolSnapshot = unstable_cache(audit, ["chain-accounting-v2"], {
  revalidate: 300,
});

export async function auditedPoolSnapshot(
  poolId: string,
  launchTx: `0x${string}`,
  refresh = false,
) {
  const saved = !refresh && capturedPoolSnapshot(poolId, launchTx);
  return (
    (saved && saved.markets[0]?.accounting ? saved : undefined) ||
    liveAuditedPoolSnapshot(poolId, launchTx)
  );
}

const liveTargetedMarketSnapshot = unstable_cache(
  async (poolId: string, launchTx: `0x${string}`) =>
    (
      await collectSnapshot({
        target: { poolId, launchTx },
        poolLimit: 1,
        rpc: new Rpc(undefined, { timeoutMs: 90000 }),
      })
    ).snapshot,
  ["chain-target-v1"],
  { revalidate: 60 },
);

export async function targetedMarketSnapshot(
  poolId: string,
  launchTx: `0x${string}`,
  refresh = false,
) {
  const result =
    (!refresh && capturedPoolSnapshot(poolId, launchTx)) ||
    (await liveTargetedMarketSnapshot(poolId, launchTx));
  // Pool charts/history do not need the heavier per-wallet audit payload.
  return {
    ...result,
    markets: result.markets.map((m) => {
      const { accounting, ...market } = m;
      void accounting;
      return market;
    }),
  };
}
