"use client";
import { useEffect, useRef, useState } from "react";
import { shortAddress, type ChainMarket, type ChainWallet } from "@pools/core";

interface Audit {
  poolId: string;
  toBlock: number;
  toTimestamp: number;
  wallets: ChainWallet[];
  unattributedSwaps: number;
  transfersChecked: number;
}
const reasons: Record<string, string> = {
  contract_sender: "Sender has contract code",
  unsupported_route: "Unsupported router or call path",
  multiple_swap_route: "Multiple swap legs in the transaction",
  token_flow_mismatch: "Token flow does not reconcile to sender",
  unverified_token_birth: "Token creation is outside verified coverage",
  unmatched_transfer: "Transfer with unknown cost or destination basis",
  balance_mismatch: "Transfer ledger differs from on-chain balance",
  inventory_mismatch: "Swap inventory differs from token ledger",
  unknown_basis: "Sale has missing inventory cost",
  no_supported_swaps: "No supported direct swaps",
};
const eth = (wei: string) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(
    Number(wei) / 1e18,
  );
export function PoolAccounting({
  market,
  toBlock,
  toTimestamp,
}: {
  market: ChainMarket;
  toBlock: number;
  toTimestamp: number;
}) {
  const [audit, setAudit] = useState<Audit | null>(
    market.accounting
      ? { poolId: market.id, toBlock, toTimestamp, ...market.accounting }
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qualified, setQualified] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/markets/${market.id}/accounting/`, {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(200000),
        ]),
      });
      if (!response.ok)
        throw Error(
          "Audit is unavailable for this pool right now. Try again later.",
        );
      const data = (await response.json()) as Audit;
      if (
        data.poolId !== market.id ||
        !Array.isArray(data.wallets) ||
        !Number.isSafeInteger(data.toBlock) ||
        !Number.isSafeInteger(data.toTimestamp) ||
        data.toTimestamp < 0 ||
        data.toTimestamp > 8640000000000 ||
        !Number.isSafeInteger(data.transfersChecked) ||
        !Number.isSafeInteger(data.unattributedSwaps) ||
        !data.wallets.every(
          (w) =>
            w &&
            /^0x[0-9a-f]{40}$/i.test(w.address) &&
            /^0x[0-9a-f]{64}$/i.test(w.evidenceTx) &&
            [w.swaps, w.buys, w.sells].every(
              (n) => Number.isSafeInteger(n) && n >= 0,
            ) &&
            (w.realizedWei === null || /^-?\d+$/.test(w.realizedWei)) &&
            typeof w.balanceMatches === "boolean" &&
            typeof w.eligible === "boolean" &&
            Array.isArray(w.flags) &&
            w.flags.every((f) => typeof f === "string"),
        )
      )
        throw Error("Invalid audit response");
      if (!controller.signal.aborted) setAudit(data);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : "Audit unavailable");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const rows = audit?.wallets.filter((w) => !qualified || w.eligible) ?? [];
  return (
    <section className="panel chain-audit">
      <div className="panel-heading">
        <h2>Trader audit · {market.symbol}</h2>
        <button className="button" disabled={loading} onClick={load}>
          {loading ? "Auditing…" : audit ? "Refresh audit" : "Audit traders"}
        </button>
      </div>
      <div className="chain-audit-intro">
        <p>
          Gross realized swap PnL before gas, for this pool only. Direct router
          swaps must match token transfers; unexplained transfers and missing
          cost basis exclude a result. This measures pool execution, not total
          wallet returns or the final ETH recipient.
        </p>
        {audit ? (
          <p>
            Audited through block {audit.toBlock.toLocaleString("en-US")} ·{" "}
            {new Date(audit.toTimestamp * 1000)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19)}{" "}
            UTC. {audit.transfersChecked} token transfers checked;{" "}
            {audit.unattributedSwaps} swap legs have unsupported attribution.
          </p>
        ) : (
          <p>
            Run an audit to check transactions and balances from token creation.
            Busy pools can take a couple of minutes. Market updates continue
            separately.
          </p>
        )}
        {loading && (
          <p role="status">
            Reconciling transactions, token transfers, and balances…
          </p>
        )}
        {error && (
          <p role="status" className="negative">
            {error}
            {audit ? " The previous audit remains visible." : ""}
          </p>
        )}
        {audit && (
          <label className="chain-audit-filter">
            <input
              type="checkbox"
              checked={qualified}
              onChange={(e) => setQualified(e.target.checked)}
            />{" "}
            Only complete positions with 10+ swaps
          </label>
        )}
      </div>
      {audit && (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Transaction sender</th>
                  <th>Swaps</th>
                  <th>Gross realized (ETH)</th>
                  <th>Balance check</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((w) => (
                  <tr key={w.address}>
                    <td>
                      <a
                        className="mono"
                        href={`https://robinhoodchain.blockscout.com/address/${w.address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(w.address)} ↗
                      </a>
                    </td>
                    <td>
                      {w.swaps}
                      <small className="cell-sub">
                        {w.buys} buys · {w.sells} sells
                      </small>
                    </td>
                    <td
                      className={
                        w.realizedWei === null
                          ? ""
                          : BigInt(w.realizedWei) < 0n
                            ? "negative"
                            : "positive"
                      }
                    >
                      {w.realizedWei === null ? "Excluded" : eth(w.realizedWei)}
                    </td>
                    <td>{w.balanceMatches ? "Reconciled" : "Mismatch"}</td>
                    <td>
                      {w.flags.length ? (
                        <details className="chain-exclusions">
                          <summary>Why excluded</summary>
                          <ul>
                            {w.flags.map((flag) => (
                              <li key={flag}>{reasons[flag] ?? flag}</li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <span>
                          {w.eligible
                            ? "10+ swaps · complete"
                            : "Complete · fewer than 10 swaps"}
                        </span>
                      )}
                      <a
                        className="chain-audit-evidence"
                        href={`https://robinhoodchain.blockscout.com/tx/${w.evidenceTx}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Inspect trade ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <div className="empty-state">
              <h3>No qualifying positions in this sample</h3>
              <p>
                Coverage requirements stay in place even when the result is
                empty.
              </p>
            </div>
          )}
          {rows.length > 20 && (
            <p className="panel-footnote">
              Showing the first 20 of {rows.length} audited senders.
            </p>
          )}
        </>
      )}
    </section>
  );
}
