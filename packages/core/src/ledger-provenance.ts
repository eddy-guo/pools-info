import {
  ledgerZeroAddress,
  type LedgerBatchRows,
  type LedgerEvent,
  type LedgerTransfer,
} from "./ledger";

/** Address roles describe evidence, never ownership, basis or eligibility.
 * Classification uses only intrinsic Transfer facts and the supplied fixed
 * registry. Every other endpoint is unregistered: it may be a wallet, wrapper
 * or farm, and distinguishing those is separate future attribution work. */
export type TransferAddressClass =
  | "mint_burn"
  | "token_contract"
  | "launcher"
  | "wrapper_or_router"
  | "wrapper"
  | "farm"
  | "protocol"
  | "unregistered";
export interface TransferAddressRole {
  class: TransferAddressClass;
  evidence: string;
}
export interface TransferProtocolRole extends TransferAddressRole {
  address: string;
  fromBlock: number;
  throughBlock?: number | null;
}
export interface LedgerTransferProvenance extends LedgerTransfer {
  poolId: string;
  context: "residual" | "unattributed_swap";
  fromRole: TransferAddressRole;
  toRole: TransferAddressRole;
}

/** Keep the observed graph of a token transaction with an unexplained effect.
 * These are GROSS log amounts, not a claimed allocation of the residual to a
 * counterparty. Retain pass-through and self legs too: netting them again would
 * erase precisely the wrapper evidence this record is meant to preserve.
 * Call with the same validated rows and plan used by applyLedgerEvents. */
export function ledgerTransferProvenance(
  rows: LedgerBatchRows,
  events: readonly LedgerEvent[],
  protocols: readonly TransferProtocolRole[],
): LedgerTransferProvenance[] {
  const key = (tx: string, pool: string) =>
    `${tx.toLowerCase()}:${pool.toLowerCase()}`;
  const contexts = new Map<string, LedgerTransferProvenance["context"]>();
  for (const e of events) {
    if (e.kind === "swap") continue;
    contexts.set(
      key(e.txHash, e.poolId),
      e.kind === "unattributed_swap" ? "unattributed_swap" : "residual",
    );
  }
  const registry = new Map(
    rows.registry.map((p) => [p.token.toLowerCase(), p.poolId.toLowerCase()]),
  );
  const known = new Map<string, TransferProtocolRole[]>();
  for (const role of protocols) {
    const address = role.address.toLowerCase();
    known.set(address, [...(known.get(address) ?? []), role]);
  }
  const role = (
    address: string,
    token: string,
    poolId: string,
    block: number,
  ): TransferAddressRole => {
    if (address === ledgerZeroAddress)
      return { class: "mint_burn", evidence: "erc20:zero-address" };
    if (address === token)
      return { class: "token_contract", evidence: "transfer:emitting-token" };
    const protocol = known
      .get(address)
      ?.find(
        (r) =>
          block >= r.fromBlock &&
          (r.throughBlock == null || block <= r.throughBlock),
      );
    if (protocol) return { class: protocol.class, evidence: protocol.evidence };
    return { class: "unregistered", evidence: "registry:unregistered" };
  };
  return rows.transfers
    .flatMap((t) => {
      const token = t.token.toLowerCase();
      const poolId = registry.get(token);
      const context = poolId && contexts.get(key(t.txHash, poolId));
      if (!poolId || !context) return [];
      const from = t.from.toLowerCase(),
        to = t.to.toLowerCase();
      return [
        {
          ...t,
          token,
          from,
          to,
          txHash: t.txHash.toLowerCase(),
          blockHash: t.blockHash.toLowerCase(),
          poolId,
          context,
          fromRole: role(from, token, poolId, t.block),
          toRole: role(to, token, poolId, t.block),
        },
      ];
    })
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}
