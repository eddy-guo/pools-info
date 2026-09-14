"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  shortAddress,
  type ChainSnapshot,
  type ChainMarket,
  type ChainTrade,
  type LiveWindow,
  windows,
  poolHref,
} from "@pools/core";
import { useLive } from "./live-provider";
import { useQuery } from "./state";
export const explorer = "https://robinhoodchain.blockscout.com";
export const utc = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ") +
  " UTC";
export function Eth({
  wei,
  signed = false,
}: {
  wei: string | null | undefined;
  signed?: boolean;
}) {
  if (wei === null || wei === undefined) return <Unavailable />;
  const n = Number(wei) / 1e18;
  return (
    <span
      className={`number ${signed ? (BigInt(wei) < 0n ? "negative" : BigInt(wei) > 0n ? "positive" : "muted") : ""}`}
      title={`${wei} wei`}
    >
      {signed && n > 0 ? "+" : ""}
      {new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(
        n,
      )}{" "}
      ETH
    </span>
  );
}
export function Unavailable({
  reason = "Not collected yet",
}: {
  reason?: string;
}) {
  return (
    <span
      className="muted unavailable"
      title={reason}
      aria-label={`Unavailable: ${reason}`}
    >
      N/A
    </span>
  );
}
export function Stat({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{children}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
export function WindowTabs({
  value,
  onChange,
  options = ["24h", "7d", "30d", "All"],
}: {
  value: LiveWindow;
  onChange: (w: LiveWindow) => void;
  options?: LiveWindow[];
}) {
  return (
    <div className="segmented" aria-label="Time window">
      {options.map((w) => (
        <button
          key={w}
          aria-pressed={value === w}
          className={value === w ? "selected" : ""}
          onClick={() => onChange(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
export function useWindow(fallback: LiveWindow = "All") {
  const { params, set } = useQuery();
  const raw = params.get("window");
  const window =
    raw && Object.hasOwn(windows, raw) ? (raw as LiveWindow) : fallback;
  return { window, setWindow: (w: LiveWindow) => set({ window: w }) };
}
export function useMarket(id?: string, launch?: string | null) {
  const { snapshot } = useLive();
  const [attempt, setAttempt] = useState({ id, count: 0 });
  const [extra, setExtra] = useState<ChainSnapshot | null>(null);
  const [request, setRequest] = useState({ id, pending: false, error: "" });
  const known = snapshot.markets.find((m) => m.id === id);
  const hasKnown = !!known;
  const refreshCount = attempt.id === id ? attempt.count : 0;
  useEffect(() => {
    if ((hasKnown && !refreshCount) || !id || !launch) return;
    const controller = new AbortController();
    // Defer the request state with the fetch so a cancelled effect cannot leave
    // the new route marked as loading or display the previous route's error.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setRequest({ id, pending: true, error: "" });
      try {
        const response = await fetch(
          `/api/markets/${id}/?launch=${launch}${refreshCount ? "&refresh=1" : ""}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(105000),
            ]),
          },
        );
        if (!response.ok)
          throw Error(
            "This pool could not be loaded within the current scan limits.",
          );
        const next: ChainSnapshot = await response.json();
        if (next.markets?.[0]?.id !== id) throw Error("Invalid pool response");
        if (!controller.signal.aborted) {
          setExtra(next);
          setRequest({ id, pending: false, error: "" });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setRequest({
            id,
            pending: false,
            error:
              error instanceof Error ? error.message : "Pool refresh failed",
          });
      }
    });
    return () => controller.abort();
  }, [hasKnown, id, launch, refreshCount]);
  const fetched = extra?.markets.find((m) => m.id === id);
  const newer = fetched && (!known || extra!.toBlock >= snapshot.toBlock);
  const error = request.id === id ? request.error : "";
  const refreshing = request.id === id && request.pending;
  return {
    market: newer ? fetched : known,
    snapshot: newer ? extra! : snapshot,
    refresh: () => {
      if (!refreshing) setAttempt({ id, count: refreshCount + 1 });
    },
    refreshing,
    error,
    loading: !known && !fetched && !!launch && !error,
  };
}

export function PoolPicker() {
  const { snapshot, audits } = useLive();
  const [initialMarket] = useState(snapshot.markets[0]);
  const { params, set } = useQuery();
  const pool = params.get("pool") ?? initialMarket?.id;
  const options = [
    ...snapshot.markets,
    initialMarket,
    ...Object.values(audits).map((a) => a.market),
  ].filter((m, i, all) => all.findIndex((p) => p.id === m.id) === i);
  return (
    <label className="live-pool-picker">
      Audit scope
      <select
        aria-label="Audit pool"
        value={pool}
        onChange={(e) => {
          const m = options.find((m) => m.id === e.target.value)!;
          set({ pool: m.id, launch: m.launchTx });
        }}
      >
        {!options.some((m) => m.id === pool) && (
          <option value={pool}>Linked pool</option>
        )}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.symbol} · {shortAddress(m.token)}
          </option>
        ))}
      </select>
    </label>
  );
}
export function useSelectedMarket() {
  const { snapshot } = useLive();
  const [initialMarket] = useState(snapshot.markets[0]);
  const { params } = useQuery();
  return useMarket(
    params.get("pool") ?? initialMarket?.id,
    params.get("launch") ??
      (!params.get("pool") ? initialMarket?.launchTx : null),
  );
}
export function AuditAction({ market }: { market: ChainMarket }) {
  const { audit, audits, auditErrors, auditing } = useLive();
  const a = audits[market.id];
  return (
    <div className="audit-action">
      <button
        className="button"
        disabled={auditing[market.id]}
        onClick={() => void audit(market)}
      >
        {auditing[market.id]
          ? "Auditing…"
          : a
            ? "Refresh audit"
            : "Audit traders"}
      </button>
      {auditing[market.id] && (
        <p role="status">
          Checking receipts, token transfers and balances. Busy pools can take a
          few minutes.
        </p>
      )}
      {auditErrors[market.id] && (
        <p role="status" className="negative">
          {auditErrors[market.id]}
          {a ? " The previous audit remains visible." : ""}
        </p>
      )}
      {a && (
        <p>
          Audited through block {a.toBlock.toLocaleString("en-US")} ·{" "}
          {utc(a.toTimestamp)}. {a.transfersChecked} transfers checked;{" "}
          {a.unattributedSwaps} unsupported swap legs.
        </p>
      )}
    </div>
  );
}
export function Trades({
  trades,
  markets,
}: {
  trades: ChainTrade[];
  markets: ChainMarket[];
}) {
  const [page, setPage] = useState(1);
  const size = 20;
  const pages = Math.max(1, Math.ceil(trades.length / size));
  const current = Math.min(page, pages);
  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Token</th>
              <th>Side</th>
              <th>Token amount</th>
              <th>ETH amount</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice((current - 1) * size, current * size).map((t) => {
              const m = markets.find((m) => m.id === t.poolId);
              return (
                <tr key={`${t.txHash}:${t.logIndex}`}>
                  <td>{utc(t.timestamp).replace(" UTC", "")}</td>
                  <td>
                    {m ? (
                      <Link href={poolHref(m)}>{m.symbol}</Link>
                    ) : (
                      shortAddress(t.poolId)
                    )}
                  </td>
                  <td className={t.side === "buy" ? "positive" : "negative"}>
                    {t.side}
                  </td>
                  <td>
                    {m
                      ? new Intl.NumberFormat("en-US", {
                          maximumSignificantDigits: 6,
                        }).format(Number(t.tokenRaw) / 10 ** m.decimals)
                      : t.tokenRaw}
                  </td>
                  <td>
                    <Eth wei={t.ethWei} />
                  </td>
                  <td>
                    <a
                      className="mono"
                      href={`${explorer}/tx/${t.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddress(t.txHash)} ↗
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!trades.length && (
        <div className="empty-state">
          <h3>No observed swaps in this window</h3>
        </div>
      )}
      <div className="pagination">
        <span>{trades.length} swap events</span>
        <button
          className="button secondary"
          disabled={current <= 1}
          onClick={() => setPage(current - 1)}
        >
          Previous
        </button>
        <span>
          {current} / {pages}
        </span>
        <button
          className="button secondary"
          disabled={current >= pages}
          onClick={() => setPage(current + 1)}
        >
          Next
        </button>
      </div>
    </>
  );
}
