export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
// Lossy conversion is for display/chart coordinates only, never accounting.
export function displayEth(wei: string): number {
  return Number(BigInt(wei)) / 1e18;
}
export function formatEth(wei: string, signed = false, digits = 2): string {
  const n = displayEth(wei);
  return `${signed && n > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n)}`;
}
/**
 * An ETH figure as every surface prints it (the design export's rule, applied
 * 29 Sep 2026): from 0.01 ETH up, two decimals ("240.54", "2,100.00", "0.01");
 * from 1,000,000 ETH, the compact form the site's money formatter already
 * uses ("1.23M"); under 0.01 ETH, four significant digits ("0.004104"); and
 * under 0.0001 ETH the site's subscript-zero form, the count of zeros after
 * "0.0" set as a subscript ("0.0₅4997"), so a small amount never prints as a
 * fabricated "0.00" and one column never mixes two and eleven decimals. An
 * exact zero is "0.00". The figure carries its own minus sign; the "+" a
 * signed slot wants is the caller's, so it can stay a separate text node.
 */
export type EthFigure =
  | { form: "plain"; text: string }
  | { form: "subscript"; sign: "" | "-"; zeros: number; digits: string };
const twoDecimals = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fourSignificant = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 4,
});
/** The rule over any unit amount with `decimals` places: wei at 18, a token's raw quantity at its own. */
export function unitFigure(raw: string, decimals: number): EthFigure {
  const value = BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const sign = negative ? "-" : "";
  if (abs === 0n) return { form: "plain", text: "0.00" };
  const n = Number(abs) / 10 ** decimals;
  if (n >= 1_000_000) return { form: "plain", text: `${sign}${compact(n)}` };
  if (n >= 0.01) return { form: "plain", text: `${sign}${twoDecimals.format(n)}` };
  if (n >= 0.0001)
    return { form: "plain", text: `${sign}${fourSignificant.format(n)}` };
  const str = abs.toString().padStart(decimals, "0");
  const zeros = str.match(/^0+/)?.[0].length ?? 0;
  return { form: "subscript", sign, zeros, digits: str.slice(zeros, zeros + 4) };
}
export const ethFigure = (wei: string): EthFigure => unitFigure(wei, 18);
const subscriptDigits = "₀₁₂₃₄₅₆₇₈₉";
/** A count as subscript digits, for the string form of a subscript-zero figure. */
export const subscript = (n: number): string =>
  String(n)
    .split("")
    .map((d) => subscriptDigits[Number(d)])
    .join("");
/** {@link EthFigure} as one string, "0.0₅4997" for the subscript form. */
export function figureText(figure: EthFigure): string {
  return figure.form === "plain"
    ? figure.text
    : `${figure.sign}0.0${subscript(figure.zeros)}${figure.digits}`;
}
/** The ETH figure of a wei amount as one string, no unit and no "+". */
export const formatEthAmount = (wei: string): string =>
  figureText(ethFigure(wei));
/** A token quantity under the same rule, from its raw units and decimals. */
export const formatTokenAmount = (raw: string, decimals: number): string =>
  figureText(unitFigure(raw, decimals));
export function compact(n: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: digits,
  }).format(n);
}
/** Four integer digits ("+9999.99%") are the widest fixed figure the trader
    leaderboard's 104px ROI column holds; from here the abbreviated form
    takes over where a surface asks for it, and on the share cards always. */
export const ABBREVIATE_CHANGE_FROM = 10_000;
/**
 * A signed percentage as the site's `Change` prints it, abbreviated from
 * {@link ABBREVIATE_CHANGE_FROM}: "+805.67%", "-84.98%", "0.00%", "+15.3K%".
 * The sign follows the rounded figure, so a change that rounds to zero
 * carries none.
 */
export function formatPercent(value: number, digits = 2): string {
  const shown = Number(value.toFixed(digits));
  const sign = shown > 0 ? "+" : "";
  return `${sign}${Math.abs(shown) >= ABBREVIATE_CHANGE_FROM ? compact(value, 1) : shown.toFixed(digits)}%`;
}
/** The decimals a wallet's ROI prints with on its profile's stat tile, which
    holds the figure on one line at phone widths, and on the share card made
    from that profile, so the card says what the page says ("+805.7%"). */
export const WALLET_ROI_DIGITS = 1;
export function formatMoney(
  wei: string,
  currency: "ETH" | "USD",
  ethUsd: number,
  signed = false,
): string {
  const n = displayEth(wei) * (currency === "USD" ? ethUsd : 1);
  const prefix = signed && n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${prefix}${currency === "USD" ? "$" : ""}${abs >= 1_000_000 ? compact(abs) : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs)}${currency === "ETH" ? " ETH" : ""}`;
}
export function since(timestamp: number, asOf: number): string {
  const seconds = Math.max(0, asOf - timestamp);
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
export function sumWei(values: string[]): string {
  return values.reduce((n, v) => n + BigInt(v), 0n).toString();
}
