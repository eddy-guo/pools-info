import type { LedgerSwap, LedgerTransfer, PricePoint } from "@pools/core";
import {
  ledgerRules,
  ledgerStream,
  type LedgerBatch,
} from "../../../packages/db/src/index";

// The ledger-served wallet reads are tested against positions the ledger's
// own writer folds and the windows it refreshes, so their fixture is trades
// applied through `applyLedgerBatch` and `refreshLedgerWindows`, and every
// expectation is derived by hand from those trades: average-cost basis,
// realized = proceeds - disposed cost, hour-aligned windows, a held position
// marked at the pool's latest sqrt price (2^192 / sqrt^2 wei per raw unit),
// and the realized curve as one point per hour with a sale, at the hour's
// end. Shared by `ledger-wallet.integration.test.ts` (the wallet page) and
// `ledger-position.integration.test.ts` (one position).
export const E = 10n ** 18n;
export const hash = (n: number | bigint): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}`;
export const addr = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, "0")}`;
export const base = ledgerStream.start;
/** 400 seconds per block, nine blocks to the hour, block `base` opening hour
 * 278: `blockOf(h, i)` is the i-th block of UTC hour h. */
export const ts = (block: number) => 278 * 3600 + (block - base) * 400;
export const blockOf = (hour: number, i: number) => base + (hour - 278) * 9 + i;
export const pools = {
  P: {
    id: hash(0x100),
    token: addr(0x200),
    name: "Pool P",
    symbol: "P",
    launchBlock: 10,
    launchTx: hash(101),
    launchSender: addr(0x201),
    launchedAt: 100,
    decimals: 18,
  },
  Q: {
    id: hash(0x101),
    token: addr(0x202),
    name: "Pool Q",
    symbol: "Q",
    launchBlock: 11,
    launchTx: hash(102),
    launchSender: addr(0x201),
    launchedAt: 100,
    decimals: 18,
  },
  // R's decimals are unknown: the pass never read them.
  R: {
    id: hash(0x102),
    token: addr(0x203),
    name: "Pool R",
    symbol: "R",
    launchBlock: 12,
    launchTx: hash(103),
    launchSender: addr(0x10001),
    launchedAt: 100,
  },
};
export const wallet = (n: number) => addr(0x10000 + n);
export const W = Object.fromEntries(
  [1, 2, 3, 4, 6, 7, 8, 9].map((n) => [n, wallet(n)]),
) as Record<number, `0x${string}`>;
export const WRAPPER = wallet(10);
/** A sqrt price of 2^68: 2^192 / 2^136 = 2^56 wei per raw unit. */
export const sqrtQ = (2n ** 68n).toString();

/** A batch's rows: each trade is a swap and its manager transfer in its own
 * transaction, initiated by the wallet through the router. */
export class Rows {
  swaps: LedgerSwap[] = [];
  transfers: LedgerTransfer[] = [];
  private logs = new Map<number, number>();
  trade(
    block: number,
    who: string,
    side: "buy" | "sell",
    eth: bigint,
    tokens: bigint,
    pool: (typeof pools)[keyof typeof pools] = pools.P,
    sqrtPriceX96 = "1000",
  ) {
    const i = this.logs.get(block) ?? 0;
    this.logs.set(block, i + 2);
    const site = {
      txHash: hash(BigInt(block) * 100000n + BigInt(i)),
      block,
      blockHash: hash(block),
      timestamp: ts(block),
    };
    this.swaps.push({
      ...site,
      logIndex: i,
      poolId: pool.id,
      token: pool.token,
      initiator: who,
      txTo: ledgerRules.router,
      side,
      ethWei: eth.toString(),
      tokenRaw: tokens.toString(),
      sqrtPriceX96,
      liquidity: "5",
      tick: 1,
    });
    this.transfers.push({
      ...site,
      logIndex: i + 1,
      token: pool.token,
      from: side === "buy" ? ledgerRules.manager : who,
      to: side === "buy" ? who : ledgerRules.manager,
      value: tokens.toString(),
    });
    return this;
  }
  /** `n` round trips in one block: buy 10 tokens for 1 ETH, sell them for
   * 1 ETH plus `gain` (negative for a loss), each closing a cycle held 0 s. */
  roundTrips(block: number, who: string, n: number, gain: bigint) {
    for (let i = 0; i < n; i++)
      this.trade(block, who, "buy", E, 10n).trade(
        block,
        who,
        "sell",
        E + gain,
        10n,
      );
    return this;
  }
  /** A plain transfer of P between wallets, no swap in its transaction. */
  move(block: number, from: string, to: string, tokens: bigint) {
    const i = this.logs.get(block) ?? 0;
    this.logs.set(block, i + 1);
    this.transfers.push({
      txHash: hash(BigInt(block) * 100000n + BigInt(i)),
      logIndex: i,
      block,
      blockHash: hash(block),
      timestamp: ts(block),
      token: pools.P.token,
      from,
      to,
      value: tokens.toString(),
    });
    return this;
  }
  /** One transfer transaction fans inventory out through a known wrapper while
   * preserving the receiver's exact net amount. The gross legs are what the
   * provenance table retains; the financial fold still sees only the net. */
  distribute(
    block: number,
    from: string,
    receiver: string,
    wrapper: string,
    tokens: bigint,
  ) {
    const i = this.logs.get(block) ?? 0,
      txHash = hash(BigInt(block) * 100000n + BigInt(i)),
      via = tokens / 2n,
      direct = tokens - via;
    this.logs.set(block, i + 3);
    const site = {
      txHash,
      block,
      blockHash: hash(block),
      timestamp: ts(block),
      token: pools.P.token,
    };
    this.transfers.push(
      { ...site, logIndex: i, from, to: receiver, value: direct.toString() },
      { ...site, logIndex: i + 1, from, to: wrapper, value: via.toString() },
      {
        ...site,
        logIndex: i + 2,
        from: wrapper,
        to: receiver,
        value: via.toString(),
      },
    );
    return this;
  }
}
export function batch(from: number, to: number, rows: Rows): LedgerBatch {
  return {
    from,
    to,
    parentHash: hash(from - 1),
    hash: hash(to),
    timestamp: ts(to),
    archiveHeight: to + ledgerStream.confirmations,
    registryPools: 3,
    query: { fixture: [from, to] },
    pages: [],
    requests: 1,
    bytes: 0,
    launches: [],
    swaps: rows.swaps,
    transfers: rows.transfers,
  };
}
export const normalized = (body: string) =>
  body.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"-"');
export const tenth = E / 10n;

/** The curve's point for hour `h`: its cumulative realized at the hour's
 * end, or at the cutoff when the hour is still open there. */
export const at = (hour: number, wei: bigint, asOf = Infinity): PricePoint => ({
  time: Math.min((hour + 1) * 3600, asOf),
  wei: wei.toString(),
});
