import type { Position, Trade } from "./types";

export const tier2Flags = [
  "initiator_attribution",
  "missing_transfer_history",
  "no_beneficiary_attribution",
] as const;
/** A swaps-only model attributed consistently to tx.from. It never asserts a
 * token balance or verified beneficiary. Whole-book basis precedes sale filters. */
export class InitiatorLedger {
  private quantity = 0n;
  private cost = 0n;
  private invested = 0n;
  private proceeds = 0n;
  private lifetimeGain = 0n;
  private windowGain = 0n;
  private windowCost = 0n;
  private volume = 0n;
  private net = 0n;
  private count = 0;
  private buys = 0;
  private sells = 0;
  private wins = 0;
  private losses = 0;
  private best: bigint | null = null;
  private last: number | null = null;
  private previous: Trade | null = null;
  private unknown: boolean;
  readonly flags: string[];
  constructor(
    readonly poolId: string,
    readonly wallet: string,
    readonly from: number,
    readonly fromLaunch: boolean,
  ) {
    this.unknown = !fromLaunch;
    this.flags = [
      ...tier2Flags,
      ...(!fromLaunch ? ["late_history_start", "unknown_basis"] : []),
    ];
  }
  invalidate(flag: string) {
    this.unknown = true;
    if (!this.flags.includes(flag)) this.flags.push(flag);
    if (!this.flags.includes("unknown_basis")) this.flags.push("unknown_basis");
  }
  add(t: Trade): { timestamp: number; wei: string } | null {
    if (t.poolId !== this.poolId || t.trader !== this.wallet)
      throw Error("Mixed initiator book");
    if (
      this.previous &&
      (t.block < this.previous.block ||
        (t.block === this.previous.block &&
          t.logIndex < this.previous.logIndex))
    )
      throw Error("Unordered initiator book");
    if (
      this.previous?.txHash === t.txHash &&
      this.previous.logIndex === t.logIndex
    ) {
      if (JSON.stringify(t) !== JSON.stringify(this.previous))
        throw Error("Conflicting duplicate trade");
      return null;
    }
    this.previous = t;
    const eth = BigInt(t.ethWei),
      token = BigInt(t.tokenRaw);
    if (eth <= 0n || token <= 0n) throw Error("Trade amounts must be positive");
    const inWindow = t.timestamp >= this.from;
    if (inWindow) {
      this.count++;
      this.volume += eth;
      this.net += t.side === "sell" ? eth : -eth;
      this.last = Math.max(this.last ?? 0, t.timestamp);
    }
    if (t.side === "buy") {
      this.quantity += token;
      this.cost += eth;
      this.invested += eth;
      this.buys++;
      return null;
    }
    this.sells++;
    this.proceeds += eth;
    if (token > this.quantity) {
      this.invalidate("unknown_basis");
      this.quantity = 0n;
      this.cost = 0n;
      return null;
    }
    const basis =
      token === this.quantity ? this.cost : (this.cost * token) / this.quantity;
    const gain = eth - basis;
    this.quantity -= token;
    this.cost -= basis;
    this.lifetimeGain += gain;
    if (!inWindow || this.unknown) return null;
    this.windowGain += gain;
    this.windowCost += basis;
    if (gain > 0n) this.wins++;
    else if (gain < 0n) this.losses++;
    if (this.best === null || gain > this.best) this.best = gain;
    return { timestamp: t.timestamp, wei: gain.toString() };
  }
  finish() {
    const position: Position = {
      poolId: this.poolId as `0x${string}`,
      trader: this.wallet as `0x${string}`,
      quantity: this.quantity.toString(),
      costWei: this.cost.toString(),
      realizedWei: this.unknown ? null : this.lifetimeGain.toString(),
      investedWei: this.invested.toString(),
      proceedsWei: this.proceeds.toString(),
      buys: this.buys,
      sells: this.sells,
      flags: [...this.flags],
      realizations: [],
    };
    return {
      position,
      flags: [...this.flags],
      realizedWei: this.unknown ? null : this.windowGain.toString(),
      disposedCostWei: this.unknown ? null : this.windowCost.toString(),
      volumeWei: this.volume.toString(),
      netWei: this.net.toString(),
      tradeCount: this.count,
      wins: this.unknown ? 0 : this.wins,
      losses: this.unknown ? 0 : this.losses,
      bestWei: this.unknown ? null : (this.best?.toString() ?? null),
      last: this.last,
    };
  }
}
