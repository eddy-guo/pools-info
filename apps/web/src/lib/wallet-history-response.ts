import type { WalletHistoryKind, WalletHistoryResponse } from "@pools/core";

/**
 * Explorer history is display-only, so this guard is about identity, shape and
 * order: another wallet's page, another tab's page, or a row the table cannot
 * render honestly must never reach the screen.
 */
export function validateWalletHistoryResponse(
  value: unknown,
  wallet: string,
  kind: WalletHistoryKind,
): asserts value is WalletHistoryResponse {
  const data = value as WalletHistoryResponse | null;
  const address = /^0x[0-9a-f]{40}$/;
  const hash = /^0x[0-9a-f]{64}$/;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const amount = (n: unknown) =>
    typeof n === "string" && /^(0|[1-9][0-9]{0,159})$/.test(n);
  const text = (n: unknown) =>
    n === null || (typeof n === "string" && !!n && n.length <= 256);
  if (
    !data ||
    data.source !== "blockscout" ||
    data.chainId !== 4663 ||
    data.wallet !== wallet ||
    data.kind !== kind ||
    !Array.isArray(data.items) ||
    data.items.length > 50 ||
    (data.nextCursor !== null &&
      !(
        typeof data.nextCursor === "string" &&
        /^[A-Za-z0-9_-]{1,4096}$/.test(data.nextCursor)
      )) ||
    typeof data.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(data.fetchedAt)) ||
    typeof data.stale !== "boolean" ||
    typeof data.note !== "string"
  )
    throw Error("Invalid explorer history");
  const keys = new Set<string>();
  // Pages are newest first; a block that climbs means a misordered or spliced page.
  let ceiling = Number.MAX_SAFE_INTEGER;
  if (data.kind === "transactions")
    for (const item of data.items) {
      if (
        !item ||
        !hash.test(item.hash) ||
        (item.block !== null && !integer(item.block)) ||
        (item.timestamp !== null && !integer(item.timestamp)) ||
        !address.test(item.from) ||
        (item.to !== null && !address.test(item.to)) ||
        !text(item.method) ||
        !["ok", "error", "pending"].includes(item.status) ||
        !amount(item.value) ||
        (item.fee !== null && !amount(item.fee)) ||
        (item.block !== null && item.block > ceiling) ||
        keys.has(item.hash)
      )
        throw Error("Invalid explorer transaction");
      if (item.block !== null) ceiling = item.block;
      keys.add(item.hash);
    }
  else
    for (const item of data.items) {
      const key = `${item?.transactionHash}:${item?.logIndex}`;
      if (
        !item ||
        !hash.test(item.transactionHash) ||
        !integer(item.logIndex) ||
        !integer(item.block) ||
        (item.timestamp !== null && !integer(item.timestamp)) ||
        !address.test(item.from) ||
        !address.test(item.to) ||
        !item.token ||
        !address.test(item.token.address) ||
        !text(item.token.symbol) ||
        !text(item.token.name) ||
        !text(item.token.type) ||
        (item.token.decimals !== null &&
          !(integer(item.token.decimals) && item.token.decimals <= 255)) ||
        (item.value !== null && !amount(item.value)) ||
        (item.tokenId !== null && !amount(item.tokenId)) ||
        // Neither an amount nor a token id leaves nothing true to show.
        (item.value === null && item.tokenId === null) ||
        !text(item.method) ||
        item.block > ceiling ||
        keys.has(key)
      )
        throw Error("Invalid explorer token transfer");
      ceiling = item.block;
      keys.add(key);
    }
}
