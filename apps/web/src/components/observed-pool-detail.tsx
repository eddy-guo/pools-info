"use client";
import Link from "next/link";
import { useState } from "react";
import type { ObservedMarket } from "@pools/core";
import { shortAddress } from "@pools/core";
import styles from "./detail-design.module.css";
import { AddressLabel, Change, Price, WatchButton } from "./ui";
import { Eth, Stat, Unavailable, explorer, utc } from "./live-ui";
import { PoolImage } from "./pool-image";
import { Candles } from "./candles";
import { TradeStream } from "./trade-stream";

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
/** Uses the existing pool layout without constructing an accounting snapshot. */
export function ObservedPoolDetail({
  pool,
  market,
  refresh,
  loading,
  error,
}: {
  pool: ObservedPoolIdentity;
  market: ObservedMarket;
  refresh: () => void;
  loading: boolean;
  error?: string;
}) {
  const [tab, setTab] = useState("Top traders");
  const c = market.coverage;
  return (
    <div className={`page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/">Explore</Link>
        <span>/</span>
        <span>{pool.symbol}</span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <PoolImage
            poolId={pool.poolId}
            token={pool.token}
            hasImage={!!pool.imageUrl}
            size="large"
          />
          <div>
            <div className={styles.title}>
              <h1>{pool.name}</h1>
              <span className={styles.symbol}>{pool.symbol}</span>
              <span className={styles.mode}>INSTANT</span>
            </div>
            <AddressLabel address={pool.token} full />
            <div className={styles.meta}>
              Launched {utc(pool.launch.timestamp)} · sender{" "}
              {shortAddress(pool.launch.transactionInitiator)}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <WatchButton id={pool.poolId} />
          <a
            className="button secondary"
            href={`${explorer}/token/${pool.token}`}
            target="_blank"
            rel="noreferrer"
          >
            Explorer ↗
          </a>
          <a
            className="button"
            href={`https://pools.xyz/t/robinhood/${pool.token}`}
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
          {loading ? "Refreshing pool…" : "Refresh pool data"}
        </button>
        {error && (
          <p role="status">
            Saved market refresh is unavailable. Showing the last dated
            observation.
          </p>
        )}
      </div>
      <p className="page-intro-note">
        <span>
          {c.cutoff ? (
            <>
              Observed market coverage: blocks {c.startBlock!.toLocaleString()}{" "}
              to {c.cutoff.block.toLocaleString()} · {utc(c.cutoff.asOf)} ·
              cutoff <span className="mono">{shortAddress(c.cutoff.hash)}</span>
              . {c.completeWindow ? "Covered window" : "Incomplete window"}.
            </>
          ) : (
            "This verified launch is in the catalog. Market history has not been processed."
          )}{" "}
          Accounting coverage is unavailable. Swaps do not establish holders,
          balances, beneficiaries or PnL.
          {c.unitBasis && (
            <>
              {" "}
              Prices use token units verified at block{" "}
              {c.unitBasis.block.toLocaleString()} · {utc(c.unitBasis.asOf)} ·{" "}
              <span className="mono">{shortAddress(c.unitBasis.hash)}</span>.
            </>
          )}
          {c.unitsConflict &&
            " Conflicting observed token units make price normalization unavailable."}
        </span>
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
                {market.priceWei !== null ? (
                  <Price wei={market.priceWei} />
                ) : (
                  <Unavailable
                    reason={
                      market.decimals === null
                        ? "Price units unavailable for this history"
                        : "No supported observed swap price"
                    }
                  />
                )}
                <div className="live-changes">
                  <span>
                    <b>{market.window}</b>{" "}
                    {market.change === null ? (
                      <Unavailable />
                    ) : (
                      <Change value={market.change} />
                    )}
                    <small>at cutoff</small>
                  </span>
                </div>
              </div>
            </div>
            <Candles observed={market} />
            {market.history.truncated && (
              <p className="panel-footnote">
                Showing the latest 1,000 observed minute candles. Earlier loaded
                history is omitted.
              </p>
            )}
          </section>
          <div className="stats-grid live-six-stats">
            <Stat label="FDV">
              <Unavailable />
            </Stat>
            <Stat label="Liquidity" note="Manager active liquidity is not TVL">
              <Unavailable />
            </Stat>
            <Stat
              label={`Observed ${market.window} volume`}
              note={
                c.completeWindow
                  ? "Within covered history"
                  : "Incomplete covered window"
              }
            >
              <Eth wei={market.volumeWei} />
            </Stat>
            <Stat label="Holders">
              <Unavailable />
            </Stat>
            <Stat
              label="Observed trades"
              note="Canonical transaction/log identities"
            >
              {market.trades ?? <Unavailable />}
            </Stat>
            <Stat label="Fees compounded">
              <Unavailable />
            </Stat>
          </div>
          <section className="panel live-section">
            <div className="table-tabs live-controls">
              {["Top traders", "Holders", "Trades"].map((t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "Trades" ? (
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
                      {market.observations.map((t) => (
                        <tr key={t.id}>
                          <td>{utc(t.timestamp)}</td>
                          <td>{t.side ?? "Unsupported"}</td>
                          <td>
                            <Eth wei={t.ethWei} />
                          </td>
                          <td>
                            <a
                              className="mono"
                              href={`${explorer}/tx/${t.transactionHash}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shortAddress(t.transactionHash)} ↗
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <h3>
                  {tab === "Holders"
                    ? "Holder accounting unavailable"
                    : "Trader PnL unavailable"}
                </h3>
                <p>
                  Verified transfer history and supported accounting have not
                  been published for this pool. No positions or balances are
                  estimated from swaps.
                </p>
              </div>
            )}
          </section>
        </div>
        <aside className="market-sidebar">
          <TradeStream poolId={pool.poolId} />
          <section className="panel">
            <div className="panel-heading">
              <h2>Concentration</h2>
            </div>
            <dl className="live-facts">
              {["Raw top 10", "Adjusted top 10", "Gini"].map((label) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <Unavailable />
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
                <dd className="mono">{pool.poolId}</dd>
              </div>
              <div>
                <dt>Decimals</dt>
                <dd>{market.decimals ?? <Unavailable />}</dd>
              </div>
              {["Supply", "LP fee", "Position recipient", "Permanent lock"].map(
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
            <a
              className="leader-link"
              href={`${explorer}/tx/${pool.launch.transactionHash}`}
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
