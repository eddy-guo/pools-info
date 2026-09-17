"use client";
import Link from "next/link";
import { Fragment, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  poolWindow,
  shortAddress,
  since,
  type AnalyticsPoolDetail,
  type ChainMarket,
  type ChainSnapshot,
  type LiveWindow,
  type ObservedMarket,
  type PoolAudit,
} from "@pools/core";
import styles from "./detail-design.module.css";
import { AddressLabel, Change, Price, WatchButton } from "./ui";
import { Eth, Stat, Trades, Unavailable, explorer, utc } from "./live-ui";
import { PendingValue } from "./product-common";
import { PoolImage } from "./pool-image";
import {
  Candles,
  ChartRangeControl,
  useHydrated,
  type ChartRange,
} from "./candles";
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
/**
 * The 56px header of the export: the 54px identity image, the name with its
 * mono symbol and launch mode chip, then the short address beside
 * `launched <age> by <sender>`. `renderedAt` is the server's clock, so the
 * age it paints is the age the client hydrates.
 */
export function PoolHeading({
  id,
  pool,
  pending = false,
  renderedAt,
  children,
}: {
  id: string;
  pool?: NullableIdentity;
  pending?: boolean;
  renderedAt: number;
  children: React.ReactNode;
}) {
  const launch = pool?.launch;
  return (
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
            {/* The name's width settles with the response; the symbol and
                chip after it are new nodes then, not moved ones. */}
            <Fragment key={pending ? "pending" : "resolved"}>
              <span
                className={styles.symbol}
                data-pending={pending && !pool?.symbol}
              >
                {pool?.symbol ?? (pending ? "Pending" : <Unavailable />)}
              </span>
              <span className={styles.mode}>INSTANT</span>
            </Fragment>
          </div>
          <div className="pool-meta">
            <span className="pool-address-slot">
              {pool?.token ? (
                <AddressLabel address={pool.token} />
              ) : pending ? (
                /* The skeleton has the short address's shape, so the line
                   after it stands still when the address lands. */
                <span
                  className="address-label"
                  data-pending="true"
                  aria-label="Token address pending"
                >
                  <span className="mono" aria-hidden="true">
                    0x0000…0000
                  </span>
                  <span className="icon-button" />
                  <span className="icon-button" />
                </span>
              ) : (
                <span className="address-label mono">
                  Token address unavailable
                </span>
              )}
            </span>
            {/* What follows the address is remounted with it, never moved. */}
            <span
              key={pending ? "pending" : "resolved"}
              className="pool-launch-meta"
            >
              <PendingValue pending={pending && !launch}>
                {launch?.timestamp != null ? (
                  <>
                    launched{" "}
                    <time
                      dateTime={new Date(launch.timestamp * 1000).toISOString()}
                      title={utc(launch.timestamp)}
                    >
                      {since(launch.timestamp, renderedAt)}
                    </time>{" "}
                    ago
                  </>
                ) : (
                  "launch unavailable"
                )}
                {launch?.transactionInitiator && (
                  <>
                    {" "}
                    by{" "}
                    <Link
                      href={`/creators/${launch.transactionInitiator.toLowerCase()}/`}
                    >
                      {shortAddress(launch.transactionInitiator)}
                    </Link>
                  </>
                )}
              </PendingValue>
            </span>
          </div>
        </div>
      </div>
      <div className={styles.actions}>{children}</div>
    </div>
  );
}
/**
 * The chart panel's head: the price with its unit and signed change, the
 * windows the read API sent, and the range control on the same row.
 */
export function PoolChartHead({
  price,
  change,
  windows,
  pending = false,
  range,
  onRange,
}: {
  price?: string | null;
  change?: number | null;
  windows: { window: LiveWindow; change: number }[];
  pending?: boolean;
  range: ChartRange;
  /** Absent when the panel holds no chart to range over. */
  onRange?: (range: ChartRange) => void;
}) {
  const hydrated = useHydrated();
  return (
    <div className="pool-chart-head">
      <div>
        <div className="live-price-heading">
          <Price wei={price} pending={pending} />
          <PendingValue pending={pending}>
            <Change value={change} />
          </PendingValue>
        </div>
        <div className="live-changes">
          {pending ? (
            <span key="pending" data-pending="true">
              24h pending
            </span>
          ) : (
            windows.map((w) => (
              <span key={w.window}>
                <b>{w.window}</b> <Change value={w.change} />
              </span>
            ))
          )}
        </div>
      </div>
      {onRange && (
        <ChartRangeControl
          value={range}
          onChange={onRange}
          disabled={!hydrated || pending}
        />
      )}
    </div>
  );
}
/** The changes the evidence supports, in the export's order; none is invented. */
export function windowChanges(
  market: ChainMarket | undefined,
  snapshot: ChainSnapshot | undefined,
  observed: ObservedMarket | undefined,
): { window: LiveWindow; change: number }[] {
  if (market && snapshot)
    return (["1h", "6h", "24h", "7d"] as const).flatMap((window) => {
      const { change } = poolWindow(market, snapshot, window);
      return change === null ? [] : [{ window, change }];
    });
  return observed?.change != null
    ? [{ window: observed.window, change: observed.change }]
    : [];
}
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
  renderedAt,
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
  renderedAt: number;
}) {
  const [tab, setTab] = useState("Top traders");
  const [range, setRange] = useState<ChartRange>("All");
  const candles =
    !!(accountedMarket && snapshot) || !!market?.history.candles.length;
  const stat =
    accountedMarket && snapshot
      ? poolWindow(accountedMarket, snapshot, "24h")
      : null;
  const price = accountedMarket ? accountedMarket.priceWei : market?.priceWei;
  const change = accountedMarket ? stat?.change : market?.change;
  /* The volume and the trade count under it come from one source: the
     observed market's window when there is one, else the accounted cut. */
  const volume = market ? market.volumeWei : stat?.volumeWei;
  const trades = market ? market.trades : stat?.trades.length;
  const fdv =
    accountedMarket?.priceWei != null
      ? (
          (BigInt(accountedMarket.priceWei) * BigInt(accountedMarket.supply)) /
          10n ** BigInt(accountedMarket.decimals)
        ).toString()
      : (market?.fdvWei ?? undefined);
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
  const showChart = candles || (chart && pending);
  return (
    <div
      className={`page pool-page nullable-pool-page ${styles.page}`}
      aria-busy={pending}
    >
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Pools</Link>
        <span>/</span>
        <span data-pending={pending && !pool?.symbol}>
          {pool?.symbol ?? (pending ? "Pool pending" : "Pool")}
        </span>
      </nav>
      <PoolHeading
        id={id}
        pool={pool}
        pending={pending}
        renderedAt={renderedAt}
      >
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
      </PoolHeading>
      <div className="workspace-grid">
        <div>
          <section className="panel pool-chart-panel">
            {/* A row with no market evidence has no price to head the panel
                with; its panel is the empty state alone. */}
            {(candles || chart) && (
              <PoolChartHead
                price={price}
                change={change}
                windows={windowChanges(accountedMarket, snapshot, market)}
                pending={pending}
                range={range}
                onRange={showChart ? setRange : undefined}
              />
            )}
            {/* The height is settled at first paint and never moves after it:
                a chart that can still arrive holds its full region, and a row
                with no market evidence opens on the empty state. */}
            <div
              className="pool-chart-region"
              data-chart={candles || chart ? "reserved" : "empty"}
            >
              {showChart ? (
                <Candles
                  range={range}
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
              <Eth wei={fdv} pending={pending} digits={5} />
            </Stat>
            <Stat label="Liquidity" pending={pending}>
              <Eth
                wei={publication?.liquidityWei}
                pending={pending}
                digits={5}
              />
            </Stat>
            <Stat
              label={`Volume ${market?.window ?? "24h"}`}
              pending={pending}
              note={
                trades == null
                  ? undefined
                  : `${trades.toLocaleString("en-US")} trades`
              }
            >
              <Eth wei={volume} pending={pending} digits={5} />
            </Stat>
            <Stat label="Holders" pending={pending}>
              {publication?.holders?.complete ? (
                publication.holders.positiveHoldersExcludingInfrastructure.toLocaleString(
                  "en-US",
                )
              ) : (
                <Unavailable />
              )}
            </Stat>
            <Stat label="Fees compounded" pending={pending}>
              <Unavailable />
            </Stat>
            <Stat label="Creator fee" pending={pending}>
              {accountedMarket ? (
                accountedMarket.creatorFees ? (
                  "Enabled"
                ) : (
                  "Disabled"
                )
              ) : (
                <Unavailable />
              )}
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
                    <h3
                      key={pending ? "pending" : "resolved"}
                      data-pending={pending}
                    >
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
                    <h3
                      key={pending ? "pending" : "resolved"}
                      data-pending={pending}
                    >
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
