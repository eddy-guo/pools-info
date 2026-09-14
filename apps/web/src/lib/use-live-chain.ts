"use client";
import { useEffect, useState } from "react";
import type { ChainSnapshot } from "@pools/core";

function validSnapshot(value: unknown): value is ChainSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as ChainSnapshot;
  return (
    s.schemaVersion === 1 &&
    s.chainId === 4663 &&
    Number.isFinite(Date.parse(s.generatedAt)) &&
    Number.isSafeInteger(s.toBlock) &&
    Number.isSafeInteger(s.fromBlock) &&
    s.fromBlock <= s.toBlock &&
    Number.isFinite(s.toTimestamp) &&
    Array.isArray(s.markets) &&
    s.markets.length > 0 &&
    s.markets.every(
      (p) =>
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.symbol === "string" &&
        /^\d+$/.test(p.volumeWei) &&
        (p.priceWei === null || /^\d+$/.test(p.priceWei)) &&
        Array.isArray(p.series),
    ) &&
    Array.isArray(s.trades) &&
    s.trades.every(
      (t) => s.markets.some((p) => p.id === t.poolId) && /^\d+$/.test(t.ethWei),
    )
  );
}
export function useLiveChain(initial: ChainSnapshot) {
  const [snapshot, setSnapshot] = useState(initial);
  const [enabled, setEnabled] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"checking" | "current" | "delayed">(
    "checking",
  );
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    tick();
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    async function update() {
      if (busy || controller.signal.aborted) return;
      if (document.hidden) {
        timer = setTimeout(update, 60000);
        return;
      }
      busy = true;
      try {
        const response = await fetch("/api/markets/", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(105000),
          ]),
        });
        if (!response.ok) throw Error("Source unavailable");
        const next: unknown = await response.json();
        if (!validSnapshot(next)) throw Error("Invalid snapshot");
        if (!controller.signal.aborted) {
          setSnapshot((prior) =>
            Date.parse(next.generatedAt) >= Date.parse(prior.generatedAt)
              ? next
              : prior,
          );
          setStatus("current");
        }
      } catch {
        if (!controller.signal.aborted) setStatus("delayed");
      } finally {
        busy = false;
        if (!controller.signal.aborted) timer = setTimeout(update, 60000);
      }
    }
    function visible() {
      if (!document.hidden && !busy) {
        clearTimeout(timer);
        void update();
      }
    }
    document.addEventListener("visibilitychange", visible);
    void update();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, attempt]);
  const old = clock > 0 && clock - snapshot.toTimestamp * 1000 > 5 * 60000;
  return {
    snapshot,
    enabled,
    setEnabled,
    refresh: () => {
      setEnabled(true);
      setStatus("checking");
      setAttempt((a) => a + 1);
    },
    status: !enabled
      ? "paused"
      : old || status === "delayed"
        ? "delayed"
        : status,
  };
}
