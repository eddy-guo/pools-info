import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import type { Route } from "./request";

/**
 * Ingress fairness for the read API: what a request costs a client, who the
 * client is, and the bounds every deployment shares. The token buckets
 * themselves are `createTokenBuckets` in `@pools/core`.
 *
 * A client is identified only through an explicit contract, never through a
 * header any caller could set on direct traffic:
 * - the website's proxy presents `TRUSTED_PROXY_SECRET` in
 *   `X-Pools-Proxy-Secret` beside the visitor's address in
 *   `X-Pools-Client-Address`, and that visitor is the client;
 * - a peer inside `TRUSTED_PROXY_ADDRESSES` (the platform's edge proxy) is a
 *   proxy whose last `X-Forwarded-For` entry, the one it appended itself, is
 *   the client, while every other peer is the client and its forwarded
 *   headers are ignored;
 * - `CLIENT_IDENTITY=peer` names the connection's own address the client, for
 *   an api reached with no proxy in front.
 * Without any of these the api cannot tell its callers apart and applies its
 * shared ceilings alone, exactly as before per-client budgets existed: a
 * deployment behind a proxy it has not been told to trust keeps its capacity
 * rather than folding every visitor into one budget.
 */
export const ingressPolicy = Object.freeze({
  sharedJsonPerMinute: 240,
  /** Tokens added to a client's bucket per minute. */
  clientTokensPerMinute: 60,
  /** Tokens available to a client at once. */
  clientTokenBurst: 120,
  /** Distinct clients tracked at once; the least recently seen goes first. */
  maxClients: 10_000,
  /** `/ready` answers per minute, independent of every visitor budget. */
  probesPerMinute: 60,
  /** What a request costs its client, by the work it starts: a fresh cache
   * hit or a coalesced in-flight read; a bounded database read; a
   * catalog-wide ranking, search or whole-wallet read; a paid explorer page. */
  cost: Object.freeze({ cached: 1, light: 2, heavy: 4, paid: 8 }),
});
export type CostClass = keyof typeof ingressPolicy.cost;

/** The class a route's own work falls in; `cached` is otherwise decided per
 * request. The ETH price is always an in-process read: its service holds one
 * entry and refreshes it at most once a minute whoever asks. */
export function routeCostClass(route: Route): CostClass {
  switch (route) {
    case "eth-price":
      return "cached";
    case "history":
    case "following":
      return "paid";
    case "explore":
    case "creators":
    case "search":
    case "profile":
      return "heavy";
    default:
      return "light";
  }
}

export interface IdentitySettings {
  /** Peers whose last forwarded address is the client. */
  trustedProxies: BlockList | null;
  /** The bare connection address is the client. */
  peer: boolean;
  /** The website proxy's shared secret, or null when it names no visitor. */
  proxySecret: string | null;
}
export interface IngressSettings {
  clientTokensPerMinute: number;
  clientTokenBurst: number;
  maxClients: number;
  probesPerMinute: number;
  identity: IdentitySettings;
}
export function ingressSettings(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): IngressSettings {
  const read = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(value >= min))
      throw Error(`${name} must be an integer of at least ${min}`);
    return value;
  };
  const identityMode = env.CLIENT_IDENTITY ?? "";
  if (identityMode !== "" && identityMode !== "peer")
    throw Error("CLIENT_IDENTITY must be peer or unset");
  const secret = env.TRUSTED_PROXY_SECRET ?? "";
  if (secret !== "" && secret.length < 16)
    throw Error("TRUSTED_PROXY_SECRET must be at least 16 characters");
  const requestedRefill = read(
    "CLIENT_TOKENS_PER_MINUTE",
    ingressPolicy.clientTokensPerMinute,
    10,
  );
  const requestedBurst = read(
    "CLIENT_TOKEN_BURST",
    ingressPolicy.clientTokenBurst,
    10,
  );
  const clientTokensPerMinute = Math.min(
    requestedRefill,
    requestedBurst,
    Math.floor((ingressPolicy.sharedJsonPerMinute - 1) / 2),
  );
  const clientTokenBurst = Math.min(
    requestedBurst,
    ingressPolicy.sharedJsonPerMinute - 1 - clientTokensPerMinute,
  );
  const clamped = [
    ...(clientTokensPerMinute !== requestedRefill
      ? ["CLIENT_TOKENS_PER_MINUTE"]
      : []),
    ...(clientTokenBurst !== requestedBurst ? ["CLIENT_TOKEN_BURST"] : []),
  ];
  if (clamped.length)
    warn(
      `Clamped ${clamped.join(", ")} below the ${ingressPolicy.sharedJsonPerMinute}-request shared JSON ceiling`,
    );
  return {
    clientTokensPerMinute,
    clientTokenBurst,
    maxClients: ingressPolicy.maxClients,
    probesPerMinute: ingressPolicy.probesPerMinute,
    identity: {
      trustedProxies: trustedProxyList(env.TRUSTED_PROXY_ADDRESSES ?? ""),
      peer: identityMode === "peer",
      proxySecret: secret === "" ? null : secret,
    },
  };
}
/** Names, for the startup line, which identity sources are configured. */
export function identitySources(identity: IdentitySettings): string[] {
  return [
    ...(identity.proxySecret !== null ? ["proxy_secret"] : []),
    ...(identity.trustedProxies !== null ? ["trusted_proxies"] : []),
    ...(identity.peer ? ["peer"] : []),
  ];
}
/** Comma-separated addresses or CIDR blocks; empty means no trusted proxy. */
export function trustedProxyList(raw: string): BlockList | null {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entries.length) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split("/");
    const normalized = normalizeAddress(address);
    const family = normalized === null ? 0 : isIP(normalized);
    const type = family === 4 ? "ipv4" : family === 6 ? "ipv6" : null;
    if (type === null || rest.length)
      throw Error(`TRUSTED_PROXY_ADDRESSES entry is not an address: ${entry}`);
    if (prefix === undefined) list.addAddress(normalized!, type);
    else {
      const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
      if (!(bits >= 0 && bits <= (type === "ipv4" ? 32 : 128)))
        throw Error(`TRUSTED_PROXY_ADDRESSES prefix is invalid: ${entry}`);
      list.addSubnet(normalized!, bits, type);
    }
  }
  return list;
}

/** A bare address as a socket or a forwarding proxy writes it, or null: an
 * IPv4-mapped IPv6 form becomes the IPv4 address; brackets, a zone id and a
 * port on an IPv4 entry are dropped. */
export function normalizeAddress(
  raw: string | undefined | null,
): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (value.startsWith("[") && value.includes("]"))
    value = value.slice(1, value.indexOf("]"));
  value = value.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];
  if (isIP(value)) return value;
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  return withPort && isIP(withPort[1]) === 4 ? withPort[1] : null;
}
/** The key a client's budget lives under: an IPv4 address, or an IPv6
 * address's /64, since one machine commonly holds a whole /64. */
export function clientKey(address: string): string {
  if (isIP(address) !== 6) return address;
  return `${expandIPv6(address).slice(0, 4).join(":")}::/64`;
}
function expandIPv6(address: string): string[] {
  let text = address;
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text =
      text.slice(0, -tail[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  return [
    ...left,
    ...Array(rest === undefined ? 0 : missing).fill("0"),
    ...right,
  ].map((group) => group.replace(/^0+(?=.)/, "") || "0");
}
function forwardedEntries(headers: IncomingHttpHeaders): string[] {
  const raw = headers["x-forwarded-for"];
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function single(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  return typeof raw === "string" ? raw : null;
}
function secretMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, "utf8"),
    b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
export const proxySecretHeader = "x-pools-proxy-secret";
export const proxyClientHeader = "x-pools-client-address";
/**
 * The budget key this request is charged to, or null when the contract above
 * cannot name a client: a null request draws on the shared ceilings only.
 */
export function clientIdentity(
  request: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } },
  identity: IdentitySettings,
): string | null {
  const peer = normalizeAddress(request.socket.remoteAddress);
  if (identity.proxySecret !== null) {
    const presented = single(request.headers, proxySecretHeader);
    if (presented !== null && secretMatches(presented, identity.proxySecret)) {
      const named = normalizeAddress(
        single(request.headers, proxyClientHeader),
      );
      return named === null ? null : clientKey(named);
    }
  }
  if (identity.trustedProxies !== null && peer !== null) {
    if (
      identity.trustedProxies.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4")
    ) {
      const named = normalizeAddress(forwardedEntries(request.headers).at(-1));
      return named === null ? null : clientKey(named);
    }
    return clientKey(peer);
  }
  if (identity.peer && peer !== null) return clientKey(peer);
  return null;
}
