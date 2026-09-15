"use client";
import { FollowActivity } from "./follow-activity";
import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import {
  shortAddress,
  poolHref,
  type AnalyticsWalletResponse,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import {
  Eth,
  Stat,
  Unavailable,
  WindowTabs,
  useWindow,
  utc,
  explorer,
} from "./live-ui";
import { AddressLabel, Avatar, Chart } from "./ui";
import { FeaturePreview, TradingPreviewPanels } from "./feature-preview";
import { PendingValue, ProductCoverage } from "./product-common";
import { AccountingBadge } from "./accounting-badge";
import {
  accountingExplanation,
  accountingLabel,
  hasInitiatorModel,
} from "@/lib/accounting-evidence";
import { FollowButton } from "./following";
import styles from "./detail-design.module.css";
export function ProductWallet({ address }: { address: string }) {
  const { window: period, setWindow } = useWindow("All");
  const { data, loading, error, refresh } = useProduct<AnalyticsWalletResponse>(
    `wallets/${address.toLowerCase()}?window=${period}`,
  );
  const [tab, setTab] = useState("Positions"),
    [showSignals, setShowSignals] = useState(false),
    [copied, setCopied] = useState(false),
    [card, setCard] = useState(false),
    [cardError, setCardError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (card) dialog.current?.showModal();
    else dialog.current?.close();
  }, [card]);
  const w = data?.wallet,
    cardUrl = `/cards/${address.toLowerCase()}.png?window=${period}`;
  const pct = (n: number | null | undefined, signed = false) =>
    n == null ? (
      <Unavailable />
    ) : (
      <span
        className={signed ? (n > 0 ? "positive" : n < 0 ? "negative" : "") : ""}
      >
        {n.toFixed(1)}%
      </span>
    );
  return (
    <div className={`page wallet-page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/traders/">Traders</Link>
        <span>/</span>
        <span>{shortAddress(address)}</span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <Avatar address={address} />
          <div>
            <div className={styles.title}>
              <h1>{shortAddress(address)}</h1>
              <span className={styles.mode} data-pending={!data}>
                {w?.rank
                  ? `RANK ${w.rank}`
                  : data
                    ? "UNRANKED"
                    : "RANK PENDING"}
              </span>
              <span className="wallet-accounting-slot">
                {w ? (
                  <AccountingBadge wallet={w} />
                ) : (
                  <span className="evidence-badge" data-pending="true">
                    Accounting pending
                  </span>
                )}
              </span>
            </div>
            <AddressLabel address={address} full />
            <div className={styles.meta}>
              Public wallet · no account required
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <FollowButton address={address} />
          <a
            className="button secondary"
            href={`${explorer}/address/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            Explorer ↗
          </a>
          <button
            className="button secondary"
            onClick={() => {
              setCard(true);
              setCardError(false);
            }}
          >
            Share PnL card
          </button>
          <FeaturePreview feature="profile">Edit profile</FeaturePreview>
          <button
            className="button"
            aria-expanded={showSignals}
            aria-controls="wallet-signals"
            onClick={() => setShowSignals(!showSignals)}
          >
            {showSignals ? "Hide copy signals" : "View copy signals"}
          </button>
        </div>
      </div>
      {showSignals && (
        <FollowActivity addresses={[address.toLowerCase()]} mode="wallet" />
      )}
      <ProductCoverage coverage={data?.coverage} delivery={data?.delivery} />
      <div className="live-controls">
        <WindowTabs value={period} onChange={setWindow} />
        <button
          className="button secondary"
          disabled={loading}
          onClick={refresh}
        >
          Refresh saved profile
        </button>
      </div>
      {loading && data && (
        <span className="sr-only" role="status">
          Updating saved wallet activity
        </span>
      )}
      {error && (
        <p role="alert" className="coverage-notice">
          {error}
        </p>
      )}
      <>
        <div className="stats-grid live-eight-stats">
          <Stat
            pending={loading && !data}
            label="Realized PnL"
            note={
              w
                ? `${accountingLabel(w)} · before gas`
                : "Saved positions · before gas"
            }
          >
            <Eth pending={!data} wei={w?.realizedWei} signed />
          </Stat>
          <Stat
            pending={loading && !data}
            label="Unrealized PnL"
            note="Transfer-verified positions only"
          >
            <Eth pending={!data} wei={w?.unrealizedWei} signed />
          </Stat>
          <Stat
            pending={loading && !data}
            label="Realized ROI"
            note="Profit / disposed cost"
          >
            {pct(w?.roi, true)}
          </Stat>
          <Stat
            pending={loading && !data}
            label="Win rate"
            note="Closed inventory cycles"
          >
            {pct(w?.winRate)}
          </Stat>
          <Stat pending={loading && !data} label="Ranking trades">
            {w?.rankingTradeCount ?? w?.supportedTradeCount ?? <Unavailable />}
          </Stat>
          <Stat pending={loading && !data} label="Observed volume">
            <Eth pending={!data} wei={w?.volumeWei} />
          </Stat>
          <Stat pending={loading && !data} label="Avg closed hold">
            {w?.avgHold == null ? <Unavailable /> : `${Math.round(w.avgHold)}s`}
          </Stat>
          <Stat pending={loading && !data} label="Best realized sale">
            <Eth pending={!data} wei={w?.bestWei} signed />
          </Stat>
        </div>
        <p className="page-intro-note wallet-summary-note">
          <PendingValue pending={!data}>
            {w && (
              <>
                {w.tier3PositionCount ?? w.supportedPositionCount}{" "}
                transfer-verified positions · {w.tier2PositionCount ?? 0}{" "}
                swap-based positions · {w.excludedPositionCount} excluded.{" "}
                {accountingExplanation(w)} Unknown cost basis is never assigned
                zero cost.
              </>
            )}
          </PendingValue>
        </p>
        <div className="workspace-grid">
          <div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Cumulative realized PnL · {period}</h2>
              </div>
              <div className="wallet-chart-region" data-pending={!data}>
                <Chart
                  points={data?.curve ?? []}
                  pending={!data}
                  profit
                  label="Cumulative realized PnL"
                />
              </div>
              <p className="panel-footnote wallet-curve-note">
                {data?.curveSampled ? (
                  <>
                    Chart points are sampled for readability. PnL totals include
                    all eligible sales in this window, including their earlier
                    purchase basis.
                  </>
                ) : (
                  "\u00a0"
                )}
              </p>
            </section>
            <section className="panel live-section">
              <div
                className={styles.tabs}
                role="tablist"
                aria-label="Wallet activity"
              >
                {["Positions", "Trades", "Launches"].map((t) => (
                  <button
                    role="tab"
                    aria-selected={tab === t}
                    key={t}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {tab === "Positions" && (
                <>
                  <div className="panel-heading">
                    <h2>Positions across covered pools</h2>
                  </div>
                  <div className="table-scroll wallet-list-region">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Inventory</th>
                          <th>Cost</th>
                          <th>Realized</th>
                          <th>Unrealized</th>
                          <th>Coverage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(
                          { length: Math.max(25, data?.positions.length ?? 0) },
                          (_, index) => data?.positions[index],
                        ).map((p, index) => (
                          <tr
                            key={index}
                            aria-hidden={!p}
                            data-row={p ? "resolved" : "reserved"}
                          >
                            <td data-pending={!p && !data}>
                              {p ? (
                                <>
                                  <Link
                                    href={poolHref({
                                      id: p.poolId,
                                      launchTx: p.launchTx,
                                    })}
                                  >
                                    {p.symbol}
                                  </Link>
                                </>
                              ) : data ? (
                                "\u00a0"
                              ) : (
                                "Pending"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              {p ? (
                                <>
                                  {p.position && p.decimals !== null ? (
                                    `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(Number(p.position.quantity) / 10 ** p.decimals)} ${p.symbol}`
                                  ) : (
                                    <Unavailable />
                                  )}
                                </>
                              ) : data ? (
                                "\u00a0"
                              ) : (
                                "Pending"
                              )}
                            </td>
                            <td data-pending={!p && !data}>
                              <Eth pending={!data} wei={p?.position?.costWei} />
                            </td>
                            <td data-pending={!p && !data}>
                              <Eth
                                pending={!data}
                                wei={p?.realizedWei}
                                signed
                              />
                            </td>
                            <td data-pending={!p && !data}>
                              <Eth
                                pending={!data}
                                wei={p?.unrealizedWei}
                                signed
                              />
                            </td>
                            <td data-pending={!p && !data}>
                              {p ? (
                                <>
                                  {p.accountingTier === "tier2"
                                    ? "Swap-based estimate"
                                    : p.supported
                                      ? "Transfer-verified"
                                      : "History incomplete"}
                                  {!!p.flags.length && (
                                    <small className="cell-sub">
                                      {p.flags.join(", ")}
                                    </small>
                                  )}
                                  {p.modeledPosition && (
                                    <small className="cell-sub">
                                      Observed swap book:{" "}
                                      {p.modeledPosition.quantity} raw token
                                      units; not a verified wallet balance.
                                    </small>
                                  )}
                                  <small className="cell-sub">
                                    {utc(p.asOf)}
                                  </small>
                                </>
                              ) : data ? (
                                "\u00a0"
                              ) : (
                                "Pending"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data && !data.positions.length && (
                    <div className="empty-state">
                      No saved positions for this wallet. This does not imply
                      inactivity outside coverage.
                    </div>
                  )}
                  {data?.positionsTruncated && (
                    <p className="panel-footnote">
                      Showing {data.positions.length} positions. Summary metrics
                      include all saved positions.
                    </p>
                  )}
                </>
              )}
              {tab === "Trades" && (
                <>
                  <div className="panel-heading">
                    <h2>Observed trade history</h2>
                  </div>
                  <div className="table-scroll wallet-list-region">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Time (UTC)</th>
                          <th>Pool</th>
                          <th>Side</th>
                          <th>ETH</th>
                          <th>Attribution</th>
                          <th>Transaction</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data?.trades.map((e) => (
                          <tr
                            key={`${e.poolId}:${e.trade.txHash}:${e.trade.logIndex}`}
                          >
                            <td>{utc(e.trade.timestamp)}</td>
                            <td>{e.symbol}</td>
                            <td
                              className={
                                e.trade.side === "buy" ? "positive" : "negative"
                              }
                            >
                              {e.trade.side}
                            </td>
                            <td>
                              <Eth wei={e.trade.ethWei} />
                            </td>
                            <td>
                              {e.flags.length
                                ? e.flags.join(", ")
                                : "Supported"}
                            </td>
                            <td>
                              <a
                                href={`${explorer}/tx/${e.trade.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {shortAddress(e.trade.txHash)} ↗
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data?.tradesTruncated && (
                    <p className="panel-footnote">
                      Showing a bounded trade list. Aggregate metrics use the
                      full saved histories.
                    </p>
                  )}
                </>
              )}
              {tab === "Launches" && (
                <>
                  <div className="panel-heading">
                    <h2>
                      Launches · {data?.launches.length ?? 0}{" "}
                      {data?.launchesTruncated ? "shown" : "covered"}
                    </h2>
                  </div>
                  <div className="table-scroll wallet-list-region">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Launch (UTC)</th>
                          <th>Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data?.launches.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <Link href={poolHref(p)}>
                                {p.name} ({p.symbol})
                              </Link>
                            </td>
                            <td>{utc(p.launchedAt)}</td>
                            <td>
                              <a
                                href={`${explorer}/tx/${p.launchTx}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Launch transaction ↗
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data?.launchesTruncated && (
                    <p className="panel-footnote">
                      Showing the latest {data.launches.length} launches. Search
                      can find older launches in the saved catalog.
                    </p>
                  )}
                  <p className="panel-footnote">
                    Grouped by launch transaction sender. This does not
                    independently verify creator identity.
                  </p>
                </>
              )}
            </section>
          </div>
          <aside className="market-sidebar">
            <TradingPreviewPanels />
            <section className="panel">
              <div className="panel-heading">
                <h2>Profile coverage</h2>
              </div>
              <dl className="live-facts">
                <div>
                  <dt>Transfer-verified positions</dt>
                  <dd>{w?.supportedPositionCount ?? <Unavailable />}</dd>
                </div>
                <div>
                  <dt>Swap-based positions</dt>
                  <dd>{w?.tier2PositionCount ?? 0}</dd>
                </div>
                <div>
                  <dt>Excluded positions</dt>
                  <dd>{w?.excludedPositionCount ?? <Unavailable />}</dd>
                </div>
                <div>
                  <dt>Saved wallet cutoff</dt>
                  <dd>{w?.asOf ? utc(w.asOf) : <Unavailable />}</dd>
                </div>
                <div>
                  <dt>Oldest position cutoff</dt>
                  <dd>{w?.oldestAsOf ? utc(w.oldestAsOf) : <Unavailable />}</dd>
                </div>
                <div>
                  <dt>Last observed trade</dt>
                  <dd>{w?.last ? utc(w.last) : <Unavailable />}</dd>
                </div>
              </dl>
              <p className="panel-footnote">
                {w && hasInitiatorModel(w)
                  ? "Swap-based inventory is a model of observed buys and sells, not a verified wallet balance."
                  : "Holdings are marked at each pool’s saved cutoff. Spot marks are not guaranteed exit proceeds."}
              </p>
            </section>
          </aside>
        </div>
      </>
      <dialog
        ref={dialog}
        className={styles.cardModal}
        aria-label="PnL share card preview"
        onClose={() => setCard(false)}
        onClick={(event) => {
          if (event.target === dialog.current) setCard(false);
        }}
      >
        <div className="panel-heading">
          <h2>Share PnL card</h2>
          <button
            className="icon-button"
            aria-label="Close card preview"
            onClick={() => setCard(false)}
          >
            ×
          </button>
        </div>
        <p className="panel-footnote">
          1200 × 630 · same saved wallet metrics and selected window.
        </p>
        {card && !cardError ? ( // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cardUrl}
            alt="Saved wallet PnL card"
            style={{
              width: "100%",
              maxWidth: 800,
              display: "block",
              margin: "0 auto",
            }}
            onError={() => setCardError(true)}
          />
        ) : (
          <p className="panel-footnote">
            No supported saved PnL is available for this card.
          </p>
        )}
        <div className="live-share-actions">
          <button
            className="button secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            className="button secondary"
            onClick={() =>
              window.open(
                `https://twitter.com/intent/tweet?url=${encodeURIComponent(window.location.href)}`,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            Post on X
          </button>
          {!cardError && (
            <a className="button" href={cardUrl} download={`${address}.png`}>
              Download PNG ↗
            </a>
          )}
        </div>
      </dialog>
    </div>
  );
}
