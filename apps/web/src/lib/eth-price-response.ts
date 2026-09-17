import type { EthPriceResponse } from "@pools/core";

/** Coinbase's spot price is display-only market context, not a trade input or
 * pool identity, so this guard checks shape and freshness bounds only. */
export function validateEthPriceResponse(
  value: unknown,
): asserts value is EthPriceResponse {
  const data = value as EthPriceResponse | null;
  if (
    !data ||
    typeof data.usdPerEth !== "number" ||
    !Number.isFinite(data.usdPerEth) ||
    data.usdPerEth <= 0 ||
    typeof data.asOf !== "string" ||
    Number.isNaN(Date.parse(data.asOf)) ||
    data.source !== "coinbase"
  )
    throw Error("Invalid ETH/USD price");
}
