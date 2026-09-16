"use client";
import Link from "next/link";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  poolWindow,
  shortAddress,
  type AnalyticsPoolDetail,
  type ChainMarket,
  type ChainSnapshot,
  type ObservedMarket,
  type PoolAudit,
} from "@pools/core";
import styles from "./detail-design.module.css";
import { AddressLabel, Change, Price, WatchButton } from "./ui";
import { Eth, Stat, Trades, Unavailable, explorer, utc } from "./live-ui";
import { PendingValue } from "./product-common";
import { PoolImage } from "./pool-image";
import { Candles } from "./candles";
import { TradeStream } from "./trade-stream";
import { AuditLeaderboard } from "./traders";

export interface ObservedPoolIdentity {
  poolId: string;
  token: string;
  name: string;
  symbol: string;
  imageUrl?: string | null;
  launch: {
    block: number;
    timestamp: number;
    transactionHash: string;
    transactionInitiator: string;
  };
}
type NullableIdentity = Partial<Omit<ObservedPoolIdentity, "launch">> & {
  launch?: Partial<ObservedPoolIdentity["launch"]>;
};
/** One nullable page persists while saved launch, market and accounting publications resolve. */
export function ObservedPoolDetail({
  id,
  pool,
  market,
  accountedMarket,
  snapshot,
  publication,
  audit,
  refresh,
  loading,
  pending = false,
  chart = true,
}: {
  id: string;
  pool?: NullableIdentity;
  market?: ObservedMarket;
  accountedMarket?: ChainMarket;
  snapshot?: ChainSnapshot;
  publication?: AnalyticsPoolDetail;
  audit?: PoolAudit | null;
  refresh: () => void;
  loading: boolean;
  pending?: boolean;
  /** A chart can still arrive, so its region holds that height from first paint. */
  chart?: boolean;
}) {
  const [tab, setTab] = useState("Top traders");
  const candles =
    !!(accountedMarket && snapshot) || !!market?.history.candles.length;
  const stat =
    accountedMarket && snapshot
      ? poolWindow(accountedMarket, snapshot, "24h")
      : null;
  const price = accountedMarket ? accountedMarket.priceWei : market?.priceWei;
  const change = accountedMarket ? stat?.change : market?.change;
  const volume = accountedMarket ? stat?.volumeWei : market?.volumeWei;
  const fdv =
    accountedMarket?.priceWei != null
      ? (
          (BigInt(accountedMarket.priceWei) * BigInt(accountedMarket.supply)) /
          10n ** BigInt(accountedMarket.decimals)
        ).toString()
      : undefined;
  const holderRows = publication?.holders?.balances;
  const observedTrades = market?.observations;
  const capturedTrades = snapshot?.trades.filter(
    (trade) => trade.poolId === id,
  );
  const rows = accountedMarket ? capturedTrades : observedTrades;
  const holders = publication?.holders;
  const sum = (balances: NonNullable<typeof holderRows>) =>
    balances.reduce((total, holder) => total + BigInt(holder.balanceRaw), 0n);
  const ratio = (numerator: bigint, denominator: bigint) =>
    denominator > 0n
      ? `${(Number((numerator * 10000n) / denominator) / 100).toFixed(2)}%`
      : null;
  const users = holderRows?.filter(
    (holder) => holder.kind !== "infrastructure",
  );
  const rawTop10 =
    holders?.complete && holderRows
      ? ratio(sum(holderRows.slice(0, 10)), BigInt(holders.totalSupplyRaw))
      : null;
  const adjustedTop10 =
    holders?.complete && users
      ? ratio(sum(users.slice(0, 10)), sum(users))
      : null;
  return (
    <div
      className={`page nullable-pool-page ${styles.page}`}
      aria-busy={pending}
    >
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Explore</Link>
        <span>/</span>
        <span data-pending={pending && !pool?.symbol}>
          {pool?.symbol ?? (pending ? "Pool pending" : "Pool")}
        </span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <span className="pool-image-slot">
            {pool?.token ? (
              <PoolImage
                poolId={id}
                token={pool.token}
                hasImage={!!pool.imageUrl}
                size="large"
              />
            ) : (
              <span className={styles.avatar} data-pending={pending}>
                Pool
              </span>
            )}
          </span>
          <div className="pool-heading-copy">
            <div className={`${styles.title} pool-identity-title`}>
              <h1 data-pending={pending && !pool?.name} title={pool?.name}>
                {pool?.name ??
                  (pending ? "Loading saved pool" : "Pool name unavailable")}
              </h1>
              <span
                className={styles.symbol}
                data-pending={pending && !pool?.symbol}
              >
                {pool?.symbol ?? (pending ? "Pending" : <Unavailable />)}
              </span>
              <span className={styles.mode}>INSTANT</span>
            </div>
            <div className="pool-address-slot">
              {pool?.token ? (
                <>
                  <span className="pool-address-full">
                    <AddressLabel address={pool.token} full />
                  </span>
                  <span className="pool-address-short">
                    <AddressLabel address={pool.token} />
                  </span>
                </>
              ) : (
                <span className="address-label mono" data-pending={pending}>
                  {pending
                    ? "Token address pending"
                    : "Token address unavailable"}
                </span>
              )}
            </div>
            <div className={`${styles.meta} pool-launch-meta`}>
              <PendingValue pending={pending && !pool?.launch}>
                {pool?.launch?.timestamp != null
                  ? `Launched ${utc(pool.launch.timestamp)}`
                  : "Launch time unavailable"}{" "}
                · sender{" "}
                {pool?.launch?.transactionInitiator
                  ? shortAddress(pool.launch.transactionInitiator)
                  : "unavailable"}
              </PendingValue>
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <WatchButton id={id} />
          <button
            className="icon-button"
            title="Refresh"
            aria-label="Refresh"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={14} />
          </button>
          <a
            className="button secondary"
            href={pool?.token ? `${explorer}/token/${pool.token}` : undefined}
            aria-disabled={!pool?.token}
            target="_blank"
            rel="noreferrer"
          >
            Explorer ↗
          </a>
          <a
            className="button"
            href={
              pool?.token
                ? `https://pools.xyz/t/robinhood/${pool.token}`
                : undefined
            }
            aria-disabled={!pool?.token}
            target="_blank"
            rel="noreferrer"
          >
            Trade on Pools ↗
          </a>
        </div>
      </div>
      <div className="workspace-grid">
        <div>
          <section className="panel">
            <div className={styles.chartHeader}>
              <div className="live-price-heading">
                <Price wei={price} pending={pending} />
                <div className="live-changes">
                  <span>
                    <b>{market?.window ?? "24h"}</b>{" "}
                    <Change value={change} pending={pending} />
                  </span>
                </div>
              </div>
            </div>
            {/* The height is settled at first paint and never moves after it:
                a chart that can still arrive holds its full region, and a row
                with no market evidence opens on the empty state. */}
            <div
              className="pool-chart-region"
              data-chart={candles || chart ? "reserved" : "empty"}
            >
              {candles || (chart && pending) ? (
                <Candles
                  {...(accountedMarket && snapshot
                    ? { market: accountedMarket, snapshot }
                    : market
                      ? { observed: market }
                      : { poolId: id, pending })}
                />
              ) : (
                <div className="empty-state">
                  <h3>Price chart unavailable</h3>
                </div>
              )}
            </div>
          </section>
          <div className="stats-grid live-six-stats">
            <Stat label="FDV" pending={pending}>
              <Eth wei={fdv} pending={pending} />
            </Stat>
            <Stat label="Liquidity" pending={pending}>
              <Eth wei={publication?.liquidityWei} pending={pending} />
            </Stat>
            <Stat
              label={`Observed ${market?.window ?? "24h"} volume`}
              pending={pending}
            >
              <Eth wei={volume} pending={pending} />
            </Stat>
            <Stat label="Holders" pending={pending}>
              {publication?.holders?.complete ? (
                publication.holders.positiveHoldersExcludingInfrastructure
              ) : (
                <Unavailable />
              )}
            </Stat>
            <Stat label="Observed trades" pending={pending}>
              {market?.trades ?? stat?.trades.length ?? <Unavailable />}
            </Stat>
            <Stat label="Fees compounded" pending={pending}>
              <Unavailable />
            </Stat>
          </div>
          <section className="panel live-section">
            <div className="table-tabs live-controls">
              {["Top traders", "Holders", "Trades"].map((value) => (
                <button
                  key={value}
                  className={value === tab ? "active" : ""}
                  onClick={() => setTab(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="pool-activity-region">
              {tab === "Top traders" &&
                (audit ? (
                  <AuditLeaderboard audit={audit} />
                ) : (
                  <div className="empty-state">
                    <h3 data-pending={pending}>
                      {pending
                        ? "Trader accounting pending"
                        : "Trader PnL unavailable"}
                    </h3>
                  </div>
                ))}
              {tab === "Holders" &&
                (holderRows ? (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Holder</th>
                          <th>Balance (raw token units)</th>
                          <th>Classification</th>
                        </tr>
                      </thead>
                      <tbody>
                        {holderRows.slice(0, 100).map((holder) => (
                          <tr key={holder.address}>
                            <td>
                              <Link href={`/wallet/${holder.address}/`}>
                                {shortAddress(holder.address)}
                              </Link>
                            </td>
                            <td className="number">{holder.balanceRaw}</td>
                            <td>{holder.kind}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-state">
                    <h3 data-pending={pending}>
                      {pending
                        ? "Holder accounting pending"
                        : "Holder accounting unavailable"}
                    </h3>
                  </div>
                ))}
              {tab === "Trades" &&
                (accountedMarket && snapshot ? (
                  <Trades
                    trades={capturedTrades ?? []}
                    markets={snapshot.markets}
                  />
                ) : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Side</th>
                          <th>ETH</th>
                          <th>Transaction</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows?.slice(0, 50).map((trade, index) => {
                          const observed = "transactionHash" in trade;
                          const tx = observed
                            ? trade.transactionHash
                            : trade.txHash;
                          return (
                            <tr key={index}>
                              <td>{utc(trade.timestamp)}</td>
                              <td>{trade.side ?? "Unsupported"}</td>
                              <td>
                                <Eth wei={trade.ethWei} />
                              </td>
                              <td>
                                <a
                                  className="mono"
                                  href={`${explorer}/tx/${tx}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {shortAddress(tx)} ↗
                                </a>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          </section>
        </div>
        <aside className="market-sidebar">
          <TradeStream poolId={id} />
          <section className="panel">
            <div className="panel-heading">
              <h2>Concentration</h2>
            </div>
            <dl className="live-facts">
              {["Raw top 10", "Adjusted top 10", "Gini"].map((label) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <span className="number" data-pending={pending}>
                      {label === "Raw top 10" ? (
                        (rawTop10 ?? <Unavailable />)
                      ) : label === "Adjusted top 10" ? (
                        (adjustedTop10 ?? <Unavailable />)
                      ) : (
                        <Unavailable />
                      )}
                    </span>
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
                <dd className="mono">{id}</dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>
                  <PendingValue pending={pending}>
                    {accountedMarket?.decimals ?? market?.decimals ?? (
                      <Unavailable />
                    )}
                  </PendingValue>
                </dd>
              </div>
              {["Supply", "LP fee", "Position recipient", "Permanent lock"].map(
                (label) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <PendingValue pending={pending}>
                        {accountedMarket && label === "Supply" ? (
                          (
                            Number(accountedMarket.supply) /
                            10 ** accountedMarket.decimals
                          ).toLocaleString("en-US")
                        ) : accountedMarket && label === "LP fee" ? (
                          `${accountedMarket.fee / 10000}%`
                        ) : accountedMarket &&
                          label === "Position recipient" ? (
                          <a
                            href={`${explorer}/address/${accountedMarket.positionRecipient}`}
                            className="mono"
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortAddress(accountedMarket.positionRecipient)} ↗
                          </a>
                        ) : (
                          <Unavailable />
                        )}
                      </PendingValue>
                    </dd>
                  </div>
                ),
              )}
            </dl>
            <a
              className="leader-link"
              href={
                pool?.launch?.transactionHash
                  ? `${explorer}/tx/${pool.launch.transactionHash}`
                  : undefined
              }
              aria-disabled={!pool?.launch?.transactionHash}
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
