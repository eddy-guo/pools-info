import type { LiveWindow } from "@pools/core";

export type ScreenerStatsResponse = {
  window: LiveWindow;
  asOf: number;
  cutoff: { block: number; hash: string; asOf: number };
  windowStart: number | null;
  volumeWei: string | null;
  trades: number | null;
  liquidityWei: string | null;
  poolsLaunched: number;
  activeTraders: number | null;
  completeWindow: boolean;
  coverage: {
    catalogPools: number;
    processedPools: number;
    asOf: number;
    oldestAsOf: number;
    generatedAt: string;
    complete: boolean;
    registryExhaustive: boolean;
    pnlScope: "attributed_positions_all_pools";
    measuredPools: number;
    activeTraderScope: "attributed_wallets_in_measured_pools";
  };
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const decimal = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const nullableDecimal = (value: unknown): value is string | null =>
  value === null || decimal(value);
const nullableCount = (value: unknown): value is number | null =>
  value === null || count(value);

/** Reject an absent or changed stats contract before any aggregate is shown. */
export function validateStatsResponse(
  value: unknown,
  window: LiveWindow,
): asserts value is ScreenerStatsResponse {
  if (!record(value) || !record(value.cutoff) || !record(value.coverage))
    throw Error("Invalid screener stats");
  const cutoff = value.cutoff;
  const coverage = value.coverage;
  if (
    value.window !== window ||
    !count(value.asOf) ||
    !count(cutoff.block) ||
    typeof cutoff.hash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(cutoff.hash) ||
    !count(cutoff.asOf) ||
    (window === "All"
      ? value.windowStart !== null
      : !count(value.windowStart)) ||
    !nullableDecimal(value.volumeWei) ||
    !nullableCount(value.trades) ||
    !nullableDecimal(value.liquidityWei) ||
    !count(value.poolsLaunched) ||
    !nullableCount(value.activeTraders) ||
    typeof value.completeWindow !== "boolean" ||
    !count(coverage.catalogPools) ||
    !count(coverage.processedPools) ||
    !count(coverage.asOf) ||
    !count(coverage.oldestAsOf) ||
    typeof coverage.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(coverage.generatedAt)) ||
    typeof coverage.complete !== "boolean" ||
    typeof coverage.registryExhaustive !== "boolean" ||
    coverage.pnlScope !== "attributed_positions_all_pools" ||
    !count(coverage.measuredPools) ||
    coverage.activeTraderScope !== "attributed_wallets_in_measured_pools"
  )
    throw Error("Invalid screener stats");
}
