"use client";
import Link from "next/link";
import { useState } from "react";
import { poolWindow, shortAddress } from "@pools/core";
import { useQuery } from "./state";
import { useLive } from "./live-provider";
import { AddressLabel, Change, Price, WatchButton } from "./ui";
import {
  AuditAction,
  Eth,
  Stat,
  Trades,
  Unavailable,
  explorer,
  useMarket,
  utc,
} from "./live-ui";
import { TradeStream } from "./trade-stream";
import { Candles } from "./candles";
import { AuditLeaderboard } from "./traders";
export function PoolDetail({ id }: { id: string }) {
  const { params } = useQuery();
  const {
    market: m,
    snapshot: s,
    error,
    loading,
    refresh,
    refreshing,
  } = useMarket(id, params.get("launch"));
  const { audits } = useLive();
  const [tab, setTab] = useState("Trades");
  if (!m)
    return (
      <div className="page">
        <h1>{loading ? "Loading pool…" : "Pool outside current coverage"}</h1>
        <p>
          {loading
            ? "Reading the verified launch and swap history. This pool is outside the preloaded sample, so its first load can take longer. No metrics are estimated while it loads."
            : error ||
              "Use a covered pool link to provide its verified launch transaction. This is a coverage limit, not proof that the pool does not exist."}
        </p>
        <Link className="button" href="/">
          Explore pools
        </Link>
      </div>
    );
  const a = audits[m.id],
    stats = poolWindow(m, s, "24h"),
    fdv =
      m.priceWei === null
        ? null
        : (
            (BigInt(m.priceWei) * BigInt(m.supply)) /
            10n ** BigInt(m.decimals)
          ).toString();
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">INSTANT LAUNCH / ROBINHOOD CHAIN</div>
          <h1>
            {m.name}
            <span className="title-dot">.</span>
          </h1>
          <AddressLabel address={m.token} full />
          <p>
            Launch sender{" "}
            <Link href={`/creators/${m.launchSender.toLowerCase()}/`}>
              {shortAddress(m.launchSender)}
            </Link>{" "}
            · {utc(m.launchedAt)}
          </p>
        </div>
        <WatchButton id={m.id} />
      </div>
      <div className="live-price-heading">
        {m.priceWei ? (
          <Price wei={m.priceWei} />
        ) : (
          <Unavailable reason="No observed swap price" />
        )}
        <div className="live-changes">
          {(["1h", "6h", "24h", "7d"] as const).map((w) => {
            const v = poolWindow(m, s, w);
            return (
              <span key={w}>
                {w}{" "}
                {v.change === null ? (
                  <Unavailable />
                ) : (
                  <Change value={v.change} />
                )}
                <small>
                  {v.sinceLaunch ? "since first swap" : "at cutoff"}
                </small>
              </span>
            );
          })}
        </div>
      </div>
      <div className="live-controls">
        <button
          className="button secondary"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing pool…" : "Refresh pool data"}
        </button>
        {error && (
          <p role="status">
            Refresh unavailable. The captured pool data remains visible.
          </p>
        )}
      </div>
      <p className="page-intro-note">
        This pool’s market data is through block{" "}
        {s.toBlock.toLocaleString("en-US")} · {utc(s.toTimestamp)}. Audit
        results below have their own cutoff.
      </p>
      <div className="stats-grid live-six-stats">
        <Stat label="FDV" note="Spot price × contract total supply">
          <Eth wei={fdv} />
        </Stat>
        <Stat label="Liquidity">
          <Unavailable />
        </Stat>
        <Stat
          label="Observed 24h volume"
          note={
            stats.sinceLaunch
              ? "Pool launched within this window"
              : "Within covered history"
          }
        >
          <Eth wei={stats.volumeWei} />
        </Stat>
        <Stat label="Holders">
          <Unavailable />
        </Stat>
        <Stat label="Fees compounded">
          <Unavailable />
        </Stat>
        <Stat label="Creator fee option" note="Derived from launch strategy">
          {m.creatorFees ? "Enabled" : "Disabled"}
        </Stat>
      </div>
      <div className="workspace-grid">
        <div>
          <section className="panel">
            <Candles market={m} snapshot={s} />
          </section>
          <section className="panel live-section">
            <div className="table-tabs live-controls">
              {["Top traders", "Holders", "Trades"].map((t) => (
                <button
                  key={t}
                  className={t === tab ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "Trades" ? (
              <Trades
                trades={s.trades.filter((t) => t.poolId === m.id)}
                markets={[m]}
              />
            ) : tab === "Top traders" ? (
              <>
                <AuditAction market={m} />
                {a ? (
                  <AuditLeaderboard audit={a} />
                ) : (
                  <p className="panel-footnote">
                    Run the audit to populate real trader positions for this
                    pool.
                  </p>
                )}
              </>
            ) : (
              <div className="empty-state">
                <h3>Holder balances are not collected yet</h3>
                <p>
                  Swap counts cannot establish holder count or concentration.
                  Full token transfers and infrastructure exclusions are
                  required.
                </p>
              </div>
            )}
          </section>
        </div>
        <aside className="market-sidebar">
          <TradeStream markets={[m]} />
          <section className="panel">
            <div className="panel-heading">
              <h2>Concentration</h2>
            </div>
            <dl className="live-facts">
              {["Raw top 10", "Adjusted top 10", "Gini", "Risk score"].map(
                (label) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <Unavailable />
                    </dd>
                  </div>
                ),
              )}
            </dl>
            <p className="panel-footnote">
              The PoolManager must be treated separately from wallet holders. No
              concentration or risk score is inferred from swaps.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Launch facts</h2>
            </div>
            <dl className="live-facts">
              <div>
                <dt>Pool ID</dt>
                <dd className="mono">{m.id}</dd>
              </div>
              <div>
                <dt>Launcher</dt>
                <dd>
                  <a
                    href={`${explorer}/address/0x0000ffffbe8efe702c8703ae3477ff5de3d319c0`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    LiquidityLauncher ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt>LP fee</dt>
                <dd>{m.fee / 10000}%</dd>
              </div>
              <div>
                <dt>Hooks</dt>
                <dd>None · verified PoolKey</dd>
              </div>
              <div>
                <dt>Supply</dt>
                <dd>
                  {(Number(m.supply) / 10 ** m.decimals).toLocaleString(
                    "en-US",
                  )}
                </dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>{m.decimals}</dd>
              </div>
              <div>
                <dt>Position recipient</dt>
                <dd>
                  <a
                    className="mono"
                    href={`${explorer}/address/${m.positionRecipient}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(m.positionRecipient)} ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt>Permanent lock</dt>
                <dd>
                  <Unavailable reason="Recipient withdrawal behavior not independently verified by this collector" />
                </dd>
              </div>
            </dl>
            <a
              className="leader-link"
              href={`${explorer}/tx/${m.launchTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Launch transaction ↗
            </a>
          </section>
        </aside>
      </div>
    </div>
  );
}
