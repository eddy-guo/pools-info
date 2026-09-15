import type { TradeShareResponse } from "@pools/core";

/** Shareable money must match the exact requested sale and its saved basis. */
export function validateTradeShareResponse(
  value: unknown,
  endpoint: string,
  params: URLSearchParams,
): asserts value is TradeShareResponse {
  const data = value as TradeShareResponse | null;
  const [, poolId, txHash, logIndex] = endpoint.split("/");
  const trade = data?.trade;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const amount = (n: unknown) =>
    typeof n === "string" && /^(0|[1-9][0-9]{0,159})$/.test(n);
  const signedAmount = (n: unknown) =>
    typeof n === "string" && /^(0|-?[1-9][0-9]{0,159})$/.test(n);
  if (
    !data ||
    data.scope !== "saved_verified_sale" ||
    data.coverage?.complete !== false ||
    data.coverage.registryExhaustive !== false ||
    !trade ||
    trade.supported !== true ||
    trade.side !== "sell" ||
    trade.wallet !== params.get("wallet") ||
    trade.poolId !== poolId ||
    trade.txHash !== txHash ||
    trade.logIndex !== Number(logIndex) ||
    !/^0x[0-9a-f]{40}$/.test(trade.token) ||
    typeof trade.symbol !== "string" ||
    trade.symbol.length > 256 ||
    !integer(trade.decimals) ||
    trade.decimals > 36 ||
    !integer(trade.block) ||
    !integer(trade.timestamp) ||
    !integer(trade.asOf) ||
    !integer(trade.throughBlock) ||
    trade.timestamp > trade.asOf ||
    trade.block > trade.throughBlock ||
    !amount(trade.ethWei) ||
    !amount(trade.tokenRaw) ||
    !amount(trade.disposedCostWei) ||
    !signedAmount(trade.realizedWei) ||
    BigInt(trade.ethWei) <= 0n ||
    BigInt(trade.tokenRaw) <= 0n ||
    BigInt(trade.realizedWei) !==
      BigInt(trade.ethWei) - BigInt(trade.disposedCostWei)
  )
    throw Error("Invalid verified sale");
}
