"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChainMarket, ChainSnapshot, PoolAudit } from "@pools/core";
import { useLiveChain } from "@/lib/use-live-chain";

type LiveState = ReturnType<typeof useLiveChain> & {
  audits: Record<string, PoolAudit>;
  auditErrors: Record<string, string>;
  auditing: Record<string, boolean>;
  audit: (market: ChainMarket) => Promise<void>;
};
const Context = createContext<LiveState | null>(null);
export function LiveProvider({
  initial,
  children,
}: {
  initial: ChainSnapshot;
  children: React.ReactNode;
}) {
  const live = useLiveChain(initial);
  const [audits, setAudits] = useState<Record<string, PoolAudit>>(() =>
    Object.fromEntries(
      initial.markets
        .filter((m) => m.accounting?.executions)
        .map((m) => [
          m.id,
          {
            poolId: m.id,
            market: m,
            toBlock: initial.toBlock,
            toTimestamp: initial.toTimestamp,
            generatedAt: initial.generatedAt,
            ...m.accounting!,
            executions: m.accounting!.executions!,
          },
        ]),
    ),
  );
  const [auditErrors, setErrors] = useState<Record<string, string>>({});
  const [auditing, setAuditing] = useState<Record<string, boolean>>({});
  const requests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const active = requests.current;
    return () => {
      for (const c of active.values()) c.abort();
    };
  }, []);
  async function audit(market: ChainMarket) {
    if (requests.current.has(market.id)) return;
    const controller = new AbortController();
    requests.current.set(market.id, controller);
    setAuditing((p) => ({ ...p, [market.id]: true }));
    setErrors((p) => ({ ...p, [market.id]: "" }));
    try {
      const response = await fetch(
        `/api/markets/${market.id}/accounting/?launch=${market.launchTx}`,
        {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(230000),
          ]),
        },
      );
      if (!response.ok)
        throw Error(
          "Audit unavailable. Provider limits or coverage may prevent this pool from completing. Try again later.",
        );
      const data: PoolAudit = await response.json();
      if (
        data.poolId !== market.id ||
        !Array.isArray(data.wallets) ||
        !Array.isArray(data.executions) ||
        !data.market ||
        data.market.id !== market.id ||
        !Number.isSafeInteger(data.toBlock) ||
        !Number.isSafeInteger(data.toTimestamp)
      )
        throw Error("Invalid audit response");
      if (!controller.signal.aborted)
        setAudits((p) => ({ ...p, [market.id]: data }));
    } catch (error) {
      if (!controller.signal.aborted)
        setErrors((p) => ({
          ...p,
          [market.id]: error instanceof Error ? error.message : "Audit failed",
        }));
    } finally {
      requests.current.delete(market.id);
      if (!controller.signal.aborted)
        setAuditing((p) => ({ ...p, [market.id]: false }));
    }
  }
  return (
    <Context value={{ ...live, audits, auditErrors, auditing, audit }}>
      {children}
    </Context>
  );
}
export function useLive() {
  const state = useContext(Context);
  if (!state) throw Error("Missing live provider");
  return state;
}
export function Freshness() {
  const { snapshot: s, status, enabled, setEnabled, refresh } = useLive();
  const labels: Record<string, string> = {
    checking: "Checking for updates",
    current: "Automatic updates active",
    delayed: "Updates delayed - showing last captured data",
    paused: "Updates paused",
  };
  return (
    <div className={`live-freshness ${status === "delayed" ? "stale" : ""}`}>
      <div>
        <strong role="status">{labels[status]}</strong>
        <span>
          Block {s.toBlock.toLocaleString("en-US")} · Captured{" "}
          {new Date(s.generatedAt).toISOString().slice(0, 19).replace("T", " ")}{" "}
          UTC · {s.markets.length} recent pools
        </span>
      </div>
      <div>
        <button
          className="button secondary"
          onClick={() => setEnabled(!enabled)}
        >
          {enabled ? "Pause updates" : "Resume updates"}
        </button>
        <button className="button secondary" onClick={refresh}>
          Check now
        </button>
      </div>
    </div>
  );
}
