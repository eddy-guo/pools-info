import type { WalletHistoryResponse, WalletHistoryTrade } from "@pools/core";

/**
 * The wallet's explorer-backed trade history (`GET /v1/wallets/:address/history
 * ?kind=trades`), a Blockscout PRO read served for display only - never
 * accounting or PnL evidence, and never the wallet's real trade count (a page
 * covers pools the ledger does not register, so its length reads high or low
 * against the ledger-sourced Trades stat by design; see AGENTS.md and
 * `docs/WALLET-TRADE-HISTORY.md`). `WalletHistoryTrade` and the envelope are
 * `@pools/core`'s own wire types; this file only narrows the kind union and
 * validates a response against it, standing in for the shared validator the
 * api side already has in `apps/api/src/blockscout-client.ts`.
 */
export type WalletTradeHistoryResponse = Extract<
  WalletHistoryResponse,
  { kind: "trades" }
>;
export type { WalletHistoryTrade };

const txHash = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const cursorShape = /^[A-Za-z0-9_-]{1,2048}$/;
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
const nullableText = (v: unknown, max: number) =>
  v === null || (typeof v === "string" && v.length <= max);
const rawAmount = (v: unknown) =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);

function validTrade(value: unknown): value is WalletHistoryTrade {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  const token = t.token as Record<string, unknown> | null | undefined;
  return !!(
    typeof t.transactionHash === "string" &&
    txHash.test(t.transactionHash) &&
    integer(t.logIndex) &&
    integer(t.block) &&
    (t.timestamp === null || integer(t.timestamp)) &&
    (t.side === "buy" || t.side === "sell") &&
    token &&
    typeof token.address === "string" &&
    address.test(token.address) &&
    nullableText(token.symbol, 256) &&
    nullableText(token.name, 256) &&
    (token.decimals === null ||
      (Number.isSafeInteger(token.decimals) &&
        (token.decimals as number) >= 0 &&
        (token.decimals as number) <= 255)) &&
    nullableText(token.type, 64) &&
    rawAmount(t.tokenRaw) &&
    nullableText(t.method, 256)
  );
}

/** Every field this deployment relies on, checked before a trade row ever
 * reaches the DOM: a wrong wallet, a malformed cursor or an invalid trade
 * shape is as unusable as no body at all, per the same contract every other
 * saved-data response holds at this boundary. */
export function validateWalletTradeHistoryResponse(
  value: unknown,
  wallet: string,
): asserts value is WalletTradeHistoryResponse {
  const data = value as WalletTradeHistoryResponse | null;
  if (
    !data ||
    data.source !== "blockscout" ||
    data.chainId !== 4663 ||
    data.kind !== "trades" ||
    typeof data.wallet !== "string" ||
    data.wallet.toLowerCase() !== wallet.toLowerCase() ||
    !Array.isArray(data.items) ||
    !(data.nextCursor === null || cursorShape.test(data.nextCursor)) ||
    typeof data.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(data.fetchedAt)) ||
    typeof data.stale !== "boolean" ||
    typeof data.note !== "string"
  )
    throw Error("Invalid wallet trade history");
  for (const item of data.items)
    if (!validTrade(item)) throw Error("Invalid wallet trade");
}
