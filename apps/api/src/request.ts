import { createHash } from "node:crypto";
import { parseFollowingWallets } from "@pools/core";
import type {
  AnalyticsExploreOptions,
  AnalyticsLeaderboardOptions,
  LiveWindow,
  SearchGroup,
  WalletHistoryKind,
} from "@pools/core";
import { decodeHistoryCursor, historyKinds } from "./history-cursor";

export class RequestError extends Error {
  public reason?: string;
  public retryAfter?: number;
  constructor(
    public status: number,
    public code: string,
    details: { reason?: string; retryAfter?: number } = {},
  ) {
    super(code);
    this.reason = details.reason;
    this.retryAfter = details.retryAfter;
  }
}
const address = /^0x[\da-f]{40}$/i;
const hash = /^0x[\da-f]{64}$/i;
const integer = /^(0|[1-9]\d{0,18})$/;
export type Route =
  | "health"
  | "ready"
  | "status"
  | "pools"
  | "pool"
  | "pool-image"
  | "trades"
  | "trade-share"
  | "wallet"
  | "explore"
  | "leaderboard"
  | "profile"
  | "search"
  | "feed"
  | "following"
  | "live-trades"
  | "history";
export interface ReadRequest {
  route: Route;
  limit: number;
  q: string;
  poolId: string | null;
  txHash: string | null;
  logIndex: number | null;
  pools: string[];
  wallet: string | null;
  wallets: string[];
  scope: string;
  cursor: string[] | null;
  /** Explorer history only: the kind and the decoded upstream page cursor. */
  kind: WalletHistoryKind;
  page: Record<string, string> | null;
  cacheKey: string;
  explore: AnalyticsExploreOptions;
  leaderboard: AnalyticsLeaderboardOptions;
  window: LiveWindow;
  group?: SearchGroup;
}

export function encodeCursor(scope: string, position: string[]): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, position })).toString(
    "base64url",
  );
}

export function parseRequest(input: string): ReadRequest {
  if (input.length > 20000) throw new RequestError(414, "url_too_long");
  const url = new URL(input, "http://localhost");
  let route: Route;
  let poolId: string | null = null;
  let wallet: string | null = null;
  let txHash: string | null = null;
  let logIndex: number | null = null;
  const sale =
    /^\/v1\/trades\/(0x[\da-f]{64})\/(0x[\da-f]{64})\/(0|[1-9]\d{0,9})$/i.exec(
      url.pathname,
    );
  const pool = /^\/v1\/pools\/(0x[\da-f]{64})$/i.exec(url.pathname);
  const poolImage = /^\/v1\/pools\/(0x[\da-f]{64})\/image$/i.exec(url.pathname);
  const activity = /^\/v1\/wallets\/(0x[\da-f]{40})\/activity$/i.exec(
    url.pathname,
  );
  const history = /^\/v1\/wallets\/(0x[\da-f]{40})\/history$/i.exec(
    url.pathname,
  );
  const profile = /^\/v1\/wallets?\/(0x[\da-f]{40})$/i.exec(url.pathname);
  if (url.pathname === "/health") route = "health";
  else if (url.pathname === "/ready") route = "ready";
  else if (url.pathname === "/v1/status") route = "status";
  else if (url.pathname === "/v1/pools") route = "pools";
  else if (url.pathname === "/v1/trades") route = "trades";
  else if (url.pathname === "/v1/live-trades") route = "live-trades";
  else if (url.pathname === "/v1/feed") route = "feed";
  else if (url.pathname === "/v1/following") route = "following";
  else if (url.pathname === "/v1/explore") route = "explore";
  else if (url.pathname === "/v1/leaderboard") route = "leaderboard";
  else if (url.pathname === "/v1/search") route = "search";
  else if (sale) {
    route = "trade-share";
    poolId = sale[1].toLowerCase();
    txHash = sale[2].toLowerCase();
    logIndex = Number(sale[3]);
    wallet = url.searchParams.get("wallet")?.toLowerCase() ?? null;
    if (logIndex > 2147483647 || !wallet || !address.test(wallet))
      throw new RequestError(400, "invalid_trade_identity");
  } else if (profile) {
    route = "profile";
    wallet = profile[1].toLowerCase();
  } else if (pool) {
    route = "pool";
    poolId = pool[1].toLowerCase();
  } else if (poolImage) {
    route = "pool-image";
    poolId = poolImage[1].toLowerCase();
  } else if (activity) {
    route = "wallet";
    wallet = activity[1].toLowerCase();
  } else if (history) {
    route = "history";
    wallet = history[1].toLowerCase();
  } else throw new RequestError(404, "not_found");
  const allowed =
    route === "trade-share"
      ? ["wallet"]
      : route === "following"
        ? ["wallets", "limit"]
        : route === "explore"
          ? [
              "q",
              "window",
              "sort",
              "direction",
              "view",
              "ids",
              "limit",
              "offset",
            ]
          : route === "leaderboard"
            ? ["window", "minTrades", "metric", "offset", "limit"]
            : route === "profile" || route === "pool"
              ? ["window"]
              : route === "search"
                ? ["q", "group"]
                : route === "pools"
                  ? ["q", "limit", "cursor"]
                  : route === "live-trades"
                    ? ["poolId"]
                    : route === "trades"
                      ? ["poolId", "limit", "cursor"]
                      : route === "wallet"
                        ? ["limit", "cursor"]
                        : route === "history"
                          ? ["kind", "cursor"]
                          : route === "feed"
                            ? ["pools"]
                            : [];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new RequestError(400, "invalid_parameter");
  }
  const rawLimit =
    url.searchParams.get("limit") ?? (route === "following" ? "50" : "25");
  if (
    !/^\d{1,3}$/.test(rawLimit) ||
    +rawLimit < 1 ||
    +rawLimit > (route === "following" ? 50 : 100)
  )
    throw new RequestError(400, "invalid_limit");
  let wallets: string[] = [];
  if (route === "following") {
    try {
      wallets = parseFollowingWallets(url.searchParams.get("wallets"));
    } catch {
      throw new RequestError(400, "invalid_wallets");
    }
  }
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length > 100 || /[\x00-\x1f\x7f]/.test(q))
    throw new RequestError(400, "invalid_search");
  function choice<T extends string>(
    key: string,
    choices: readonly T[],
    fallback: T,
  ): T {
    const value = url.searchParams.get(key) ?? fallback;
    if (!choices.includes(value as T))
      throw new RequestError(400, `invalid_${key}`);
    return value as T;
  }
  const window = choice(
    "window",
    ["1h", "6h", "24h", "7d", "30d", "All"] as const,
    route === "leaderboard" ? "7d" : route === "profile" ? "All" : "24h",
  );
  const offsetRaw = url.searchParams.get("offset") ?? "0",
    minRaw = url.searchParams.get("minTrades") ?? "10";
  if (!/^(0|[1-9]\d{0,5})$/.test(offsetRaw))
    throw new RequestError(400, "invalid_offset");
  if (!/^(0|[1-9]\d{0,2})$/.test(minRaw))
    throw new RequestError(400, "invalid_min_trades");
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (ids.length > 200 || ids.some((s) => !hash.test(s)))
    throw new RequestError(400, "invalid_ids");
  const explore: AnalyticsExploreOptions = {
    window,
    q,
    limit: +rawLimit,
    offset: +offsetRaw,
    ids,
    sort: choice(
      "sort",
      ["volume", "trades", "change", "launch", "liquidity"] as const,
      "launch",
    ),
    direction: choice("direction", ["asc", "desc"] as const, "desc"),
    view: choice(
      "view",
      ["all", "gainers", "new", "crowd", "watchlist"] as const,
      "all",
    ),
  };
  const leaderboard: AnalyticsLeaderboardOptions = {
    window,
    limit: +rawLimit,
    offset: +offsetRaw,
    minTrades: +minRaw,
    metric: choice("metric", ["realized", "net"] as const, "realized"),
  };
  const kind = choice("kind", historyKinds, "transactions");
  const group = url.searchParams.has("group")
    ? choice(
        "group",
        ["Tokens", "Wallets", "Creators", "Transactions"] as const,
        "Tokens",
      )
    : undefined;
  if (
    (route === "trades" || route === "live-trades") &&
    url.searchParams.has("poolId")
  ) {
    poolId = url.searchParams.get("poolId")!.toLowerCase();
    if (!hash.test(poolId)) throw new RequestError(400, "invalid_pool_id");
  }
  const pools =
    route === "feed"
      ? (url.searchParams.get("pools") ?? "").toLowerCase().split(",").sort()
      : [];
  if (
    route === "feed" &&
    (!pools.length ||
      pools.length > 8 ||
      new Set(pools).size !== pools.length ||
      pools.some((p) => !hash.test(p)))
  )
    throw new RequestError(400, "invalid_pools");
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        route,
        poolId,
        txHash,
        logIndex,
        wallet,
        wallets,
        q,
        pools,
        explore,
        leaderboard,
        group,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  let cursor: string[] | null = null;
  let page: Record<string, string> | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && route === "history") {
    try {
      page = decodeHistoryCursor(rawCursor, scope, kind);
    } catch {
      throw new RequestError(400, "invalid_cursor");
    }
  } else if (rawCursor !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(rawCursor)) throw Error();
      const decoded = JSON.parse(
        Buffer.from(rawCursor, "base64url").toString(),
      );
      const p: unknown = decoded.position;
      if (
        decoded.v !== 1 ||
        decoded.scope !== scope ||
        !Array.isArray(p) ||
        !p.every((x) => typeof x === "string")
      )
        throw Error();
      if (route === "pools") {
        if (p.length !== 2 || !integer.test(p[0]) || !hash.test(p[1]))
          throw Error();
      } else {
        if (
          p.length !== 4 ||
          !integer.test(p[0]) ||
          !/^\d{1,10}$/.test(p[1]) ||
          Number(p[1]) > 2147483647 ||
          !hash.test(p[2]) ||
          !/^pool:0x[\da-f]{64}$/i.test(p[3])
        )
          throw Error();
      }
      if (BigInt(p[0]) > 9223372036854775807n) throw Error();
      cursor = p;
    } catch {
      throw new RequestError(400, "invalid_cursor");
    }
  }
  return {
    route,
    limit: +rawLimit,
    q,
    poolId,
    txHash,
    logIndex,
    pools,
    wallet,
    wallets,
    scope,
    cursor,
    kind,
    page,
    cacheKey: JSON.stringify([scope, +rawLimit, cursor, page]),
    explore,
    leaderboard,
    window,
    group,
  };
}

/** Escape LIKE wildcards: text search is literal, not a SQL pattern language. */
export function searchPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}
export const isAddress = (s: string) => address.test(s);
