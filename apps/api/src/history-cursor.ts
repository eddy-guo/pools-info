import { createHmac, timingSafeEqual } from "node:crypto";
import type { WalletHistoryKind } from "@pools/core";
import {
  canonicalPageParams,
  historyKinds,
  upstream,
  type PageParams,
} from "./history-page";

export { historyKinds };
/** A cursor is base64url text of at most 2,048 characters, the same bound
 * the website's response validator holds it to. */
export const historyCursorShape = /^[A-Za-z0-9_-]{1,2048}$/;
export const historyCursorVersion = 2;
/** A cursor names a page of history, which does not change, but it also
 * lets its holder drive a paid read without a fresh first page; a day is as
 * long as the deepest legitimate paging session needs. */
export const historyCursorTtlMs = 86400000;
export const historyCursorSecretMinLength = 32;
const macBytes = 32;

export interface HistoryCursorCodec {
  /** A cursor for `page`, the explorer's own position in canonical form,
   * bound to the wallet, the kind and its filter, expiring after the TTL. */
  encode(input: {
    wallet: string;
    kind: WalletHistoryKind;
    page: PageParams;
  }): string;
  /** The position a cursor names for this wallet and kind, or `Error("cursor")`
   * for anything else: a cursor not signed with this secret (a forged or
   * altered one, or one of the unsigned v1 format), one issued for another
   * wallet, kind or filter, an expired one, or a position outside the kind's
   * schema even under a valid signature. Nothing is read from the explorer
   * for a cursor that fails here. */
  decode(
    raw: string,
    input: { wallet: string; kind: WalletHistoryKind },
  ): PageParams;
}

/** Cursors are HMAC-SHA256 signed with a server secret: what the explorer
 * receives as a page position is always one this api issued, never a
 * caller's own query. The secret never leaves this closure and is never
 * logged. */
export function createHistoryCursorCodec({
  secret,
  now = Date.now,
  ttlMs = historyCursorTtlMs,
}: {
  secret: string | undefined;
  now?: () => number;
  ttlMs?: number;
}): HistoryCursorCodec {
  if (
    typeof secret !== "string" ||
    secret.length < historyCursorSecretMinLength ||
    /\s/.test(secret)
  )
    throw Error(
      `HISTORY_CURSOR_SECRET is required with BLOCKSCOUT_API_KEY: at least ${historyCursorSecretMinLength} characters without whitespace`,
    );
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw Error("Invalid ttl");
  const key = Buffer.from(secret, "utf8");
  const mac = (payload: Uint8Array) =>
    createHmac("sha256", key).update(payload).digest();
  const invalid = () => Error("cursor");
  return {
    encode({ wallet, kind, page }) {
      const canonical = canonicalPageParams(kind, page);
      if (!canonical) throw invalid();
      const payload = Buffer.from(
        JSON.stringify({
          v: historyCursorVersion,
          w: wallet,
          k: kind,
          f: upstream[kind].filter,
          p: canonical,
          e: Math.floor((now() + ttlMs) / 1000),
        }),
      );
      return Buffer.concat([payload, mac(payload)]).toString("base64url");
    },
    decode(raw, { wallet, kind }) {
      if (!historyCursorShape.test(raw)) throw invalid();
      const bytes = Buffer.from(raw, "base64url");
      if (bytes.length <= macBytes) throw invalid();
      const payload = bytes.subarray(0, bytes.length - macBytes);
      if (!timingSafeEqual(mac(payload), bytes.subarray(payload.length)))
        throw invalid();
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload.toString("utf8"));
      } catch {
        throw invalid();
      }
      if (typeof decoded !== "object" || decoded === null) throw invalid();
      const c = decoded as Record<string, unknown>;
      if (
        Object.keys(c).sort().join() !== "e,f,k,p,v,w" ||
        c.v !== historyCursorVersion ||
        c.w !== wallet ||
        c.k !== kind ||
        JSON.stringify(c.f) !== JSON.stringify(upstream[kind].filter) ||
        typeof c.e !== "number" ||
        !Number.isSafeInteger(c.e) ||
        c.e * 1000 <= now()
      )
        throw invalid();
      let page: PageParams | null;
      try {
        page = canonicalPageParams(kind, c.p);
      } catch {
        throw invalid();
      }
      // The signed position must already be canonical: sorted keys, canonical
      // values, exactly the schema's fields.
      if (!page || JSON.stringify(page) !== JSON.stringify(c.p))
        throw invalid();
      return page;
    },
  };
}
