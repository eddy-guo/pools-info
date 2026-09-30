import { isIP } from "node:net";
import {
  createTokenBuckets,
  ipv6ClientKey,
  type TokenBuckets,
} from "@pools/core";

/**
 * The product proxy's own admission line, in front of every upstream read:
 * a visitor who outruns it is answered here and spends none of the read
 * API's allowance. One bucket per visitor, sized so ordinary browsing (the
 * screener, a few pool pages and a wallet page inside a minute) stays well
 * under it; the read API's per-client budget behind it is the authority on
 * what a visitor may spend there (apps/api/README.md, "Request limits and
 * client identity").
 */
export const admissionPolicy = Object.freeze({
  /** Product reads a visitor may start per minute: burst and refill. */
  requestsPerMinute: 120,
  /** Visitors tracked at once per server instance; the least recent goes first. */
  maxVisitors: 10_000,
});
/**
 * The visitor as the platform in front of this server reports it: the last
 * `x-forwarded-for` entry, which Vercel overwrites with the connecting
 * client's public address and `next start` fills from the socket. It is
 * only as trustworthy as that platform, which is why it reaches the read
 * API solely under the shared-secret contract below.
 */
export function visitorAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return null;
  let value = forwarded.split(",").at(-1)!.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];
  return isIP(value) ? value : null;
}
export type Admission = { ok: true } | { ok: false; retryAfterSeconds: number };
export function createAdmission(
  policy: { requestsPerMinute: number; maxVisitors: number } = admissionPolicy,
  now: () => number = Date.now,
  env: Record<string, string | undefined> = process.env,
) {
  const buckets: TokenBuckets = createTokenBuckets(
    {
      capacity: policy.requestsPerMinute,
      refillPerSecond: policy.requestsPerMinute / 60,
      maxKeys: policy.maxVisitors,
    },
    now,
  );
  return {
    /** A visitor the platform did not name draws on the read API's shared
     * ceilings alone, as every unattributed request does there. */
    admit(visitor: string | null): Admission {
      if (!env.INDEXER_PROXY_SECRET || visitor === null) return { ok: true };
      const key = isIP(visitor) === 6 ? ipv6ClientKey(visitor) : visitor;
      const answer = buckets.take(key, 1);
      return answer.ok
        ? { ok: true }
        : { ok: false, retryAfterSeconds: answer.retryAfterSeconds };
    },
  };
}
/** The one line every product route shares in this server process. */
export const admission = createAdmission();
/**
 * Headers that name the visitor to the read API under its trusted-proxy
 * contract: sent only when this deployment holds the shared secret the api
 * was configured with (`INDEXER_PROXY_SECRET`, the api's
 * `TRUSTED_PROXY_SECRET`), so the api charges that visitor's own budget
 * rather than this server's address. A read with no visitor behind it
 * still presents the secret, so the api leaves it
 * unattributed and it draws on the shared ceilings alone, never on the
 * budget of this server's egress address. Without the secret nothing is
 * sent and the api's own contract decides.
 */
export function upstreamIdentity(
  visitor: string | null,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const secret = env.INDEXER_PROXY_SECRET;
  if (!secret) return {};
  return {
    "X-Pools-Proxy-Secret": secret,
    ...(visitor === null ? {} : { "X-Pools-Client-Address": visitor }),
  };
}
