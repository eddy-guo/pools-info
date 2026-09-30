import {
  buildAnalyticsModel,
  ethFigure,
  figureText,
  formatPercent,
  walletAnalytics,
  WALLET_ROI_DIGITS,
  type EthFigure,
  type AnalyticsWalletPosition,
  type AnalyticsWalletResponse,
  type AnalyticsWalletSummary,
  type AnalyticsPoolDetail,
  type LiveWindow,
} from "@pools/core";
import { readProduct } from "./product-server";
import type { Delivered } from "./use-product";

export interface CardWallet {
  result: Delivered<AnalyticsWalletResponse>;
  /** The pool a scoped card is limited to; null on the wallet's global card. */
  poolSymbol: string | null;
}

async function readCardWalletUncached(
  address: string,
  window: LiveWindow,
  poolId?: string,
  launchTx?: string,
): Promise<CardWallet> {
  if (!poolId)
    return {
      result: await readProduct<AnalyticsWalletResponse>(
        ["wallets", address],
        new URLSearchParams({ window }),
      ),
      poolSymbol: null,
    };
  const saved = await readProduct<{ analytics: AnalyticsPoolDetail | null }>(
    ["pools", poolId],
    new URLSearchParams({ window }),
  );
  const publication = saved.analytics,
    market = publication?.snapshot.markets[0];
  if (
    !publication ||
    !market ||
    market.id.toLowerCase() !== poolId ||
    (launchTx && market.launchTx.toLowerCase() !== launchTx)
  )
    throw Error("Requested pool capture unavailable");
  const result = walletAnalytics(
    buildAnalyticsModel([market], [publication]),
    address,
    window,
  );
  return {
    result: { ...result, delivery: saved.delivery },
    poolSymbol: market.symbol,
  };
}

/** How long one wallet read serves the modal's customize toggles before it is read again. */
export const cardReadLifetimeMs = 30_000;
const cardReadEntries = 64;
const reads = new Map<string, { expires: number; read: Promise<CardWallet> }>();
/**
 * The card's wallet read, shared by every render of the same wallet and window
 * for a short while: the modal re-requests the image on every preset or toggle
 * change, and those renders should not each pay for a fresh index read. A
 * failed read is forgotten at once so the next request tries again.
 */
export function readCardWallet(
  address: string,
  window: LiveWindow,
  poolId?: string,
  launchTx?: string,
): Promise<CardWallet> {
  const key = [address, window, poolId ?? "", launchTx ?? ""].join(":"),
    now = Date.now(),
    held = reads.get(key);
  if (held && held.expires > now) return held.read;
  for (const [k, entry] of reads)
    if (entry.expires <= now || reads.size >= cardReadEntries) reads.delete(k);
  const read = readCardWalletUncached(address, window, poolId, launchTx);
  reads.set(key, { expires: now + cardReadLifetimeMs, read });
  read.catch(() => {
    if (reads.get(key)?.read === read) reads.delete(key);
  });
  return read;
}

/** The position the card names: the largest realized PnL in the window, then the most traded. */
export function cardTopPosition(
  positions: AnalyticsWalletPosition[],
): AnalyticsWalletPosition | null {
  let top: AnalyticsWalletPosition | null = null;
  for (const p of positions) {
    if (!top) {
      top = p;
      continue;
    }
    const realized = BigInt(p.realizedWei ?? 0),
      best = BigInt(top.realizedWei ?? 0);
    if (
      realized > best ||
      (realized === best && BigInt(p.volumeWei) > BigInt(top.volumeWei))
    )
      top = p;
  }
  return top;
}

/**
 * An ETH amount for the card: the site's one figure rule (`ethFigure`) with
 * the "+" a signed slot adds, so the card prints the string the wallet page's
 * tile prints ("+66.22 ETH" on both; the audit of 29 Sep 2026 found the card
 * at four significant digits against the page's own rule). The renderer draws
 * the subscript-zero form itself, so the figure travels beside its text.
 */
export interface CardEth {
  sign: "" | "+";
  figure: EthFigure;
}
export const cardEthFigure = (wei: string, signed = false): CardEth => ({
  sign: signed && BigInt(wei) > 0n ? "+" : "",
  figure: ethFigure(wei),
});
export const cardEth = (wei: string, signed = false) => {
  const { sign, figure } = cardEthFigure(wei, signed);
  return `${sign}${figureText(figure)} ETH`;
};
export interface CardStat {
  label: string;
  value: string;
  /** Signed values carry the up or down colour; everything else the text colour. */
  tone: "up" | "down" | "text";
  /** The ETH figure behind `value`, for the renderer's own subscript form. */
  eth?: CardEth;
}
const weiTone = (wei: string): CardStat["tone"] =>
  BigInt(wei) > 0n ? "up" : BigInt(wei) < 0n ? "down" : "text";
/**
 * The trade count the card prints and gates on: the wallet's trades on
 * supported positions, the figure the wallet page's Trades tile and every
 * board column print. `tradeCount` also counts the swaps on the positions
 * the PnL excludes, so a card built on it disagreed with the page it was
 * shared from (0x68bb…5713, 7d, 29 Sep 2026: card 26, page and board 23).
 */
export const cardTradeCount = (wallet: AnalyticsWalletSummary) =>
  wallet.supportedTradeCount;
/**
 * The three footer stats. With notional hidden the card shows no amount at all,
 * only the percentage, the record and the count; with it shown the traded
 * volume joins them (the realized amount already sits beside the percentage).
 * A stat the window cannot supply is left out, never printed as a dash.
 */
export function cardStats(
  wallet: AnalyticsWalletSummary,
  notional: boolean,
): CardStat[] {
  const count = new Intl.NumberFormat("en-US");
  const candidates: (CardStat | null)[] = [
    notional
      ? {
          label: "Volume",
          value: cardEth(wallet.volumeWei),
          tone: "text",
          eth: cardEthFigure(wallet.volumeWei),
        }
      : null,
    wallet.winRate === null
      ? null
      : {
          label: "Win rate",
          value: `${wallet.winRate.toFixed(1)}%`,
          tone: "text",
        },
    notional
      ? null
      : {
          label: "Record",
          value: `${wallet.wins}W · ${wallet.losses}L`,
          tone: "text",
        },
    {
      label: "Trades",
      value: count.format(cardTradeCount(wallet)),
      tone: "text",
    },
    {
      label: "Positions",
      value: count.format(wallet.supportedPositionCount),
      tone: "text",
    },
  ];
  return candidates.filter((s): s is CardStat => s !== null).slice(0, 3);
}

/** The window's ROI as the wallet page's ROI tile prints it. */
const cardRoi = (roi: number) => formatPercent(roi, WALLET_ROI_DIGITS);
/**
 * The hero figure: the window's ROI as the profile's ROI tile prints it, one
 * decimal and abbreviated from 10,000% ("+805.7%", "+15.3K%"), so the card
 * says what the page says and a figure never runs past its column. A wallet
 * that disposed of no cost in the window has no ROI and no card: its realized
 * amount is zero by construction, and a white "0 ETH" headline read as a
 * result where there was none.
 */
export function cardHero(
  wallet: AnalyticsWalletSummary,
): { value: string; tone: CardStat["tone"] } | null {
  if (wallet.roi === null) return null;
  const shown = Number(wallet.roi.toFixed(WALLET_ROI_DIGITS));
  return {
    value: cardRoi(wallet.roi),
    tone: shown > 0 ? "up" : shown < 0 ? "down" : "text",
  };
}

/**
 * The export design's hero: the window's realized amount in ETH, signed and
 * in the up or down colour, as the captain's export draws it. Its ROI is one
 * of the trio's stats, so the two never restate one figure; a wallet with no
 * realized amount, or nothing disposed to realize it on, has no export card.
 */
export function cardExportHero(
  wallet: AnalyticsWalletSummary,
): { value: string; tone: CardStat["tone"]; eth: CardEth } | null {
  if (wallet.realizedWei === null || wallet.roi === null) return null;
  return {
    value: cardEth(wallet.realizedWei, true),
    tone: weiTone(wallet.realizedWei),
    eth: cardEthFigure(wallet.realizedWei, true),
  };
}

/** Geist SemiBold advance widths, per 1000 em, of every glyph an ETH hero holds. */
const heroAdvance: Record<string, number> = {
  "0": 683,
  "1": 427,
  "2": 642,
  "3": 637,
  "4": 643,
  "5": 656,
  "6": 615,
  "7": 538,
  "8": 644,
  "9": 618,
  "+": 566,
  "-": 418,
  ".": 225,
  ",": 225,
  " ": 236,
  E: 615,
  T: 584,
  H: 719,
  // The compact suffixes the figure rule prints from a million ETH.
  K: 672,
  M: 902,
  B: 695,
};
/**
 * The export hero's font size: the design's 207 px, or the largest whole
 * size at which the figure fits the card's content width at the design's
 * -0.045 em letter spacing, since the renderer never shrinks text on its own
 * and a small realized amount ("-0.001234 ETH") runs far longer than the
 * "+12.40 ETH" the export was drawn with.
 */
export function cardExportHeroSize(
  value: string,
  width = 1040,
  max = 207,
): number {
  const em =
    [...value].reduce((sum, ch) => sum + (heroAdvance[ch] ?? 683), 0) / 1000 -
    0.045 * (value.length - 1);
  return Math.max(1, Math.min(max, Math.floor(width / em)));
}

/**
 * The export design's fixed ROI / Record / Best trade trio: unlike
 * {@link cardStats}'s dynamic top-3, these three slots are always drawn, each
 * left empty (not dashed or estimated) when the window has no such figure.
 */
export interface CardExportTrio {
  roi: string | null;
  record: string;
  /**
   * The top position's token: its symbol as the card draws it, or null where
   * the card's faces draw none of it and the token's monogram stands alone.
   */
  bestTrade: { symbol: string | null; token: string } | null;
}
export function cardExportTrio(
  wallet: AnalyticsWalletSummary,
  top: { symbol: string; token: string } | null,
  drawable: (codePoint: number) => boolean,
): CardExportTrio {
  return {
    roi: wallet.roi === null ? null : cardRoi(wallet.roi),
    record: `${wallet.wins}W · ${wallet.losses}L`,
    bestTrade: top && {
      symbol: cardSymbol(top.symbol, drawable),
      token: top.token,
    },
  };
}

/** The two glyphs the site's monogram tile shows for an address (`Avatar` in ui.tsx). */
export const cardInitials = (address: string) =>
  address.slice(2, 4).toUpperCase();

/**
 * A token symbol as the card can draw it: the glyphs its faces cover
 * (`drawable`, from the face's own character map), whitespace collapsed. A
 * symbol with nothing drawable left, one made of emoji alone as the catalog
 * has, is null: the card then shows the token's monogram on its own, never
 * emoji and never a blank line. Length is the renderer's to clamp, by the
 * width its slot has left, since a glyph count cannot bound a width.
 */
export function cardSymbol(
  symbol: string,
  drawable: (codePoint: number) => boolean,
): string | null {
  const text = [...symbol]
    .filter((glyph) => drawable(glyph.codePointAt(0)!))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/**
 * The curve as chart geometry: x follows time across the window, y the
 * cumulative PnL, with the zero line's position when it falls inside the range.
 * Fewer than two points is no curve; the card then draws its flat baseline.
 */
export function cardCurve(
  curve: { time: number; wei: string }[],
  width: number,
  height: number,
): { points: [number, number][]; zeroY: number | null } | null {
  if (curve.length < 2) return null;
  const values = curve.map((p) => Number(p.wei) / 1e18),
    t0 = curve[0].time,
    span = Math.max(1, curve[curve.length - 1].time - t0);
  let min = Math.min(...values),
    max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const y = (v: number) => height - ((v - min) / (max - min)) * height;
  return {
    points: curve.map((p, i) => [((p.time - t0) / span) * width, y(values[i])]),
    zeroY: min <= 0 && max >= 0 ? y(0) : null,
  };
}
