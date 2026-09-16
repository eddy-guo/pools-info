/** INDEXER_DEEP_TIER_ENABLED=0 keeps the tier-3 per-pool sweeps paused while
 * the service, discovery, the live feed and analytics keep running. Saved pool
 * cursors are untouched and resume where they stopped once re-enabled. */
export function deepTierEnabled(
  value = process.env.INDEXER_DEEP_TIER_ENABLED,
): boolean {
  if (value === undefined || value === "1") return true;
  if (value === "0") return false;
  throw Error("Invalid INDEXER_DEEP_TIER_ENABLED; expected 0 or 1");
}
