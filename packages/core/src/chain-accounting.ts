import { foldTrades } from "./accounting";
import type { Trade } from "./types";
import type { ChainWallet } from "./chain-types";

export interface ObservedExecution {
  trade: Trade;
  flags: string[];
  matchedTransfer: string | null;
}
export interface TokenMovement {
  id: string;
  from: string;
  to: string;
  value: string;
}
// Only transaction senders are candidates. PoolManager/router balances are not
// invented wallets. Unsupported transfers invalidate basis conservatively.
export function reconcileWallets(
  executions: ObservedExecution[],
  movements: TokenMovement[],
  balances: Map<string, string>,
): ChainWallet[] {
  const addresses = [
    ...new Set(executions.map((e) => e.trade.trader.toLowerCase())),
  ];
  return addresses
    .map((address) => {
      const rows = executions.filter(
        (e) => e.trade.trader.toLowerCase() === address,
      );
      const flags = new Set(rows.flatMap((e) => e.flags));
      const supported = rows.filter((e) => !e.flags.length);
      const matched = new Set(supported.map((e) => e.matchedTransfer));
      let ledgerBalance = 0n;
      for (const movement of movements) {
        const amount = BigInt(movement.value);
        if (amount === 0n) continue;
        const incoming = movement.to.toLowerCase() === address;
        const outgoing = movement.from.toLowerCase() === address;
        if (incoming) ledgerBalance += amount;
        if (outgoing) ledgerBalance -= amount;
        if ((incoming || outgoing) && !matched.has(movement.id))
          flags.add("unmatched_transfer");
      }
      const balance = balances.get(address);
      const balanceMatches =
        balance !== undefined && ledgerBalance === BigInt(balance);
      if (!balanceMatches) flags.add("balance_mismatch");
      const position = supported.length
        ? foldTrades(supported.map((e) => e.trade))
        : null;
      for (const flag of position?.flags ?? []) flags.add(flag);
      if (!position) flags.add("no_supported_swaps");
      if (position && BigInt(position.quantity) !== ledgerBalance)
        flags.add("inventory_mismatch");
      const realizedWei = flags.size ? null : position!.realizedWei;
      return {
        address,
        swaps: rows.length,
        buys: rows.filter((e) => e.trade.side === "buy").length,
        sells: rows.filter((e) => e.trade.side === "sell").length,
        volumeWei: rows
          .reduce((n, e) => n + BigInt(e.trade.ethWei), 0n)
          .toString(),
        realizedWei,
        inventoryRaw: position?.quantity ?? "0",
        balanceRaw: balance ?? "0",
        balanceMatches,
        eligible: realizedWei !== null && supported.length >= 10,
        flags: [...flags],
        evidenceTx: rows.at(-1)!.trade.txHash,
      };
    })
    .sort((a, b) => {
      if (a.realizedWei === null)
        return b.realizedWei === null ? b.swaps - a.swaps : 1;
      if (b.realizedWei === null) return -1;
      return BigInt(a.realizedWei) > BigInt(b.realizedWei)
        ? -1
        : BigInt(a.realizedWei) < BigInt(b.realizedWei)
          ? 1
          : b.swaps - a.swaps;
    });
}
