import type { AnalyticsExploreResponse, CatalogPool } from "@pools/core";

/**
 * Where a launch came from, as the read API names it on every catalogue row
 * (explore rows, a creator's best launch, the pool page's `pool`): an
 * Instant strategy's launch or a pools.xyz crowd (auction) launch that
 * migrated into its pool. A value outside the pair is a contract break. An
 * absent one is tolerated: the read API before the crowd launch lane sends
 * none, and its integration tests still grade their pool pages through this
 * site's validator.
 */
export const validLaunchType = (value: unknown) =>
  value === undefined || value === "instant" || value === "crowd";

/** A stale or misrouted response must never show another view's pools: the
 * crowd view lists crowd launches and nothing else. */
export function validateExploreResponse(
  value: unknown,
  params: URLSearchParams,
): asserts value is AnalyticsExploreResponse {
  const data = value as AnalyticsExploreResponse | null;
  if (!data || !Array.isArray(data.items))
    throw Error("Invalid explore response");
  const crowd = params.get("view") === "crowd";
  for (const row of data.items as (CatalogPool | null)[])
    if (
      !row ||
      typeof row !== "object" ||
      !validLaunchType(row.launchType) ||
      (crowd && row.launchType !== "crowd")
    )
      throw Error("Invalid explore row");
}
