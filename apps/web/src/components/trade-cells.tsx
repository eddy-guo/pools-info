import { shortAddress } from "@pools/core";
import type { ReactNode } from "react";
import { explorer, utc } from "./live-ui";
import { NewTabNotice, Unavailable } from "./ui";

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
  return symbol === undefined ? (
    amount
  ) : (
    <span className="trade-amount-pair">
      <span className="trade-amount-quantity">{amount}</span>{" "}
      <span className="trade-amount-symbol" title={symbol ?? undefined}>
        {symbol ?? ""}
      </span>
    </span>
  );
}

/** Buy/sell as the export's live feed prints it: BUY in the up colour, SELL
    in the down colour (`.wallet-trade-side`). */
export function TradeSide({ side }: { side: "buy" | "sell" }) {
  return (
    <span className="wallet-trade-side" data-side={side}>
      {side === "buy" ? "Buy" : "Sell"}
    </span>
  );
}

export function TradeTime({ timestamp }: { timestamp: number | null }) {
  return timestamp == null ? <Unavailable /> : utc(timestamp);
}

export function TradeTransaction({ hash }: { hash: string }) {
  return (
    <a
      href={`${explorer}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {shortAddress(hash)} ↗
      <NewTabNotice />
    </a>
  );
}

/**
 * A trade's figures in a phone row (`.mobile-trade-row`), on two lines: the
 * amount and its token, then the time and the transaction. One line runs
 * past a 390px list, so both lists that show explorer trades use this. The
 * amount never gives way to a long symbol; the symbol ellipsises instead
 * (`.mobile-trade-amount`), and a time the explorer did not send drops out
 * with its separator.
 */
export function TradePhoneStats({
  raw,
  decimals,
  token,
  timestamp,
  hash,
}: {
  raw: string;
  decimals: number | null;
  token: ReactNode;
  timestamp: number | null;
  hash: string;
}) {
  const amount = formatTokenRaw(raw, decimals);
  return (
    <>
      <div className="mobile-wallet-row-stats mobile-trade-amount">
        <span title={amount ?? undefined}>{amount ?? <Unavailable />}</span>
        {/* Not rendered between flex items; kept so the row reads and
            copies as "amount symbol". */}{" "}
        {token}
      </div>
      <div className="mobile-wallet-row-stats">
        {timestamp !== null && (
          <>
            <TradeTime timestamp={timestamp} /> ·{" "}
          </>
        )}
        <TradeTransaction hash={hash} />
      </div>
    </>
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
