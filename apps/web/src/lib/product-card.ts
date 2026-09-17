import {
  buildAnalyticsModel,
  walletAnalytics,
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

export interface CardStat {
  label: string;
  value: string;
  /** Signed values carry the up or down colour; everything else the text colour. */
  tone: "up" | "down" | "text";
}
export const cardEth = (wei: string, signed = false) => {
  const n = Number(wei) / 1e18;
  return `${signed && n > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(n)} ETH`;
};
const weiTone = (wei: string): CardStat["tone"] =>
  BigInt(wei) > 0n ? "up" : BigInt(wei) < 0n ? "down" : "text";
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
      ? { label: "Volume", value: cardEth(wallet.volumeWei), tone: "text" }
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
    { label: "Trades", value: count.format(wallet.tradeCount), tone: "text" },
    {
      label: "Positions",
      value: count.format(wallet.supportedPositionCount),
      tone: "text",
    },
  ];
  return candidates.filter((s): s is CardStat => s !== null).slice(0, 3);
}

/** The hero figure: the window's ROI, or its realized amount when no cost was disposed. */
export function cardHero(
  wallet: AnalyticsWalletSummary,
): { value: string; tone: CardStat["tone"] } | null {
  if (wallet.roi !== null) {
    const shown = Number(wallet.roi.toFixed(2));
    return {
      value: `${shown > 0 ? "+" : ""}${shown.toFixed(2)}%`,
      tone: shown > 0 ? "up" : shown < 0 ? "down" : "text",
    };
  }
  if (wallet.realizedWei !== null)
    return {
      value: cardEth(wallet.realizedWei, true),
      tone: weiTone(wallet.realizedWei),
    };
  return null;
}

/** The identicon the site draws for an address, as the card's SVG cells. */
export function identiconCells(address: string): { x: number; y: number }[] {
  const bits = address
    .slice(2, 11)
    .split("")
    .map((x) => parseInt(x, 16) % 2 === 0);
  const cells: { x: number; y: number }[] = [];
  for (let i = 0; i < 25; i++) {
    const x = i % 5,
      y = Math.floor(i / 5);
    if (bits[(y * 3 + Math.min(x, 4 - x)) % bits.length]) cells.push({ x, y });
  }
  return cells;
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
