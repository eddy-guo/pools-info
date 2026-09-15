import {
  parseFollowingWallets,
  type FollowingActivityResponse,
} from "@pools/core";

/** A stale or misrouted response must never show another follow list's signals. */
export function validateFollowingResponse(
  value: unknown,
  params: URLSearchParams,
): asserts value is FollowingActivityResponse {
  const data = value as FollowingActivityResponse | null;
  const wallets = new Set(parseFollowingWallets(params.get("wallets")));
  const hash = /^0x[0-9a-f]{64}$/;
  const address = /^0x[0-9a-f]{40}$/;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const amount = (n: unknown) =>
    typeof n === "string" && /^(0|[1-9][0-9]{0,159})$/.test(n);
  const ids = new Set<string>();
  if (
    !data ||
    data.scope !== "saved_verified_positions" ||
    !Array.isArray(data.items) ||
    data.items.length > Number(params.get("limit") ?? 50) ||
    typeof data.hasMore !== "boolean" ||
    typeof data.notice !== "string" ||
    data.coverage?.complete !== false ||
    data.coverage.registryExhaustive !== false ||
    data.coverage.requestedWallets !== wallets.size ||
    !integer(data.coverage.returnedPools) ||
    (data.coverage.asOf !== null && !integer(data.coverage.asOf)) ||
    (data.coverage.oldestAsOf !== null && !integer(data.coverage.oldestAsOf))
  )
    throw Error("Invalid following activity");
  for (const row of data.items) {
    if (
      !row ||
      !wallets.has(row.wallet) ||
      !address.test(row.token) ||
      !hash.test(row.poolId) ||
      !hash.test(row.txHash) ||
      !integer(row.logIndex) ||
      !integer(row.block) ||
      !integer(row.timestamp) ||
      !integer(row.asOf) ||
      !integer(row.throughBlock) ||
      row.timestamp > row.asOf ||
      row.block > row.throughBlock ||
      row.supported !== true ||
      !["buy", "sell"].includes(row.side) ||
      typeof row.symbol !== "string" ||
      row.symbol.length > 256 ||
      !integer(row.decimals) ||
      row.decimals > 255 ||
      !amount(row.ethWei) ||
      !amount(row.tokenRaw) ||
      BigInt(row.ethWei) <= 0n ||
      BigInt(row.tokenRaw) <= 0n ||
      (row.priceWei !== null && !amount(row.priceWei)) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 256 ||
      ids.has(`${row.txHash}:${row.logIndex}`)
    )
      throw Error("Invalid following trade");
    ids.add(`${row.txHash}:${row.logIndex}`);
  }
}
