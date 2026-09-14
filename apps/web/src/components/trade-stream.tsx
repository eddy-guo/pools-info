"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shortAddress, walletHref, type ChainMarket } from "@pools/core";
import type { RecentSwap, RecentSwaps } from "@pools/chain";
import { Eth, explorer, utc } from "./live-ui";
export function TradeStream({ markets }: { markets: ChainMarket[] }) {
  const ids = markets
    .slice(0, 8)
    .map((m) => m.id.toLowerCase())
    .sort()
    .join(",");
  const [enabled, setEnabled] = useState(true),
    [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    ids: string;
    events: RecentSwap[];
    data?: RecentSwaps;
    status: "loading" | "ready" | "delayed";
  }>({ ids, events: [], status: "loading" });
  const current = state.ids === ids ? state : undefined;
  useEffect(() => {
    if (!enabled || !ids) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (controller.signal.aborted) return;
      if (document.hidden) {
        timer = setTimeout(tick, 15000);
        return;
      }
      try {
        const response = await fetch(
          `/api/trades/?pools=${encodeURIComponent(ids)}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(18000),
            ]),
            cache: "no-store",
          },
        );
        if (!response.ok) throw Error("Unavailable");
        const data: RecentSwaps = await response.json();
        if (
          !Array.isArray(data.events) ||
          !Number.isSafeInteger(data.fromBlock) ||
          !Number.isSafeInteger(data.toBlock) ||
          data.fromBlock > data.toBlock ||
          !Number.isFinite(data.toTimestamp) ||
          !data.events.every(
            (e) =>
              ids.split(",").includes(e.poolId.toLowerCase()) &&
              /^0x[0-9a-f]{64}$/i.test(e.txHash) &&
              /^-?\d+$/.test(e.amount0) &&
              /^-?\d+$/.test(e.amount1) &&
              Number.isSafeInteger(e.logIndex) &&
              e.block >= data.fromBlock &&
              e.block <= data.toBlock,
          )
        )
          throw Error("Invalid events");
        if (!controller.signal.aborted)
          setState((previous) => {
            if (
              previous.ids === ids &&
              previous.data &&
              previous.data.toBlock > data.toBlock
            )
              return previous;
            const retained =
              previous.ids === ids
                ? previous.events.filter((e) => e.block < data.fromBlock)
                : [];
            const all = new Map(
              [...retained, ...data.events].map((e) => [
                `${e.txHash}:${e.logIndex}`,
                e,
              ]),
            );
            return {
              ids,
              events: [...all.values()]
                .sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)
                .slice(0, 100),
              data,
              status:
                Date.now() / 1000 - data.toTimestamp > 180
                  ? "delayed"
                  : "ready",
            };
          });
      } catch {
        if (!controller.signal.aborted)
          setState((previous) =>
            previous.ids === ids
              ? { ...previous, status: "delayed" }
              : { ids, events: [], status: "delayed" },
          );
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(tick, 15000);
      }
    }
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [ids, enabled, attempt]);
  return (
    <section className="panel trade-stream">
      <div className="panel-heading">
        <h2>Live trades</h2>
        <button className="text-button" onClick={() => setEnabled((v) => !v)}>
          {enabled ? "Pause feed" : "Resume feed"}
        </button>
      </div>
      <div className="feed-status" role="status">
        <span
          className={current?.status === "ready" && enabled ? "positive" : ""}
        >
          {!enabled
            ? "Paused"
            : current?.status === "ready"
              ? "Checking for new swaps every 15s"
              : current?.status === "delayed"
                ? "Updates delayed · last events retained"
                : "Loading recent swaps…"}
        </span>
        {current?.status === "delayed" && (
          <button
            className="text-button"
            onClick={() => {
              setEnabled(true);
              setAttempt((v) => v + 1);
            }}
          >
            Retry feed
          </button>
        )}
      </div>
      <div className="activity-list">
        {current?.events.slice(0, 12).map((t) => {
          const m = markets.find(
            (m) => m.id.toLowerCase() === t.poolId.toLowerCase(),
          );
          if (!m) return null;
          const buy = BigInt(t.amount0) < 0n;
          return (
            <div className="stream-event" key={`${t.txHash}:${t.logIndex}`}>
              <div>
                <Link href={`/pool/${m.id}/?launch=${m.launchTx}`}>
                  <strong>{m.symbol}</strong>
                </Link>
                <span className={buy ? "positive" : "negative"}>
                  {buy ? "Buy" : "Sell"}
                </span>
                <Eth
                  wei={(BigInt(t.amount0) < 0n
                    ? -BigInt(t.amount0)
                    : BigInt(t.amount0)
                  ).toString()}
                />
              </div>
              <div>
                <span>
                  Tx sender{" "}
                  {t.transactionSender ? (
                    <Link
                      className="mono"
                      href={walletHref(t.transactionSender, m)}
                    >
                      {shortAddress(t.transactionSender)}
                    </Link>
                  ) : (
                    "unavailable"
                  )}
                </span>
                <a
                  href={`${explorer}/tx/${t.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {utc(t.timestamp).slice(11, 19)} UTC ↗
                </a>
              </div>
            </div>
          );
        })}
      </div>
      {current?.status === "ready" && !current.events.length && (
        <p className="panel-footnote">
          No swaps for these pools in the latest checked blocks. The feed is
          still checking.
        </p>
      )}
      <p className="panel-footnote">
        Up to 8 loaded pools · newest 50 events per check · 128-block safety
        lag, not L1 finality. Transaction sender may differ from the trader.{" "}
        {current?.data &&
          `Checked through block ${current.data.toBlock.toLocaleString("en-US")} · ${utc(current.data.toTimestamp)}. `}
        {current?.data?.truncated && "Busy window: some events omitted. "}This
        feed is not a complete trade history.
      </p>
    </section>
  );
}
