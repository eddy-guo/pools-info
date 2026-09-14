import { createHash } from "node:crypto";

export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
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
  | "trades"
  | "wallet"
  | "feed";
export interface ReadRequest {
  route: Route;
  limit: number;
  q: string;
  poolId: string | null;
  pools: string[];
  wallet: string | null;
  scope: string;
  cursor: string[] | null;
  cacheKey: string;
}

export function encodeCursor(scope: string, position: string[]): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, position })).toString(
    "base64url",
  );
}

export function parseRequest(input: string): ReadRequest {
  if (input.length > 2048) throw new RequestError(414, "url_too_long");
  const url = new URL(input, "http://localhost");
  let route: Route;
  let poolId: string | null = null;
  let wallet: string | null = null;
  const pool = /^\/v1\/pools\/(0x[\da-f]{64})$/i.exec(url.pathname);
  const activity = /^\/v1\/wallets\/(0x[\da-f]{40})\/activity$/i.exec(
    url.pathname,
  );
  if (url.pathname === "/health") route = "health";
  else if (url.pathname === "/ready") route = "ready";
  else if (url.pathname === "/v1/status") route = "status";
  else if (url.pathname === "/v1/pools") route = "pools";
  else if (url.pathname === "/v1/trades") route = "trades";
  else if (url.pathname === "/v1/feed") route = "feed";
  else if (pool) {
    route = "pool";
    poolId = pool[1].toLowerCase();
  } else if (activity) {
    route = "wallet";
    wallet = activity[1].toLowerCase();
  } else throw new RequestError(404, "not_found");
  const allowed =
    route === "pools"
      ? ["q", "limit", "cursor"]
      : route === "trades"
        ? ["poolId", "limit", "cursor"]
        : route === "wallet"
          ? ["limit", "cursor"]
          : route === "feed"
            ? ["pools"]
            : [];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new RequestError(400, "invalid_parameter");
  }
  const rawLimit = url.searchParams.get("limit") ?? "25";
  if (!/^\d{1,3}$/.test(rawLimit) || +rawLimit < 1 || +rawLimit > 100)
    throw new RequestError(400, "invalid_limit");
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length > 100 || /[\x00-\x1f\x7f]/.test(q))
    throw new RequestError(400, "invalid_search");
  if (route === "trades" && url.searchParams.has("poolId")) {
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
    .update(JSON.stringify([route, poolId, wallet, q, pools]))
    .digest("hex")
    .slice(0, 24);
  let cursor: string[] | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null) {
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
    pools,
    wallet,
    scope,
    cursor,
    cacheKey: JSON.stringify([scope, +rawLimit, cursor]),
  };
}

/** Escape LIKE wildcards: text search is literal, not a SQL pattern language. */
export function searchPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}
export const isAddress = (s: string) => address.test(s);
