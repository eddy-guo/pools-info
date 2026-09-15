"use client";
import Link from "next/link";
import styles from "./detail-design.module.css";
import { useState } from "react";
import {
  poolWindow,
  shortAddress,
  type AnalyticsPoolDetail,
  type ObservedMarket,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { useQuery } from "./state";
import { useLive } from "./live-provider";
import { AddressLabel, Change, Price, WatchButton } from "./ui";
import {
  Eth,
  Stat,
  Trades,
  Unavailable,
  explorer,
  useMarket,
  utc,
} from "./live-ui";
import { SkeletonLine, RowsSkeleton } from "./skeletons";
import { TradeStream } from "./trade-stream";
import { Candles } from "./candles";
import { AuditLeaderboard } from "./traders";
import { PoolImage } from "./pool-image";
import {
  ObservedPoolDetail,
  type ObservedPoolIdentity,
} from "./observed-pool-detail";
export function PoolDetail({ id }: { id: string }) {
  const { params } = useQuery();
  const {
    market: loadedMarket,
    snapshot: loadedSnapshot,
    error,
    loading,
    refresh,
    refreshing,
  } = useMarket(id, params.get("launch"));
  const { audits, snapshot: initialSnapshot } = useLive();
  const [preloadedIds] = useState(
    () => new Set(initialSnapshot.markets.map((market) => market.id)),
  );
  const saved = useProduct<{
    name: string;
    symbol: string;
    token: string;
    imageUrl?: string | null;
    pool?: {
      poolId: string;
      name: string;
      symbol: string;
      token: string;
      imageUrl?: string | null;
    };
    analytics: AnalyticsPoolDetail | null;
    market?: ObservedMarket;
  }>(`pools/${id}`);
  const savedIdentity = saved.data?.pool ?? saved.data;
  const publication = saved.data?.analytics;
  const publishedMarket = publication?.snapshot.markets.find(
    (m) => m.id === id && m.accounting?.executions,
  );
  const usePublished =
    publishedMarket &&
    (!loadedMarket?.accounting?.executions ||
      // useMarket already prefers its refreshed response at the same cutoff.
      // A matching publication must not replace that response with old data.
      publication!.snapshot.toBlock > loadedSnapshot.toBlock);
  const m = usePublished ? publishedMarket : loadedMarket;
  const s = usePublished ? publication!.snapshot : loadedSnapshot;
  const [tab, setTab] = useState("Top traders");
  if (!preloadedIds.has(id)) {
    const pool =
      savedIdentity || m
        ? {
            poolId: id,
            name: savedIdentity?.name ?? m?.name,
            symbol: savedIdentity?.symbol ?? m?.symbol,
            token: savedIdentity?.token ?? m?.token,
            imageUrl: savedIdentity?.imageUrl,
            launch:
              "launch" in (savedIdentity ?? {})
                ? (savedIdentity as ObservedPoolIdentity).launch
                : m
                  ? {
                      timestamp: m.launchedAt,
                      transactionHash: m.launchTx,
                      transactionInitiator: m.launchSender,
                    }
                  : undefined,
          }
        : undefined;
    return (
      <ObservedPoolDetail
        id={id}
        pool={pool}
        market={saved.data?.market}
        accountedMarket={m}
        snapshot={m ? s : undefined}
        publication={publication ?? undefined}
        audit={publication?.audit ?? audits[id]}
        refresh={() => {
          refresh();
          saved.refresh();
        }}
        loading={loading || saved.loading || refreshing}
        pending={!saved.data && !m && saved.loading}
        error={saved.error ?? (error || undefined)}
      />
    );
  }
  if (
    saved.data?.market &&
    saved.data.pool &&
    !m?.accounting?.executions &&
    !audits[id]
  )
    return (
      <ObservedPoolDetail
        id={id}
        pool={saved.data.pool as ObservedPoolIdentity}
        market={saved.data.market}
        refresh={saved.refresh}
        loading={saved.loading}
        error={saved.error}
      />
    );
  if (!m)
    return (
      <div className={`page ${styles.page}`}>
        <h1>
          {savedIdentity?.name ??
            (loading ? "Loading saved pool…" : "Pool outside current coverage")}
        </h1>
        <p>
          {saved.data && !saved.data.analytics
            ? "This verified launch is in the catalog. Its background analytics are still processing; no prices, holders or profit are estimated."
            : loading
              ? "Loading saved market data. No blockchain scan is started by this page."
              : error ||
                "Use a covered pool link to provide its verified launch transaction. This is a coverage limit, not proof that the pool does not exist."}
        </p>
        <Link className="button" href="/">
          Explore pools
        </Link>
        {saved.data && (
          <div className="live-section" style={{ maxWidth: 420 }}>
            <TradeStream poolId={id} />
          </div>
        )}
      </div>
    );
  const a = m.accounting?.executions
    ? {
        poolId: m.id,
        market: m,
        toBlock: s.toBlock,
        toTimestamp: s.toTimestamp,
        generatedAt: s.generatedAt,
        ...m.accounting,
        executions: m.accounting.executions,
      }
    : audits[m.id];
  const holders = saved.data?.analytics?.holders;
  const holderRows = holders?.balances ?? [];
  const sum = (rows: typeof holderRows) =>
    rows.reduce((n, h) => n + BigInt(h.balanceRaw), 0n);
  const users = holderRows.filter((h) => h.kind !== "infrastructure");
  const ratio = (numerator: bigint, denominator: bigint) =>
    denominator > 0n
      ? `${(Number((numerator * 10000n) / denominator) / 100).toFixed(2)}%`
      : null;
  const concentration = holders?.complete
    ? {
        raw: ratio(
          sum(holderRows.slice(0, 10)),
          BigInt(holders.totalSupplyRaw),
        ),
        adjusted: ratio(sum(users.slice(0, 10)), sum(users)),
      }
    : null;
  const stats = poolWindow(m, s, "24h"),
    fdv =
      m.priceWei === null
        ? null
        : (
            (BigInt(m.priceWei) * BigInt(m.supply)) /
            10n ** BigInt(m.decimals)
          ).toString();
  return (
    <div className={`page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Explore</Link>
        <span>/</span>
        <span>{m.symbol}</span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <PoolImage
            poolId={m.id}
            token={m.token}
            hasImage={!!savedIdentity?.imageUrl}
            size="large"
          />
          <div>
            <div className={styles.title}>
              <h1>{m.name}</h1>
              <span className={styles.symbol}>{m.symbol}</span>
              <span className={styles.mode}>INSTANT</span>
              {holders?.complete && a && (
                <span
                  className="evidence-badge"
                  title="Birth-contiguous token Transfer history reconciles with contract supply at the saved cutoff. Individual wallet exclusions still apply."
                >
                  Verified history
                </span>
              )}
            </div>
            <AddressLabel address={m.token} full />
            <div className={styles.meta}>
              Launched {utc(m.launchedAt)} · sender{" "}
              <Link href={`/creators/${m.launchSender.toLowerCase()}/`}>
                {shortAddress(m.launchSender)}
              </Link>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <WatchButton id={m.id} />
          <a
            className="button secondary"
            href={`${explorer}/token/${m.token}`}
            target="_blank"
            rel="noreferrer"
          >
            Explorer ↗
          </a>
          <a
            className="button"
            href={`https://pools.xyz/t/robinhood/${m.token}`}
            target="_blank"
            rel="noreferrer"
          >
            Trade on Pools ↗
          </a>
        </div>
      </div>
      <div className="live-controls">
        <button
          className="button secondary"
          onClick={() => {
            refresh();
            saved.refresh();
          }}
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
      <div className="workspace-grid">
        <div>
          <section className="panel">
            <div className={styles.context}>
              <strong>Price context</strong>
              <span>ETH · Robinhood Chain</span>
            </div>
            <div className={styles.chartHeader}>
              {" "}
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
            </div>
            <Candles market={m} snapshot={s} />
          </section>
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
              {saved.loading && !saved.data ? (
                <SkeletonLine width={48} height={24} />
              ) : holders?.complete ? (
                holders.positiveHoldersExcludingInfrastructure
              ) : (
                <Unavailable />
              )}
            </Stat>
            <Stat label="Fees compounded">
              <Unavailable />
            </Stat>
            <Stat
              label="Creator fee option"
              note="Derived from launch strategy"
            >
              {m.creatorFees ? "Enabled" : "Disabled"}
            </Stat>
          </div>

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
                <p className="panel-footnote">
                  Published trader positions load automatically. Unsupported
                  positions remain excluded.
                </p>
                {a ? (
                  <AuditLeaderboard audit={a} />
                ) : (
                  <p className="panel-footnote">
                    Run the audit to populate real trader positions for this
                    pool.
                  </p>
                )}
              </>
            ) : saved.loading && !saved.data ? (
              <RowsSkeleton label="Loading holder balances" />
            ) : holders ? (
              <>
                <p className="panel-footnote">
                  {holders.complete
                    ? "Reconciled holder snapshot"
                    : "Partial tracked balances"}{" "}
                  · block {holders.coverage.toBlock.toLocaleString()} ·
                  infrastructure shown separately. Balances do not establish
                  cost basis or PnL.
                </p>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Holder</th>
                        <th>Balance</th>
                        <th>Classification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holderRows.slice(0, 100).map((h) => (
                        <tr key={h.address}>
                          <td>
                            <Link
                              className="mono"
                              href={`/wallet/${h.address}/`}
                            >
                              {shortAddress(h.address)}
                            </Link>
                          </td>
                          <td>
                            {(
                              Number(h.balanceRaw) /
                              10 ** m.decimals
                            ).toLocaleString("en-US", {
                              maximumSignificantDigits: 8,
                            })}
                          </td>
                          <td>{h.infrastructureLabel ?? "Holder"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="panel-footnote">
                  Showing {Math.min(100, holderRows.length)} of{" "}
                  {holderRows.length} positive tracked balances.
                </p>
              </>
            ) : (
              <div className="empty-state">
                <h3>Holder snapshot is processing</h3>
                <p>
                  Holders are published by the background collector. This page
                  does not scan transfers on demand.
                </p>
              </div>
            )}
          </section>
        </div>
        <aside className="market-sidebar">
          <TradeStream poolId={m.id} />
          <section className="panel">
            <div className="panel-heading">
              <h2>Concentration</h2>
            </div>
            <dl className="live-facts">
              {["Raw top 10", "Adjusted top 10", "Gini"].map((label) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {label === "Raw top 10" ? (
                      (concentration?.raw ?? <Unavailable />)
                    ) : label === "Adjusted top 10" ? (
                      (concentration?.adjusted ?? <Unavailable />)
                    ) : (
                      <Unavailable />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="panel-footnote">
              Adjusted concentration excludes labelled infrastructure balances,
              including the v4 PoolManager. These figures need a reconciled
              holder snapshot.
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
