import { validateCreatorsResponse } from "./creators-response";
import { validateEthPriceResponse } from "./eth-price-response";
import { validateFollowingResponse } from "./following-response";
import { normalizePoolLaunch, validatePoolResponse } from "./pool-response";
import { validateTradeShareResponse } from "./trade-share-response";
import {
  buildAnalyticsModel,
  exploreAnalytics,
  leaderboardAnalytics,
  walletAnalytics,
  searchAnalytics,
  poolAnalytics,
  type AnalyticsPublication,
  type CatalogPool,
  type ChainSnapshot,
  type AnalyticsExploreOptions,
  type AnalyticsLeaderboardOptions,
  type AnalyticsModel,
  type CreatorRow,
  type CreatorsResponse,
  type EthPriceResponse,
  type LiveWindow,
  type SearchGroup,
} from "@pools/core";
import initial from "../../../../data/snapshots/chain.json";
import captured from "../../../../data/pools/index.json";
import catalog from "../../../../data/catalog/chain.json";
import { productRequest } from "./product-request";
import type { Delivered } from "./use-product";

function preloadModel() {
  const snapshots = [
    initial as ChainSnapshot,
    ...(Object.values(captured.snapshots) as ChainSnapshot[]),
  ];
  const publications: AnalyticsPublication[] = snapshots.flatMap((s) =>
    s.markets.map((m) => ({
      snapshot: {
        ...s,
        markets: [m],
        trades: s.trades.filter((t) => t.poolId === m.id),
      },
      holders: null,
      liquidityWei: null,
      sourceKind: "preloaded" as const,
      generatedAt: s.generatedAt,
    })),
  );
  const pools = [
    ...new Map(
      [...catalog.pools, ...snapshots.flatMap((s) => s.markets)].map((p) => [
        p.id,
        p,
      ]),
    ).values(),
  ] as CatalogPool[];
  return buildAnalyticsModel(pools, publications);
}
/**
 * The preloaded catalog has no per-creator SQL rank, so this mirrors the read
 * API's own grouping rule (see apps/api/README.md "Creators aggregate") over
 * every catalog pool's explore stats. `boughtOwnLaunch` needs sender-routed
 * swap evidence the preload does not carry, so it stays null here.
 */
function creatorsPreload(
  model: AnalyticsModel,
  window: LiveWindow,
  params: URLSearchParams,
): CreatorsResponse {
  const sort = (params.get("sort") ?? "launches") as CreatorsResponse["sort"];
  const limit = Number(params.get("limit") ?? 25);
  const offset = Number(params.get("offset") ?? 0);
  const all = exploreAnalytics(model, {
    window,
    sort: "launch",
    limit: Math.max(model.catalog.length, 1),
    offset: 0,
  });
  const bySender = new Map<string, (typeof all.items)[number][]>();
  for (const pool of all.items) {
    const sender = pool.launchSender.toLowerCase();
    const list = bySender.get(sender);
    if (list) list.push(pool);
    else bySender.set(sender, [pool]);
  }
  const rows: CreatorRow[] = [...bySender].map(([address, pools]) => {
    const measured = pools.filter((p) => p.stats.volumeWei !== null);
    const volumes = measured
      .map((p) => BigInt(p.stats.volumeWei!))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const mid = Math.floor(volumes.length / 2);
    const best = [...measured].sort((a, b) =>
      BigInt(b.stats.volumeWei!) > BigInt(a.stats.volumeWei!) ? 1 : -1,
    )[0];
    return {
      address,
      launches: pools.length,
      measured: measured.length,
      traded: measured.filter((p) => (p.stats.trades ?? 0) > 0).length,
      volumeWei: volumes.length
        ? volumes.reduce((a, b) => a + b, 0n).toString()
        : null,
      medianVolumeWei: volumes.length
        ? (volumes.length % 2
            ? volumes[mid]
            : (volumes[mid - 1] + volumes[mid]) / 2n
          ).toString()
        : null,
      bestLaunch: best
        ? {
            id: best.id,
            token: best.token,
            name: best.name,
            symbol: best.symbol,
            launchTx: best.launchTx,
            launchSender: best.launchSender,
            launchBlock: best.launchBlock,
            launchedAt: best.launchedAt,
            imageUrl: best.imageUrl,
            description: best.description,
            externalUrl: best.externalUrl,
            volumeWei: best.stats.volumeWei!,
          }
        : null,
      boughtOwnLaunch: null,
    };
  });
  const scoped =
    sort === "launches" ? rows : rows.filter((r) => r.measured > 0);
  const metricKey = sort === "median" ? "medianVolumeWei" : "volumeWei";
  scoped.sort((a, b) => {
    if (sort === "launches") {
      if (a.launches !== b.launches) return b.launches - a.launches;
      const av = a.volumeWei,
        bv = b.volumeWei;
      if (av !== bv)
        return av === null
          ? 1
          : bv === null
            ? -1
            : BigInt(bv) > BigInt(av)
              ? 1
              : -1;
      return a.address.localeCompare(b.address);
    }
    const av = BigInt(a[metricKey]!),
      bv = BigInt(b[metricKey]!);
    return av === bv ? a.address.localeCompare(b.address) : bv > av ? 1 : -1;
  });
  return {
    coverage: all.coverage,
    broadMarketCutoff: all.broadMarketCutoff ?? null,
    window,
    sort,
    direction: "desc",
    attribution: "launch_transaction_initiator",
    measuredFigures: [
      "measured",
      "traded",
      "volumeWei",
      "medianVolumeWei",
      "bestLaunch",
      "boughtOwnLaunch",
    ],
    note: "launches counts every discovered launch by the sender; measured, traded, volumeWei, medianVolumeWei, bestLaunch and boughtOwnLaunch come from measured launches only. An unmeasured launch counts in launches and nowhere else.",
    items: scoped.slice(offset, offset + limit),
    total: scoped.length,
    nextOffset: offset + limit < scoped.length ? offset + limit : null,
  };
}
let model: ReturnType<typeof preloadModel> | undefined;
export function preloadedProduct(
  endpoint: string,
  params: URLSearchParams,
): unknown {
  model ??= preloadModel();
  const window = (params.get("window") ??
    (endpoint === "leaderboard"
      ? "7d"
      : endpoint === "creators" || endpoint.startsWith("wallets/")
        ? "All"
        : "24h")) as LiveWindow;
  if (endpoint === "explore")
    return exploreAnalytics(model, {
      window,
      sort: (params.get("sort") ?? "launch") as AnalyticsExploreOptions["sort"],
      direction: (params.get("direction") ?? "desc") as "asc" | "desc",
      view: (params.get("view") ?? "all") as AnalyticsExploreOptions["view"],
      ids: params.get("ids")?.split(",").filter(Boolean),
      q: params.get("q") ?? "",
      limit: Number(params.get("limit") ?? 25),
      offset: Number(params.get("offset") ?? 0),
    });
  if (endpoint === "leaderboard")
    return leaderboardAnalytics(model, {
      window,
      minTrades: Number(params.get("minTrades") ?? 10),
      metric: (params.get("metric") ??
        "realized") as AnalyticsLeaderboardOptions["metric"],
      limit: Number(params.get("limit") ?? 25),
      offset: Number(params.get("offset") ?? 0),
    });
  if (endpoint === "creators") return creatorsPreload(model, window, params);
  if (endpoint.startsWith("wallets/"))
    return walletAnalytics(model, endpoint.slice(8), window);
  if (endpoint === "search")
    return searchAnalytics(
      model,
      params.get("q") ?? "",
      (params.get("group") as SearchGroup | undefined) ?? undefined,
    );
  if (endpoint.startsWith("pools/")) {
    const id = endpoint.slice(6);
    const pool = [
      ...catalog.pools,
      ...initial.markets,
      ...Object.values(captured.snapshots).flatMap((s) => s.markets),
    ].find((p) => p.id.toLowerCase() === id);
    if (!pool) return null;
    return {
      poolId: pool.id,
      token: pool.token,
      name: pool.name,
      symbol: pool.symbol,
      launch: {
        transactionHash: pool.launchTx,
        transactionInitiator: pool.launchSender,
        block: pool.launchBlock,
        timestamp: pool.launchedAt,
      },
      analytics: poolAnalytics(model, id, window),
    };
  }
  throw Error("Unsupported saved-data request");
}
/** The configured read API, or null when this deployment has none. */
function indexerOrigin() {
  const base = process.env.INDEXER_API_URL;
  if (!base || process.env.CHAIN_REFRESH_DISABLED === "1") return null;
  const origin = new URL(base);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("Invalid configured indexer origin");
  return origin;
}
/** The read API's own 503 contract for the Coinbase-backed price, carried to
 * the browser unchanged: no cached or fabricated rate stands in for it. */
export class EthPriceUnavailableError extends Error {
  constructor(readonly retryAfter: number) {
    super("ETH/USD price is unavailable.");
  }
}
export async function readEthPrice(
  path: string[],
  params: URLSearchParams,
): Promise<EthPriceResponse> {
  productRequest(path, params);
  let origin: URL | null = null;
  try {
    origin = indexerOrigin();
  } catch {
    /* A misconfigured origin is as unusable as an absent one. */
  }
  if (!origin) throw new EthPriceUnavailableError(60);
  let response: Response;
  try {
    response = await fetch(new URL("/v1/prices/eth-usd", origin), {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new EthPriceUnavailableError(30);
  }
  if (!response.ok) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new EthPriceUnavailableError(
      Number.isSafeInteger(seconds) && seconds > 0
        ? Math.min(seconds, 86400)
        : 30,
    );
  }
  const body = await response.json().catch(() => null);
  try {
    validateEthPriceResponse(body);
  } catch {
    throw new EthPriceUnavailableError(30);
  }
  return body;
}
export async function readProduct<T>(
  path: string[],
  params: URLSearchParams,
): Promise<Delivered<T>> {
  const checked = productRequest(path, params);
  const base = process.env.INDEXER_API_URL;
  if (base && process.env.CHAIN_REFRESH_DISABLED !== "1") {
    try {
      const origin = indexerOrigin()!;
      const url = new URL(`/v1/${checked.endpoint}`, origin);
      url.search = checked.params.toString();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw Error("Saved index unavailable");
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error("Invalid saved data");
      const expectedWindow =
        checked.params.get("window") ??
        (checked.endpoint === "leaderboard" ||
        checked.endpoint.startsWith("wallets/")
          ? "All"
          : "24h");
      if (checked.endpoint.startsWith("pools/")) {
        validatePoolResponse(data, checked.endpoint.slice(6), expectedWindow);
        normalizePoolLaunch(data);
      }
      if (
        (checked.endpoint === "explore" ||
          checked.endpoint === "leaderboard" ||
          checked.endpoint.startsWith("wallets/")) &&
        data.window !== expectedWindow
      )
        throw Error("Mismatched saved-data window");
      if (
        checked.endpoint.startsWith("wallets/") &&
        data.wallet?.address?.toLowerCase() !== checked.endpoint.slice(8)
      )
        throw Error("Mismatched saved wallet");
      if (
        checked.endpoint.startsWith("pools/") &&
        (data.pool?.poolId ?? data.poolId)?.toLowerCase() !==
          checked.endpoint.slice(6)
      )
        throw Error("Mismatched saved pool");
      if (
        (checked.endpoint === "explore" ||
          checked.endpoint === "leaderboard") &&
        (!Array.isArray(data.items) ||
          !Number.isSafeInteger(data.total) ||
          !data.coverage)
      )
        throw Error("Invalid saved listing");
      if (
        checked.endpoint.startsWith("wallets/") &&
        (!Array.isArray(data.positions) ||
          !Array.isArray(data.trades) ||
          !Array.isArray(data.curve) ||
          !Array.isArray(data.launches) ||
          !data.coverage)
      )
        throw Error("Invalid saved profile");
      if (checked.endpoint === "following")
        validateFollowingResponse(data, checked.params);
      if (checked.endpoint === "creators")
        validateCreatorsResponse(data, checked.params);
      if (checked.endpoint.startsWith("trades/"))
        validateTradeShareResponse(data, checked.endpoint, checked.params);
      return {
        ...data,
        delivery: { source: "indexer", notice: null },
      } as Delivered<T>;
    } catch {
      /* Keep the captured public dataset available during an outage. */
    }
  }
  if (checked.endpoint === "following")
    throw Error("Saved following activity is temporarily unavailable.");
  if (checked.endpoint.startsWith("trades/"))
    throw Error("This verified sale is unavailable in the saved index.");
  const data = await preloadedProduct(checked.endpoint, checked.params);
  if (!data) throw Error("Outside available saved coverage");
  return {
    ...(data as T),
    delivery: {
      source: "preloaded",
      notice: base
        ? "The saved index is unavailable. Showing the preloaded public dataset."
        : "Showing the preloaded public dataset. Wider indexed coverage is not connected.",
    },
  };
}
