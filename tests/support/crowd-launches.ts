import type {
  AnalyticsCoverage,
  AnalyticsExploreResponse,
  AnalyticsPoolRow,
} from "@pools/core";

/* Mocked read API answers in the shape of the crowd launch contract
   (`view=crowd` lists the pools.xyz crowd launches, each row carrying
   `launchType`). Right after the deploy the crowd ledger stream is still
   catching up, so some crowd pools are listed but unmeasured: null price,
   volume, trades and change, and no market coverage, exactly as any
   unmeasured launch reads. Every identity and figure here is synthetic. */

const coverage: AnalyticsCoverage = {
  catalogPools: 130,
  processedPools: 130,
  asOf: 1_700_000_000,
  oldestAsOf: 1_700_000_000,
  generatedAt: "2026-09-26T00:00:00.000Z",
  complete: false,
  registryExhaustive: false,
  pnlScope: "observed_initiator_and_verified_positions",
};

export const crowdCreator = "0x5c0a8e1d7b6f4a3c2e1d0b9a8f7e6d5c4b3a2918";

/** `total` crowd launches, newest first, of which every `measuredEvery`th
    carries the ledger's market figures and the rest are still unmeasured. */
export function crowdLaunches(total: number, measuredEvery: number) {
  return Array.from({ length: total }, (_, i): AnalyticsPoolRow => {
    const measured = i % measuredEvery === 0;
    const n = total - i;
    const launchedAt = Math.floor(Date.now() / 1000) - (i + 1) * 5400;
    return {
      id: `0x${n.toString(16).padStart(64, "c")}`,
      token: `0x${n.toString(16).padStart(40, "d")}`,
      name: `Crowd Launch ${n}`,
      symbol: `CRWD${n}`,
      launchTx: `0x${n.toString(16).padStart(64, "e")}`,
      launchSender: crowdCreator,
      launchBlock: 28_800_000 + n * 1000,
      launchedAt,
      launchType: "crowd",
      marketCoverage: measured
        ? {
            source: "aggregate_ledger",
            startBlock: 23_467_030,
            cutoff: {
              block: 29_000_000,
              hash: `0x${"f".repeat(64)}`,
              asOf: launchedAt + 3600,
            },
            windowStart: launchedAt,
            indexedAt: "2026-09-26T00:00:00.000Z",
            unitsConflict: false,
            unitBasis: null,
            rawPrice: null,
            priceBaseline: null,
          }
        : null,
      processed: false,
      market: null,
      stats: {
        priceWei: measured ? "1840000000000" : null,
        volumeWei: measured ? (BigInt(n) * 37n * 10n ** 16n).toString() : null,
        liquidityWei: null,
        change: measured ? (n % 2 ? 12.4 : -3.1) : null,
        trades: measured ? n * 7 : null,
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

/** The crowd view's answer to an explore read at `url`, or null when the
    read names another view. A volume or trades order leaves the unmeasured
    launches out, as the read API does; the launch order keeps them all. */
export function crowdExplorePage(
  launches: AnalyticsPoolRow[],
  url: string,
): (AnalyticsExploreResponse & { delivery: { source: "indexer" } }) | null {
  const params = new URL(url).searchParams;
  if (!url.includes("/api/product/explore") || params.get("view") !== "crowd")
    return null;
  const sort = params.get("sort") ?? "launch";
  const rows =
    sort === "volume" || sort === "trades" || sort === "change"
      ? launches.filter((row) => row.stats.volumeWei !== null)
      : launches;
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 25);
  return {
    coverage,
    broadMarketCutoff: null,
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    window: (params.get("window") ??
      "24h") as AnalyticsExploreResponse["window"],
    delivery: { source: "indexer" },
  };
}

/** A crowd pool's own page while its market is still unmeasured: the
    identity with `launchType`, and no market. */
export function crowdPoolDetail(row: AnalyticsPoolRow) {
  return {
    pool: {
      poolId: row.id,
      token: row.token,
      name: row.name,
      symbol: row.symbol,
      imageUrl: null,
      launchType: "crowd",
      launch: {
        block: row.launchBlock,
        timestamp: row.launchedAt,
        transactionHash: row.launchTx,
        transactionInitiator: row.launchSender,
      },
    },
    analytics: null,
    market: null,
    delivery: { source: "indexer" },
  };
}
