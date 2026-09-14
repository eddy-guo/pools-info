import type { Position, Trade } from "./types";

// Integer arithmetic only. An unknown-basis sale invalidates realized PnL for
// the position rather than assigning free cost to the untracked inventory.
export function foldTrades(input: Trade[]): Position {
  if (!input.length) throw new Error("Cannot fold an empty position");
  const trades = [...input].sort(
    (a, b) => a.block - b.block || a.logIndex - b.logIndex,
  );
  const first = trades[0];
  let qty = 0n,
    cost = 0n,
    realized = 0n,
    invested = 0n,
    proceeds = 0n;
  let buys = 0,
    sells = 0;
  const flags = new Set<string>();
  const seen = new Map<string, string>();
  const realizations: Position["realizations"] = [];
  for (const t of trades) {
    if (t.poolId !== first.poolId || t.trader !== first.trader)
      throw new Error("Mixed position");
    const key = `${t.txHash.toLowerCase()}:${t.logIndex}`;
    const content = JSON.stringify(t);
    if (seen.has(key)) {
      if (seen.get(key) !== content)
        throw new Error(
          "Conflicting duplicate trade; reconcile canonical blocks first",
        );
      continue;
    }
    seen.set(key, content);
    const eth = BigInt(t.ethWei),
      tok = BigInt(t.tokenRaw);
    if (eth <= 0n || tok <= 0n)
      throw new Error("Trade amounts must be positive");
    if (t.side === "buy") {
      qty += tok;
      cost += eth;
      invested += eth;
      buys++;
    } else {
      sells++;
      proceeds += eth;
      if (tok > qty) {
        flags.add("unknown_basis");
        qty = 0n;
        cost = 0n;
        continue;
      }
      const basis = tok === qty ? cost : (cost * tok) / qty;
      const gain = eth - basis;
      qty -= tok;
      cost -= basis;
      realized += gain;
      realizations.push({ timestamp: t.timestamp, wei: gain.toString() });
    }
  }
  return {
    poolId: first.poolId,
    trader: first.trader,
    quantity: qty.toString(),
    costWei: cost.toString(),
    realizedWei: flags.size ? null : realized.toString(),
    investedWei: invested.toString(),
    proceedsWei: proceeds.toString(),
    buys,
    sells,
    flags: [...flags],
    realizations: flags.size ? [] : realizations,
  };
}

export function realizedInWindow(
  position: Position,
  from: number,
): bigint | null {
  if (position.realizedWei === null) return null;
  return position.realizations
    .filter((r) => r.timestamp >= from)
    .reduce((sum, r) => sum + BigInt(r.wei), 0n);
}
