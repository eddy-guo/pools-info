import { displayEth, formatMoney } from "@pools/core";

/**
 * The USD form of a token price, as `Price` in `components/ui.tsx` renders
 * it: `plain` is the text itself; `subscript` is the leading-zero notation
 * `$0.0<sub>zeros</sub>digits`, with `zeros` the zeros after the point and
 * `digits` the four significant digits after them.
 */
export type UsdPrice =
  | { form: "plain"; text: string }
  | { form: "subscript"; zeros: number; digits: string; title: string };

/**
 * Most catalog prices are sub-cent, and a two-decimal dollar figure hides
 * them ("$0.01" for $0.0137, "$0.00" for $0.004). Below a dollar the figure
 * keeps four significant digits, the rule the ETH form follows, with at
 * least two decimals so a round figure still reads as dollars and cents
 * ("$0.50"); from a dollar up it keeps the two-decimal money form (grouped,
 * compact from a million). Below $0.0001 it takes the ETH form's
 * leading-zero notation instead of an all-zero column.
 */
export function usdPrice(wei: string, usdPerEth: number): UsdPrice {
  const usd = displayEth(wei) * usdPerEth;
  if (usd > 0 && usd < 0.0001) {
    const frac = usd.toFixed(18).slice(2);
    const zeros = frac.match(/^0+/)?.[0].length ?? 0;
    return {
      form: "subscript",
      zeros,
      digits: frac.slice(zeros, zeros + 4),
      title: `$${usd.toPrecision(4)}`,
    };
  }
  // Rounded before the branch is chosen, so a price that rounds up to a
  // dollar at four significant digits reads "$1.00" like every figure from
  // a dollar up, never "$1.000".
  const rounded = usd < 1 ? Number(usd.toPrecision(4)) : usd;
  if (rounded > 0 && rounded < 1)
    return {
      form: "plain",
      text: `$${rounded.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 7,
      })}`,
    };
  return { form: "plain", text: formatMoney(wei, "USD", usdPerEth) };
}
