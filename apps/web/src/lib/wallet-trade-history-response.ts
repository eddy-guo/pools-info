/**
 * The wallet's explorer-backed trade history (`GET /v1/wallets/:address/history
 * ?kind=trades`), a Blockscout PRO read served for display only - never
 * accounting or PnL evidence, and never the wallet's real trade count (a page
 * covers pools the ledger does not register, so its length reads high or low
 * against the ledger-sourced Trades stat by design; see AGENTS.md). It shares
 * the existing wallet-history envelope (`source`, `chainId`, `wallet`, `kind`,
 * `items`, `nextCursor`, `fetchedAt`, `stale`, `note`) with the transactions
 * and token-transfers kinds served today, this file's validator standing in
 * for the shared one those already have in `apps/api/src/blockscout-client.ts`.
 */
export interface WalletTradeHistoryToken {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  type: string | null;
}
export interface WalletHistoryTrade {
  transactionHash: string;
  logIndex: number;
  block: number;
  /** Unix seconds; null only if the explorer has not attached a block time. */
  timestamp: number | null;
  side: "buy" | "sell";
  token: WalletTradeHistoryToken;
  /** Raw integer token amount, exact decimal string - never derived from a
      float, so a display value must divide it by `10 ** token.decimals`
      itself in bigint arithmetic. */
  tokenRaw: string;
  method: string | null;
}
export interface WalletTradeHistoryResponse {
  source: "blockscout";
  chainId: 4663;
  wallet: string;
  kind: "trades";
  items: WalletHistoryTrade[];
  /** Opaque; pass back as `cursor` to fetch the next page, null at the end.
      The only signal a caller may use to decide whether more pages exist - a
      page can hold anywhere from 25 to 150 trades, so its length never is. */
  nextCursor: string | null;
  fetchedAt: string;
  stale: boolean;
  note: string;
}

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
