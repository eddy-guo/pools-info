import { shortAddress } from "@pools/core";
import { explorer, utc } from "./live-ui";
import { Unavailable } from "./ui";

/*
 * The cells of an explorer trade row (the wallet page's Trades tab and the
 * Following panel): one formatter and one empty-cell rule for both, so a
 * trade reads the same wherever it is listed. A value the explorer did not
 * send (decimals, block time) is the wordless `Unavailable`, never a guess.
 */

/**
 * A raw token amount and its decimals, in bigint arithmetic throughout: a
 * float division would lose precision on a large raw integer, exactly what
 * this figure must never do. Six significant fractional digits, truncated
 * (never rounded past what the wallet actually holds) and stripped of
 * trailing zeros, matching the six-significant-digit convention every other
 * token quantity in this app already uses.
 */
export function formatTokenRaw(
  raw: string,
  decimals: number | null,
): string | null {
  if (decimals === null) return null;
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracDigits = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  const wholeText = new Intl.NumberFormat("en-US").format(whole);
  return fracDigits ? `${wholeText}.${fracDigits}` : wholeText;
}

/** The scaled amount, followed by the symbol where the row has no token
 * column of its own to carry it. */
export function TradeAmount({
  raw,
  decimals,
  symbol,
}: {
  raw: string;
  decimals: number | null;
  symbol?: string | null;
}) {
  const amount = formatTokenRaw(raw, decimals);
  if (amount === null) return <Unavailable />;
  return symbol === undefined ? amount : `${amount} ${symbol ?? ""}`;
}

/** Buy/sell in neutral ink: it is not a PnL signal (`.wallet-trade-side`). */
export function TradeSide({ side }: { side: "buy" | "sell" }) {
  return (
    <span className="wallet-trade-side">{side === "buy" ? "Buy" : "Sell"}</span>
  );
}

export function TradeTime({ timestamp }: { timestamp: number | null }) {
  return timestamp == null ? <Unavailable /> : utc(timestamp);
}

export function TradeTransaction({ hash }: { hash: string }) {
  return (
    <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {shortAddress(hash)} ↗
    </a>
  );
}

/**
 * A reserved row's two text states, as separate keyed nodes. Left as bare
 * strings they are one text run that React rewrites in place, and Chrome
 * scores a rewritten run whose start moves - which every right-aligned cell
 * here does - reporting it against the `td` with rectangles that read
 * byte-identical in the observer's own log. Remounted nodes it never scores.
 */
export function RowFiller({ blank }: { blank: boolean }) {
  return blank ? (
    <span key="blank">{" "}</span>
  ) : (
    <span key="pending">Pending</span>
  );
}
