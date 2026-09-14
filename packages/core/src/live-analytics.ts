import { foldTrades, realizedInWindow } from "./accounting";
import type { ChainMarket, ChainSnapshot, PoolAudit } from "./chain-types";

export const windows = {
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  All: Infinity,
};
export type LiveWindow = keyof typeof windows;
export function poolWindow(
  market: ChainMarket,
  snapshot: ChainSnapshot,
  window: LiveWindow,
) {
  const from = snapshot.toTimestamp - windows[window];
  const trades = snapshot.trades.filter(
    (t) => t.poolId === market.id && t.timestamp >= from,
  );
  const before = market.series.filter((p) => p.time <= from).at(-1);
  const opening =
    before ?? (market.launchedAt >= from ? market.series[0] : undefined);
  const latest = market.series.at(-1);
  const change =
    opening && latest && BigInt(opening.wei) > 0n
      ? Number(
          ((BigInt(latest.wei) - BigInt(opening.wei)) * 1000000n) /
            BigInt(opening.wei),
        ) / 10000
      : null;
  return {
    trades,
    volumeWei: trades.reduce((n, t) => n + BigInt(t.ethWei), 0n).toString(),
    change,
    sinceLaunch: market.launchedAt >= from,
  };
}
export function poolHref(m: Pick<ChainMarket, "id" | "launchTx">) {
  return `/pool/${m.id}/?launch=${m.launchTx}`;
}
export function walletHref(
  address: string,
  m?: Pick<ChainMarket, "id" | "launchTx">,
) {
  return `/wallet/${address.toLowerCase()}/${m ? `?pool=${m.id}&launch=${m.launchTx}` : ""}`;
}
export function walletMetrics(
  audit: PoolAudit,
  address: string,
  window: LiveWindow = "All",
) {
  const row = audit.wallets.find(
    (w) => w.address.toLowerCase() === address.toLowerCase(),
  );
  if (!row) return null;
  const observed = audit.executions
    .filter((e) => e.trade.trader.toLowerCase() === address.toLowerCase())
    .sort(
      (a, b) =>
        a.trade.block - b.trade.block || a.trade.logIndex - b.trade.logIndex,
    );
  const supported = observed.filter((e) => !e.flags.length).map((e) => e.trade);
  const position = supported.length ? foldTrades(supported) : null;
  const complete =
    row.realizedWei !== null &&
    row.flags.length === 0 &&
    position?.realizedWei !== null &&
    !!position;
  const from = audit.toTimestamp - windows[window];
  const selected = observed.filter((e) => e.trade.timestamp >= from);
  const validWindow = selected
    .filter((e) => !e.flags.length)
    .map((e) => e.trade);
  const proceeds = validWindow
    .filter((t) => t.side === "sell")
    .reduce((n, t) => n + BigInt(t.ethWei), 0n);
  const spent = validWindow
    .filter((t) => t.side === "buy")
    .reduce((n, t) => n + BigInt(t.ethWei), 0n);
  const realized = complete ? realizedInWindow(position!, from)! : null;
  const disposedCost = realized === null ? null : proceeds - realized;
  const roi =
    disposedCost !== null && disposedCost > 0n
      ? Number((realized! * 1000000n) / disposedCost) / 10000
      : null;
  let qty = 0n,
    start = 0,
    cycleGain = 0n,
    realizationIndex = 0;
  const closures: { time: number; duration: number; gain: bigint }[] = [];
  if (complete)
    for (const t of supported) {
      if (t.side === "buy") {
        if (qty === 0n) {
          start = t.timestamp;
          cycleGain = 0n;
        }
        qty += BigInt(t.tokenRaw);
      } else {
        qty -= BigInt(t.tokenRaw);
        cycleGain += BigInt(position!.realizations[realizationIndex++].wei);
        if (qty === 0n)
          closures.push({
            time: t.timestamp,
            duration: t.timestamp - start,
            gain: cycleGain,
          });
      }
    }
  const closed = closures.filter((c) => c.time >= from);
  const wins = closed.filter((c) => c.gain > 0n).length,
    losses = closed.filter((c) => c.gain < 0n).length;
  const gains = complete
    ? position!.realizations.filter((p) => p.timestamp >= from)
    : [];
  let cumulative = 0n;
  const curve = complete
    ? [
        {
          time: Math.max(
            Number.isFinite(from) ? from : audit.market.launchedAt,
            audit.market.launchedAt,
          ),
          wei: "0",
        },
        ...gains.map((p) => ({
          time: p.timestamp,
          wei: (cumulative += BigInt(p.wei)).toString(),
        })),
        { time: audit.toTimestamp, wei: cumulative.toString() },
      ]
    : [];
  const best = gains.reduce<bigint | null>(
    (n, p) => (n === null || BigInt(p.wei) > n ? BigInt(p.wei) : n),
    null,
  );
  const buys = validWindow.filter((t) => t.side === "buy");
  const bought = buys.reduce((n, t) => n + BigInt(t.tokenRaw), 0n);
  const early = buys
    .filter((t) => t.block - audit.market.launchBlock < 5)
    .reduce((n, t) => n + BigInt(t.tokenRaw), 0n);
  const value =
    complete && audit.market.priceWei !== null
      ? (BigInt(position!.quantity) * BigInt(audit.market.priceWei)) /
        10n ** BigInt(audit.market.decimals)
      : null;
  return {
    row,
    complete,
    trades: selected,
    position,
    realizedWei: realized?.toString() ?? null,
    netWei: complete ? (proceeds - spent).toString() : null,
    volumeWei: selected
      .reduce((n, e) => n + BigInt(e.trade.ethWei), 0n)
      .toString(),
    roi,
    wins,
    losses,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    avgHold: closed.length
      ? closed.reduce((n, c) => n + c.duration, 0) / closed.length
      : null,
    fastHoldShare: closed.length
      ? (closed.filter((c) => c.duration < 60).length / closed.length) * 100
      : null,
    earlyBuyShare:
      bought > 0n ? Number((early * 1000000n) / bought) / 10000 : null,
    bestWei: best?.toString() ?? null,
    curve,
    valueWei: value?.toString() ?? null,
    unrealizedWei:
      value !== null ? (value - BigInt(position!.costWei)).toString() : null,
    last: selected.at(-1)?.trade.timestamp ?? null,
    soldMoreThanBought:
      observed
        .filter((e) => e.trade.side === "sell")
        .reduce((n, e) => n + BigInt(e.trade.tokenRaw), 0n) >
      observed
        .filter((e) => e.trade.side === "buy")
        .reduce((n, e) => n + BigInt(e.trade.tokenRaw), 0n),
    didNotBuy: !observed.some((e) => e.trade.side === "buy"),
  };
}
