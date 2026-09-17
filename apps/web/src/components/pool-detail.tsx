"use client";
import Link from "next/link";
import styles from "./detail-design.module.css";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  poolWindow,
  shortAddress,
  type AnalyticsPoolDetail,
  type ObservedMarket,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import { useRememberedPoolRow } from "@/lib/pool-row-memory";
import { useQuery } from "./state";
import { useLive } from "./live-provider";
import { WatchButton } from "./ui";
import { Eth, Stat, Trades, Unavailable, explorer, useMarket } from "./live-ui";
import { RowsSkeleton } from "./skeletons";
import { TradeStream } from "./trade-stream";
import { Candles, type ChartRange } from "./candles";
import { AuditLeaderboard } from "./traders";
import {
  ObservedPoolDetail,
  PoolChartHead,
  PoolHeading,
  windowChanges,
  type ObservedPoolIdentity,
} from "./observed-pool-detail";
/** `renderedAt` is the server's clock at render, the basis of the launch age. */
export function PoolDetail({
  id,
  renderedAt,
}: {
  id: string;
  renderedAt: number;
}) {
  const { params } = useQuery();
  const {
    market: loadedMarket,
    snapshot: loadedSnapshot,
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
  const remembered = useRememberedPoolRow(id);
  /* Hydration paints the server's markup, which never sees a remembered row, so
     only an arrival from a row can size the chart region before the first
     paint. Reading it once keeps that region's height fixed from then on. */
  const [expectChart] = useState(() => remembered?.measured !== false);
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
  const [range, setRange] = useState<ChartRange>("All");
  if (!preloadedIds.has(id)) {
    const pool =
      savedIdentity || m || remembered
        ? {
            poolId: id,
            name: savedIdentity?.name ?? m?.name ?? remembered?.name,
            symbol: savedIdentity?.symbol ?? m?.symbol ?? remembered?.symbol,
            token: savedIdentity?.token ?? m?.token ?? remembered?.token,
            imageUrl: savedIdentity?.imageUrl ?? remembered?.imageUrl,
            launch:
              "launch" in (savedIdentity ?? {})
                ? (savedIdentity as ObservedPoolIdentity).launch
                : m
                  ? {
                      timestamp: m.launchedAt,
                      transactionHash: m.launchTx,
                      transactionInitiator: m.launchSender,
                    }
                  : remembered?.launch,
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
        chart={expectChart}
        audit={publication?.audit ?? audits[id]}
        refresh={() => {
          refresh();
          saved.refresh();
        }}
        loading={loading || saved.loading || refreshing}
        pending={!saved.data && !m && saved.loading}
        renderedAt={renderedAt}
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
        renderedAt={renderedAt}
      />
    );
  if (!m)
    return (
      <div className={`page ${styles.page}`}>
        <h1>
          {savedIdentity?.name ??
            remembered?.name ??
            (loading ? "Loading saved pool…" : "Pool name unavailable")}
        </h1>
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
    <div className={`page pool-page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Pools</Link>
        <span>/</span>
        <span>{m.symbol}</span>
      </nav>
      <PoolHeading
        id={m.id}
        pool={{
          poolId: m.id,
          name: m.name,
          symbol: m.symbol,
          token: m.token,
          imageUrl: savedIdentity?.imageUrl,
          launch: {
            timestamp: m.launchedAt,
            transactionHash: m.launchTx,
            transactionInitiator: m.launchSender,
          },
        }}
        renderedAt={renderedAt}
      >
        <WatchButton id={m.id} />
        <button
          className="icon-button"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => {
            refresh();
            saved.refresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw size={14} />
        </button>
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
      </PoolHeading>
      <div className="workspace-grid">
        <div>
          <section className="panel pool-chart-panel">
            <PoolChartHead
              price={m.priceWei}
              change={stats.change}
              windows={windowChanges(m, s, undefined)}
              range={range}
              onRange={setRange}
            />
            <div className="pool-chart-region" data-chart="reserved">
              <Candles range={range} market={m} snapshot={s} />
            </div>
          </section>
          <div className="stats-grid live-six-stats">
            <Stat label="FDV">
              <Eth wei={fdv} digits={5} />
            </Stat>
            <Stat label="Liquidity">
              <Unavailable />
            </Stat>
            <Stat
              label="Volume 24h"
              note={`${stats.trades.length.toLocaleString("en-US")} trades`}
            >
              <Eth wei={stats.volumeWei} digits={5} />
            </Stat>
            <Stat label="Holders" pending={saved.loading && !saved.data}>
              {holders?.complete ? (
                holders.positiveHoldersExcludingInfrastructure.toLocaleString(
                  "en-US",
                )
              ) : saved.loading && !saved.data ? null : (
                <Unavailable />
              )}
            </Stat>
            <Stat label="Fees compounded">
              <Unavailable />
            </Stat>
            <Stat label="Creator fee">
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
              a ? (
                <AuditLeaderboard audit={a} />
              ) : (
                <div className="empty-state">
                  <h3>Trader PnL unavailable</h3>
                </div>
              )
            ) : saved.loading && !saved.data ? (
              <RowsSkeleton label="Loading holder balances" />
            ) : holders ? (
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
                          <Link className="mono" href={`/wallet/${h.address}/`}>
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
            ) : (
              <div className="empty-state">
                <h3>Holder accounting unavailable</h3>
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
