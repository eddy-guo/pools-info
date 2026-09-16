import type { WalletHistoryKind } from "@pools/core";
import { pageParams, type PageParams } from "./blockscout-client";

export const historyKinds = ["transactions", "token-transfers"] as const;

/** Cursors bind to the request scope and kind like every other route; the
 * page parameters inside are the explorer's own, validated on the way back. */
export function encodeHistoryCursor(
  scope: string,
  kind: WalletHistoryKind,
  page: PageParams,
): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, kind, page })).toString(
    "base64url",
  );
}
export function decodeHistoryCursor(
  raw: string,
  scope: string,
  kind: WalletHistoryKind,
): PageParams {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(raw)) throw Error("cursor");
  const decoded = JSON.parse(Buffer.from(raw, "base64url").toString());
  if (decoded.v !== 1 || decoded.scope !== scope || decoded.kind !== kind)
    throw Error("cursor");
  const page = pageParams(decoded.page);
  if (!page || !Object.keys(page).length) throw Error("cursor");
  return page;
}
