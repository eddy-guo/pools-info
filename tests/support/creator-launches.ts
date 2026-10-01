import type {
  AnalyticsCoverage,
  AnalyticsExploreResponse,
  AnalyticsPoolRow,
} from "@pools/core";

/** A creator's own page reads its launches through the explore read, one
    page of the launch order at a time; this fabricates one creator's history
    with more launches than a page, newest first, where only every
    `measuredEvery`th launch carries a market figure and every fifth is a
    crowd launch. */
export const creatorAddress = "0x00d153da1a8a38d3903273295257e7d25cf78a57";

const coverage: AnalyticsCoverage = {
  catalogPools: 130,
  processedPools: 130,
  asOf: 1_700_000_000,
  oldestAsOf: 1_700_000_000,
  generatedAt: "2026-09-17T00:00:00.000Z",
  complete: false,
  registryExhaustive: false,
  pnlScope: "observed_initiator_and_verified_positions",
};

export function creatorLaunches(total: number, measuredEvery: number) {
  return Array.from({ length: total }, (_, i): AnalyticsPoolRow => {
    const measured = i % measuredEvery === 0;
    const n = total - i;
    return {
      id: `0x${n.toString(16).padStart(64, "a")}`,
      token: `0x${n.toString(16).padStart(40, "b")}`,
      name: `Launch ${n}`,
      symbol: `L${n}`,
      launchTx: `0x${n.toString(16).padStart(64, "c")}`,
      launchSender: creatorAddress,
      launchBlock: 1_000_000 + n,
      launchedAt: 1_700_000_000 + n * 60,
      launchType: n % 5 === 0 ? "crowd" : "instant",
      marketCoverage: null,
      processed: false,
      market: null,
      stats: {
        priceWei: measured ? "1000000000000" : null,
        volumeWei: measured ? (BigInt(n) * 10n ** 17n).toString() : null,
        liquidityWei: null,
        change: measured ? 1.5 : null,
        trades: measured ? (n % 2 ? 3 : 0) : null,
        holders: null,
        completeWindow: false,
      },
      asOf: null,
      throughBlock: null,
      generatedAt: null,
      sourceKind: null,
    };
  });
}

/** The page of `launches` a creator-page explore read at `url` asks for, in
    the launch order's direction (newest first unless `direction=asc`, the
    page's first-launch read), or null when the read is not this creator's. */
export function creatorLaunchesPage(
  launches: AnalyticsPoolRow[],
  url: string,
): {
  offset: number;
  limit: number;
  direction: "asc" | "desc";
  json: AnalyticsExploreResponse & { delivery: { source: "indexer" } };
} | null {
  const params = new URL(url).searchParams;
  if (
    !url.includes("/api/product/explore") ||
    params.get("q") !== creatorAddress
  )
    return null;
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 25);
  const direction = params.get("direction") === "asc" ? "asc" : "desc";
  const ordered = direction === "asc" ? [...launches].reverse() : launches;
  return {
    offset,
    limit,
    direction,
    json: {
      coverage,
      broadMarketCutoff: null,
      items: ordered.slice(offset, offset + limit),
      total: launches.length,
      nextOffset: offset + limit < launches.length ? offset + limit : null,
      window: "24h",
      delivery: { source: "indexer" },
    },
  };
}
