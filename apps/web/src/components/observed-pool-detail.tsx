"use client";
import Link from "next/link";
import { useState } from "react";
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
import { Eth, Stat, Unavailable, explorer, utc } from "./live-ui";
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
  error,
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
  error?: string;
}) {
  const [tab, setTab] = useState("Top traders");
  const c = accountedMarket ? undefined : market?.coverage;
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
        <span data-pending={pending}>
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
              <h1 data-pending={pending} title={pool?.name}>
                {pool?.name ??
                  (pending
                    ? "Loading saved pool"
                    : "Pool outside current coverage")}
              </h1>
              <span className={styles.symbol} data-pending={pending}>
                {pool?.symbol ?? "Pending"}
              </span>
              <span className={styles.mode}>INSTANT</span>
              <span className="evidence-badge" data-pending={pending}>
                {publication?.holders?.complete && audit
                  ? "Verified history"
                  : pending
                    ? "Evidence pending"
                    : market || accountedMarket
                      ? "Market evidence"
                      : "Launch only"}
              </span>
            </div>
            <div className="pool-address-slot">
              {pool?.token ? (
                <AddressLabel address={pool.token} full />
              ) : (
                <span className="address-label mono" data-pending={pending}>
                  {pending
                    ? "Token address pending"
                    : "Token address unavailable"}
                </span>
              )}
            </div>
            <div className={`${styles.meta} pool-launch-meta`}>
              <PendingValue pending={pending}>
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
      <div className="live-controls">
        <button
          className="button secondary"
          onClick={refresh}
          disabled={loading}
        >
          Refresh pool data
        </button>
        <p className="pool-refresh-status" role="status">
          {error
            ? pool
              ? "Saved refresh is unavailable. Showing the last dated observation."
              : "Saved pool is temporarily unavailable. Retry to check coverage."
            : loading
              ? "Loading saved market data"
              : "Saved market data loaded"}
        </p>
      </div>
      <p className="page-intro-note pool-coverage-note">
        <PendingValue pending={pending}>
          {c?.cutoff ? (
            <>
              Observed market coverage: blocks {c.startBlock?.toLocaleString()}{" "}
              to {c.cutoff.block.toLocaleString()} · {utc(c.cutoff.asOf)} ·
              cutoff <span className="mono">{shortAddress(c.cutoff.hash)}</span>
              . {c.completeWindow ? "Covered window" : "Incomplete window"}
              .{" "}
            </>
          ) : snapshot && accountedMarket ? (
            <>
              This pool’s market data is through block{" "}
              {snapshot.toBlock.toLocaleString()} · {utc(snapshot.toTimestamp)}.
              Audit results below have their own cutoff.{" "}
            </>
          ) : pool ? (
            "This verified launch is in the catalog. Market history has not been processed. "
          ) : (
            "This pool has no available saved publication. This coverage limit does not prove that the pool does not exist. "
          )}
          {audit
            ? "Accounting uses supported positions with observed purchase basis. Unknown basis stays excluded. "
            : "Accounting coverage is unavailable. Swaps do not establish holders, balances, beneficiaries or PnL. "}
          {c?.unitBasis && (
            <>
              Prices use token units verified at block{" "}
              {c.unitBasis.block.toLocaleString()} · {utc(c.unitBasis.asOf)} ·{" "}
              <span className="mono">{shortAddress(c.unitBasis.hash)}</span>
              .{" "}
            </>
          )}
          {c?.unitsConflict &&
            "Conflicting observed token units make price normalization unavailable."}
        </PendingValue>
      </p>
      <div className="workspace-grid">
        <div>
          <section className="panel">
            <div className={styles.context}>
              <strong>Price context</strong>
              <span>ETH · Robinhood Chain</span>
            </div>
            <div className={styles.chartHeader}>
              <div className="live-price-heading">
                <Price wei={price} pending={pending} />
                <div className="live-changes">
                  <span>
                    <b>{market?.window ?? "24h"}</b>{" "}
                    <Change value={change} pending={pending} />
                    <small>at cutoff</small>
                  </span>
                </div>
              </div>
            </div>
            <div className="pool-chart-region">
              <Candles
                {...(accountedMarket && snapshot
                  ? { market: accountedMarket, snapshot }
                  : market
                    ? { observed: market }
                    : { poolId: id, pending })}
              />
            </div>
            <p className="panel-footnote pool-truncation-note">
              {market?.history.truncated
                ? "Showing the latest 1,000 observed minute candles. Earlier loaded history is omitted."
                : "\u00a0"}
            </p>
          </section>
          <div className="stats-grid live-six-stats">
            <Stat
              label="FDV"
              pending={pending}
              note="Spot price × contract total supply"
            >
              <Eth wei={fdv} pending={pending} />
            </Stat>
            <Stat
              label="Liquidity"
              note="Manager active liquidity is not TVL"
              pending={pending}
            >
              <Eth wei={publication?.liquidityWei} pending={pending} />
            </Stat>
            <Stat
              label={`Observed ${market?.window ?? "24h"} volume`}
              note={
                c?.completeWindow
                  ? "Within covered history"
                  : "Incomplete covered window"
              }
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
            <Stat
              label="Observed trades"
              note="Canonical transaction/log identities"
              pending={pending}
            >
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
                    <p>
                      Verified transfer history and supported accounting have
                      not been published for this pool. No positions or balances
                      are estimated from swaps.
                    </p>
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
                    <p>
                      Verified transfer history and supported accounting have
                      not been published for this pool. No positions or balances
                      are estimated from swaps.
                    </p>
                  </div>
                ))}
              {tab === "Trades" && (
                <>
                  <p className="panel-footnote">
                    Observed historical swaps through the market cutoff. No
                    beneficiary attribution is inferred. Latest 50 identities.
                  </p>
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
                </>
              )}
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
            <p className="panel-footnote">
              These figures need a reconciled holder snapshot.
            </p>
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
