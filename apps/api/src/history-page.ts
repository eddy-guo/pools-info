import type { WalletHistoryKind } from "@pools/core";

export const historyKinds = [
  "transactions",
  "token-transfers",
  "trades",
] as const;

/** Blockscout's `next_page_params` as this api carries it: only the keys of
 * the kind's schema below, each in its canonical text form. */
export type PageParams = Record<string, string>;

/** Each kind's explorer path under the address, and the filter it always
 * sends, which every cursor of the kind is bound to. Trades read the wallet's
 * ERC-20 transfers: the explorer's own advanced filter can select the
 * PoolManager legs upstream, but it answered in 13-18 s (2026-09-25), past
 * the client's timeout, while this page answers in about 2 s and drops the
 * NFT mints that crowd a launcher's page. */
export const upstream: Record<
  WalletHistoryKind,
  { path: string; filter: Record<string, string> }
> = {
  transactions: { path: "transactions", filter: {} },
  "token-transfers": { path: "token-transfers", filter: {} },
  trades: { path: "token-transfers", filter: { type: "ERC-20" } },
};

/** A field's canonical text, or null when the value is not one of its. */
type Field = (value: unknown) => string | null;
const integerText = /^(0|[1-9][0-9]*)$/;
/** A non-negative integer up to `max`, as the number Blockscout sends or its
 * canonical text: no sign, no leading zero, no fraction, no exponent. */
function integer(max = Number.MAX_SAFE_INTEGER): Field {
  return (value) => {
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" &&
            value.length <= 16 &&
            integerText.test(value)
          ? Number(value)
          : NaN;
    return Number.isSafeInteger(n) && n >= 0 && n <= max ? String(n) : null;
  };
}
/** A wei amount as Blockscout sends it: canonical decimal text of at most 78
 * digits (a uint256). */
const wei: Field = (value) =>
  typeof value === "string" && value.length <= 78 && integerText.test(value)
    ? value
    : null;
const hash: Field = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
/** Blockscout's `inserted_at`: an ISO 8601 UTC instant with up to six
 * fractional digits, kept verbatim since the explorer compares it as sent. */
const instant: Field = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : null;
const index = integer(2147483647);
/** The explorer's own paging keys per kind (`next_page_params` of
 * `addresses/:hash/transactions` and `addresses/:hash/token-transfers`, as
 * recorded under `apps/api/fixtures/blockscout/`): a position is only ever
 * these keys, so nothing a cursor carries can add a filter, and a value is
 * only ever the field's canonical form. */
const transfers: Record<string, Field> = {
  block_number: integer(),
  index,
  items_count: index,
  batch_log_index: index,
  batch_block_hash: hash,
  batch_transaction_hash: hash,
  index_in_batch: index,
};
export const pageSchema: Record<WalletHistoryKind, Record<string, Field>> = {
  transactions: {
    block_number: integer(),
    index,
    items_count: index,
    hash,
    fee: wei,
    value: wei,
    inserted_at: instant,
  },
  "token-transfers": transfers,
  trades: transfers,
};

/** The provider's position in its canonical form (keys sorted, values in
 * canonical text), null when the provider names none, and an error naming
 * the key for a key outside the kind's schema, a value that is not the
 * field's canonical form, or a position with no key at all. */
export function canonicalPageParams(
  kind: WalletHistoryKind,
  value: unknown,
): PageParams | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw Error("page");
  const schema = pageSchema[kind];
  const page: PageParams = {};
  for (const key of Object.keys(value).sort()) {
    if (!Object.hasOwn(schema, key)) throw Error(`page key ${key}`);
    const text = schema[key]((value as Record<string, unknown>)[key]);
    if (text === null) throw Error(`page value ${key}`);
    page[key] = text;
  }
  if (!Object.keys(page).length) throw Error("page empty");
  return page;
}
