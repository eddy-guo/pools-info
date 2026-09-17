/** Coinbase's public keyless spot price, fetched server-side and cached with
 * stale-while-revalidate. Display only: never chain-derived, never joined to
 * accounting or PnL. */
export interface EthPriceResponse {
  usdPerEth: number;
  /** ISO 8601 UTC of the Coinbase fetch, not of this request. */
  asOf: string;
  source: "coinbase";
}
