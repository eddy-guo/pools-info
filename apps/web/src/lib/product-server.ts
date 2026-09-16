import { validateFollowingResponse } from "./following-response";
import { normalizePoolLaunch, validatePoolResponse } from "./pool-response";
import { validateTradeShareResponse } from "./trade-share-response";
import { validateWalletHistoryResponse } from "./wallet-history-response";
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
  type LiveWindow,
  type SearchGroup,
  type WalletHistoryKind,
  type WalletHistoryResponse,
  type WalletHistoryUnavailable,
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
let model: ReturnType<typeof preloadModel> | undefined;
export function preloadedProduct(
  endpoint: string,
  params: URLSearchParams,
): unknown {
  model ??= preloadModel();
  const window = (params.get("window") ??
    (endpoint === "leaderboard"
      ? "7d"
      : endpoint.startsWith("wallets/")
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
/** The read API's own 503 contract, carried to the browser unchanged. */
export class WalletHistoryUnavailableError extends Error {
  constructor(
    readonly reason: WalletHistoryUnavailable["reason"],
    readonly retryAfter: number,
  ) {
    super("Explorer history is unavailable.");
  }
}
const historyReasons = [
  "not_configured",
  "budget_exhausted",
  "upstream_unavailable",
  "key_rejected",
];
function historyFailure(response: Response, body: unknown) {
  const reported = body as WalletHistoryUnavailable | null;
  const seconds = Number(response.headers.get("retry-after"));
  return new WalletHistoryUnavailableError(
    response.status === 503 &&
      reported?.error === "wallet_history_unavailable" &&
      historyReasons.includes(reported.reason)
      ? reported.reason
      : "upstream_unavailable",
    Number.isSafeInteger(seconds) && seconds > 0
      ? Math.min(seconds, 86400)
      : 30,
  );
}
/**
 * On-demand explorer history: display data with no saved counterpart, so an
 * outage stays an outage instead of falling back to the preloaded dataset.
 */
export async function readWalletHistory(
  path: string[],
  params: URLSearchParams,
): Promise<WalletHistoryResponse> {
  const checked = productRequest(path, params);
  const wallet = checked.endpoint.split("/")[1];
  const kind = checked.params.get("kind") as WalletHistoryKind;
  let origin: URL | null = null;
  try {
    origin = indexerOrigin();
  } catch {
    /* A misconfigured origin is as unusable as an absent one. */
  }
  if (!origin) throw new WalletHistoryUnavailableError("not_configured", 3600);
  let response: Response;
  try {
    const url = new URL(`/v1/${checked.endpoint}`, origin);
    url.search = checked.params.toString();
    response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new WalletHistoryUnavailableError("upstream_unavailable", 30);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw historyFailure(response, body);
  try {
    validateWalletHistoryResponse(body, wallet, kind);
  } catch {
    throw new WalletHistoryUnavailableError("upstream_unavailable", 30);
  }
  return body;
}
export async function readProduct<T>(
  path: string[],
  params: URLSearchParams,
): Promise<Delivered<T>> {
  const checked = productRequest(path, params);
  const base = process.env.INDEXER_API_URL;
  if (checked.endpoint.endsWith("/history"))
    throw Error("Explorer history has no saved publication.");
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
