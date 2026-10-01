import {
  ethFigure,
  figureText,
  formatPercent,
  formatTokenAmount,
  since,
  WALLET_ROI_DIGITS,
  type EthFigure,
  type AnalyticsLeaderboardResponse,
  type AnalyticsWalletPosition,
  type AnalyticsWalletResponse,
  type CatalogPool,
  type AnalyticsWalletSummary,
  type ObservedMarket,
  type LiveWindow,
  type WalletPositionResponse,
} from "@pools/core";
import { readProduct, readWalletPosition } from "./product-server";
import type { Delivered } from "./use-product";

export interface CardWallet {
  result: Delivered<AnalyticsWalletResponse>;
}

/** How long one card read serves the modal's customize toggles before it is read again. */
export const cardReadLifetimeMs = 30_000;
const cardReadEntries = 64;
/**
 * One read shared by every render that asks for the same key for a short
 * while: the modal re-requests the image on every preset or toggle change,
 * and those renders should not each pay for a fresh index read. A failed read
 * is forgotten at once so the next request tries again.
 */
function cachedRead<T>(
  reads: Map<string, { expires: number; read: Promise<T> }>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now(),
    held = reads.get(key);
  if (held && held.expires > now) return held.read;
  for (const [k, entry] of reads)
    if (entry.expires <= now || reads.size >= cardReadEntries) reads.delete(k);
  const read = load();
  reads.set(key, { expires: now + cardReadLifetimeMs, read });
  read.catch(() => {
    if (reads.get(key)?.read === read) reads.delete(key);
  });
  return read;
}
const reads = new Map<string, { expires: number; read: Promise<CardWallet> }>();
/** The card's wallet read, shared by every render of the same wallet and window. */
export const readCardWallet = (
  address: string,
  window: LiveWindow,
): Promise<CardWallet> =>
  cachedRead(reads, `${address}:${window}`, () =>
    readProduct<AnalyticsWalletResponse>(
      ["wallets", address],
      new URLSearchParams({ window }),
    ).then((result) => ({ result })),
  );

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
/** A {@link CardEth} as one run of text, the subscript form in subscript digits. */
export const cardEthText = ({ sign, figure }: CardEth) =>
  `${sign}${figureText(figure)} ETH`;
export const cardEth = (wei: string, signed = false) =>
  cardEthText(cardEthFigure(wei, signed));
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

/**
 * What a position card is drawn from: the single-position read's own shape
 * (`WalletPositionResponse`, `GET /v1/wallets/:address/positions/:poolId`),
 * whose `position` is the wallet page's row for the pool, field for field,
 * beside the ledger's mark and the held units' average entry. A price the
 * read withholds (null) leaves its cell blank: it is never worked back out of
 * the row's other figures.
 */
export type PositionCardSource = Pick<
  WalletPositionResponse,
  "position" | "mark" | "avgEntryPriceWei"
>;
/** The pool read as it arrives: the read API nests the catalog row under
 * `pool`, the committed dataset serves it flat and with no market. */
interface CardPoolIdentity {
  token: string;
  launch: { transactionHash: string };
}
type CardPoolResponse = CardPoolIdentity & {
  pool?: CardPoolIdentity;
  market?: ObservedMarket | null;
};
export interface CardPosition {
  source: PositionCardSource;
  /** The pool's catalog row, as the position read names it. */
  pool: CatalogPool;
  /** The pool's served hourly price history, oldest first; empty where none
   * is served, and never read for a closed position, which draws no chart. */
  candles: { time: number; close: string }[];
  /** The wallet's rank on the All board; null while unranked. */
  rank: number | null;
}
const positionReads = new Map<
  string,
  { expires: number; read: Promise<WalletPositionResponse | null> }
>();
const poolReads = new Map<
  string,
  { expires: number; read: Promise<Delivered<CardPoolResponse>> }
>();
const boardReads = new Map<
  string,
  { expires: number; read: Promise<Delivered<AnalyticsLeaderboardResponse>> }
>();
/** The pool read behind an open position's chart, held as long as the position read. */
const readCardPool = (poolId: string) =>
  cachedRead(poolReads, poolId, () =>
    readProduct<CardPoolResponse>(
      ["pools", poolId],
      new URLSearchParams({ window: "All" }),
    ),
  );
/**
 * The All board's ranked top 100, one read shared by every position card for
 * as long as a position read is held. A wallet's rank is its place on this
 * board (`wallet.rank` on the wallet read is the same realized order at the
 * same gate), which the single-position read does not carry.
 */
const readCardBoard = () =>
  cachedRead(boardReads, "All", () =>
    readProduct<AnalyticsLeaderboardResponse>(
      ["leaderboard"],
      new URLSearchParams({ window: "All", limit: "100" }),
    ),
  );

/**
 * A position card's source and the pool it belongs to, or null when the
 * wallet holds no supported position in that pool or `launch` names another
 * launch: an excluded position gets no card, never a number. Built on the
 * single-position read; the pool read joins it only for an open position's
 * price chart, and must name the same launch.
 */
export async function readCardPosition(
  address: string,
  poolId: string,
  launch?: string,
): Promise<CardPosition | null> {
  const read = await cachedRead(positionReads, `${address}:${poolId}`, () =>
    readWalletPosition(address, poolId),
  );
  const row = read?.position;
  if (
    !read ||
    !row?.supported ||
    !row.position ||
    (launch && row.launchTx.toLowerCase() !== launch)
  )
    return null;
  const open = BigInt(row.position.quantity) > 0n;
  const [board, response] = await Promise.all([
    readCardBoard(),
    open ? readCardPool(poolId) : null,
  ]);
  const pool = response && (response.pool ?? response);
  // Both reads name the pool's launch: a disagreement is the catalog's to
  // settle, not a card to draw.
  if (
    pool &&
    (pool.token.toLowerCase() !== row.token.toLowerCase() ||
      pool.launch.transactionHash.toLowerCase() !== row.launchTx.toLowerCase())
  )
    throw Error("Pool identity disagrees with the position");
  return {
    source: {
      position: row,
      mark: read.mark,
      avgEntryPriceWei: read.avgEntryPriceWei,
    },
    pool: read.pool,
    candles: response?.market?.history.candles ?? [],
    rank:
      board.items.find((item) => item.address.toLowerCase() === address)
        ?.rank ?? null,
  };
}

/** A percent to four decimals, truncated toward zero in integer arithmetic as
 * the read API computes every ROI; null over a zero denominator. */
const percentOf = (numerator: bigint, denominator: bigint) =>
  denominator > 0n
    ? Number((numerator * 1_000_000n) / denominator) / 10_000
    : null;

/** Everything a position card prints, each figure null where its field is not served. */
export interface PositionCardFigures {
  /** Units still held: the card's OPEN state, else CLOSED. */
  open: boolean;
  /**
   * The headline: the realized ROI once any cost has been disposed of, over
   * that disposed cost as the board computes a wallet's; before the first
   * sale, the held units' unrealized PnL in ETH, in the neutral colour.
   */
  hero: {
    label: "Realized ROI" | "Unrealized PnL";
    value: string | null;
    eth: CardEth | null;
    tone: CardStat["tone"];
  };
  /** The lifetime realized amount, printed beside an ROI headline only. */
  realized: CardEth | null;
  /** Units held in whole tokens, the wallet page's Holding figure. */
  holding: string | null;
  unrealized: CardEth | null;
  /** The unrealized PnL over the held units' cost. */
  unrealizedRoi: string | null;
  invested: CardEth;
  proceeds: CardEth;
  /** ETH out over ETH in: exact for a closed position, which sold every unit it bought. */
  multiple: string | null;
  /** ETH in and out as percentages of the larger, for the in/out bars. */
  bars: { invested: number; proceeds: number };
  buys: number;
  sells: number;
  /** The held units' average entry and the ledger's mark, wei per whole token. */
  entry: CardEth | null;
  mark: CardEth | null;
  /** How long the open cycle has been held at the ledger's cut. */
  held: string | null;
}

export function positionCardFigures(
  source: PositionCardSource,
): PositionCardFigures | null {
  const row = source.position,
    p = row.position;
  if (!row.supported || !p) return null;
  const invested = BigInt(p.investedWei),
    proceeds = BigInt(p.proceedsWei),
    open = BigInt(p.quantity) > 0n,
    // invested = cost held + cost disposed of, for a supported position.
    roi =
      p.realizedWei === null
        ? null
        : percentOf(BigInt(p.realizedWei), invested - BigInt(p.costWei)),
    unrealizedRoi =
      row.unrealizedWei === null
        ? null
        : percentOf(BigInt(row.unrealizedWei), BigInt(p.costWei)),
    shownRoi = roi === null ? null : Number(roi.toFixed(2)),
    largest = invested > proceeds ? invested : proceeds,
    share = (wei: bigint) =>
      largest === 0n ? 0 : Number((wei * 10_000n) / largest) / 100;
  return {
    open,
    hero:
      roi === null || shownRoi === null
        ? {
            label: "Unrealized PnL",
            value:
              row.unrealizedWei === null
                ? null
                : cardEth(row.unrealizedWei, true),
            eth:
              row.unrealizedWei === null
                ? null
                : cardEthFigure(row.unrealizedWei, true),
            tone: "text",
          }
        : {
            label: "Realized ROI",
            value: formatPercent(roi),
            eth: null,
            tone: shownRoi > 0 ? "up" : shownRoi < 0 ? "down" : "text",
          },
    realized:
      roi === null || p.realizedWei === null
        ? null
        : cardEthFigure(p.realizedWei, true),
    holding:
      row.decimals === null
        ? null
        : formatTokenAmount(p.quantity, row.decimals),
    unrealized:
      row.unrealizedWei === null
        ? null
        : cardEthFigure(row.unrealizedWei, true),
    unrealizedRoi: unrealizedRoi === null ? null : formatPercent(unrealizedRoi),
    invested: cardEthFigure(p.investedWei),
    proceeds: cardEthFigure(p.proceedsWei),
    multiple:
      open || invested === 0n
        ? null
        : `${(Number((proceeds * 10_000n) / invested) / 10_000).toFixed(2)}x`,
    bars: { invested: share(invested), proceeds: share(proceeds) },
    buys: p.buys,
    sells: p.sells,
    entry:
      open && source.avgEntryPriceWei !== null
        ? cardEthFigure(source.avgEntryPriceWei)
        : null,
    mark:
      open && source.mark?.priceWei != null
        ? cardEthFigure(source.mark.priceWei)
        : null,
    held: open && p.openedAt != null ? since(p.openedAt, row.asOf) : null,
  };
}

/**
 * The OPEN card's price chart as geometry: the pool's served candles, at most
 * 240 of them picked evenly with both ends kept (the PNG's size budget), on a
 * scale that also holds the entry and mark levels when they are served. Only
 * the coordinates are floats; the prices are compared as the exact integers
 * they are. Fewer than two candles is no chart, never a drawn line.
 */
export function positionCardChart(
  candles: { time: number; close: string }[],
  entryWei: string | null,
  markWei: string | null,
  width: number,
  height: number,
): {
  points: [number, number][];
  entryY: number | null;
  markY: number | null;
} | null {
  if (candles.length < 2) return null;
  const sampled =
    candles.length <= 240
      ? candles
      : Array.from(
          { length: 240 },
          (_, i) => candles[Math.round((i * (candles.length - 1)) / 239)],
        );
  const values = sampled.map((c) => BigInt(c.close));
  const levels = [
    ...values,
    ...(entryWei === null ? [] : [BigInt(entryWei)]),
    ...(markWei === null ? [] : [BigInt(markWei)]),
  ];
  let min = levels.reduce((a, b) => (a < b ? a : b)),
    max = levels.reduce((a, b) => (a > b ? a : b));
  if (min === max) {
    min -= 1n;
    max += 1n;
  }
  const y = (v: bigint) =>
    height -
    (Number(((v - min) * 1_000_000n) / (max - min)) / 1_000_000) * height;
  const start = sampled[0].time,
    span = Math.max(1, sampled[sampled.length - 1].time - start);
  return {
    points: sampled.map((c, i) => [
      ((c.time - start) / span) * width,
      y(values[i]),
    ]),
    entryY: entryWei === null ? null : y(BigInt(entryWei)),
    markY: markWei === null ? null : y(BigInt(markWei)),
  };
}
