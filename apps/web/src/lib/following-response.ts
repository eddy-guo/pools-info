import {
  parseFollowingWallets,
  type FollowingTrade,
  type FollowingTradesResponse,
  type FollowingWalletCoverage,
} from "@pools/core";

/*
 * `GET /v1/following`: each followed wallet's newest explorer trades in
 * verified-registry tokens (the wallet page's Trades tab source, merged across
 * the follow list). A 503 `wallet_history_unavailable` never reaches this
 * check: the proxy answers it as the panel's unavailable state, like any
 * other outage.
 */

const hash = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
const nullableText = (v: unknown, max: number) =>
  v === null || (typeof v === "string" && v.length <= max);
const rawAmount = (v: unknown) =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const isoTime = (v: unknown) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));
const statuses = new Set(["read", "stale", "pending", "unavailable"]);
const reasons = new Set([
  "not_configured",
  "budget_exhausted",
  "upstream_unavailable",
  "key_rejected",
]);

function validCoverage(value: unknown, wallet: string) {
  const c = value as FollowingWalletCoverage | null;
  if (!c || typeof c !== "object" || c.wallet !== wallet) return false;
  const read = c.status === "read" || c.status === "stale";
  return (
    statuses.has(c.status) &&
    (read ? isoTime(c.fetchedAt) : c.fetchedAt === null) &&
    (c.reason === null || reasons.has(c.reason)) &&
    typeof c.olderTrades === "boolean" &&
    (c.horizonBlock === null || integer(c.horizonBlock))
  );
}

function validTrade(value: unknown, read: ReadonlySet<string>) {
  const t = value as FollowingTrade | null;
  return !!(
    t &&
    typeof t === "object" &&
    read.has(t.wallet) &&
    (t.poolId === null ||
      (typeof t.poolId === "string" && hash.test(t.poolId))) &&
    typeof t.token === "string" &&
    address.test(t.token) &&
    nullableText(t.symbol, 256) &&
    nullableText(t.name, 256) &&
    (t.decimals === null || (integer(t.decimals) && t.decimals <= 255)) &&
    typeof t.txHash === "string" &&
    hash.test(t.txHash) &&
    integer(t.logIndex) &&
    integer(t.block) &&
    (t.timestamp === null || integer(t.timestamp)) &&
    (t.side === "buy" || t.side === "sell") &&
    rawAmount(t.tokenRaw) &&
    nullableText(t.method, 256) &&
    t.id === `${t.txHash}:${t.logIndex}`
  );
}

/** A stale or misrouted response must never show another follow list's
 * trades, and a wallet the answer says it has not read can have none. */
export function validateFollowingResponse(
  value: unknown,
  params: URLSearchParams,
): asserts value is FollowingTradesResponse {
  const data = value as FollowingTradesResponse | null;
  const wallets = parseFollowingWallets(params.get("wallets"));
  if (
    !data ||
    data.source !== "blockscout" ||
    data.scope !== "explorer_registry_trades" ||
    !Array.isArray(data.items) ||
    data.items.length > Number(params.get("limit") ?? 50) ||
    typeof data.hasMore !== "boolean" ||
    typeof data.notice !== "string" ||
    typeof data.note !== "string" ||
    !data.coverage ||
    data.coverage.complete !== false ||
    data.coverage.registryExhaustive !== false ||
    data.coverage.requestedWallets !== wallets.length ||
    !integer(data.coverage.returnedTokens) ||
    !isoTime(data.coverage.generatedAt) ||
    !Array.isArray(data.coverage.wallets) ||
    data.coverage.wallets.length !== wallets.length ||
    wallets.some((w, i) => !validCoverage(data.coverage.wallets[i], w))
  )
    throw Error("Invalid following activity");
  const read = new Set(
    data.coverage.wallets
      .filter((c) => c.status === "read" || c.status === "stale")
      .map((c) => c.wallet),
  );
  const ids = new Set<string>();
  for (const row of data.items) {
    if (!validTrade(row, read) || ids.has(row.id))
      throw Error("Invalid following trade");
    ids.add(row.id);
  }
}
