"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./detail-design.module.css";
import { WalletLaunches } from "./creators";
import {
  walletMetrics,
  walletHref,
  shortAddress,
  poolHref,
  type LiveWindow,
} from "@pools/core";
import { FeaturePreview, TradingPreviewPanels } from "./feature-preview";
import { useLive } from "./live-provider";
import { AddressLabel, Chart } from "./ui";
import {
  AuditAction,
  Eth,
  PoolPicker,
  Stat,
  Trades,
  Unavailable,
  WindowTabs,
  useSelectedMarket,
  useWindow,
  utc,
  explorer,
} from "./live-ui";
export function WalletView({ address }: { address: string }) {
  const { market, error, loading } = useSelectedMarket(),
    { audits } = useLive(),
    { window: period, setWindow } = useWindow();
  const a = market ? audits[market.id] : undefined,
    m = a ? walletMetrics(a, address, period) : null;
  const [card, setCard] = useState(false),
    [copy, setCopy] = useState(""),
    [tab, setTab] = useState("Positions"),
    [cardError, setCardError] = useState(false);
  const cardDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (card) cardDialog.current?.showModal();
    else cardDialog.current?.close();
  }, [card]);
  const cardParams = new URLSearchParams(
    market ? { pool: market.id, launch: market.launchTx, window: period } : {},
  );
  const cardUrl = `/cards/${address}.png?${cardParams}`;
  function shareUrl() {
    return new URL(
      `${walletHref(address, market)}${market ? "&" : "?"}window=${period}`,
      window.location.origin,
    ).href;
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl());
      setCopy("Link copied");
    } catch {
      setCopy("Copy unavailable - use the address bar");
    }
  }
  const pct = (n: number | null | undefined) =>
    n === null || n === undefined ? <Unavailable /> : `${n.toFixed(1)}%`;
  const activityTabs = (
    <>
      <div className={styles.tabs} role="tablist" aria-label="Wallet activity">
        {["Positions", "Trades", "Launches"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Launches" && <WalletLaunches address={address} />}
    </>
  );
  return (
    <div className={`page ${styles.page}`}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/traders/">Traders</Link>
        <span>/</span>
        <span>{shortAddress(address)}</span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">
            {address.slice(2, 4).toUpperCase()}
          </span>
          <div>
            <div className={styles.title}>
              <h1>{shortAddress(address)}</h1>
              <span className={styles.mode}>PUBLIC WALLET</span>
            </div>
            <AddressLabel address={address} full />
            <div className={styles.meta}>
              {m?.last
                ? `Last covered trade ${utc(m.last)}`
                : "Public on-chain activity"}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
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
              setCardError(false);
              setCard(true);
            }}
          >
            Share PnL card
          </button>
          <FeaturePreview feature="profile">Edit profile</FeaturePreview>
          <FeaturePreview feature="copy" className="button">
            Copy trade
          </FeaturePreview>
        </div>
      </div>
      <p className="page-intro-note">
        Any address, no account. Performance covers the selected audited pool,
        not wallet-wide returns.
      </p>
      <section className="panel">
        <div className="live-controls">
          <PoolPicker />
          <WindowTabs value={period} onChange={setWindow} />
        </div>
        {market ? (
          <AuditAction market={market} />
        ) : (
          <p className="panel-footnote">
            {loading
              ? "Loading linked pool…"
              : error || "Pool outside coverage"}
          </p>
        )}
      </section>
      <div className="stats-grid live-eight-stats">
        <Stat label="Realized PnL" note="Selected window · before gas">
          <Eth wei={m?.realizedWei} signed />
        </Stat>
        <Stat
          label="Unrealized PnL"
          note="Inventory at audit cutoff · spot mark"
        >
          <Eth wei={m?.unrealizedWei} signed />
        </Stat>
        <Stat label="Realized ROI" note="Profit / disposed cost basis">
          <span
            className={
              m?.roi == null
                ? ""
                : m.roi > 0
                  ? "positive"
                  : m.roi < 0
                    ? "negative"
                    : ""
            }
          >
            {pct(m?.roi)}
          </span>
        </Stat>
        <Stat label="Win rate" note="Closed inventory cycles">
          {pct(m?.winRate)}
        </Stat>
        <Stat label="Observed swaps">
          {m ? m.trades.length : <Unavailable />}
        </Stat>
        <Stat label="Observed volume">
          <Eth wei={m?.volumeWei} />
        </Stat>
        <Stat label="Avg closed hold" note="First buy to closing sell">
          {m?.avgHold === null || m?.avgHold === undefined ? (
            <Unavailable />
          ) : (
            `${Math.round(m.avgHold)}s`
          )}
        </Stat>
        <Stat label="Best realized sale">
          <Eth wei={m?.bestWei} signed />
        </Stat>
      </div>
      {!m && activityTabs}
      {!a ? (
        <div className="panel empty-state">
          <h2>Audit this pool to load the wallet’s data</h2>
          <p>
            No PnL is assumed before receipts, transfers and inventory are
            checked.
          </p>
        </div>
      ) : !m ? (
        <div className="panel empty-state">
          <h2>No attributed swaps for this address in this pool</h2>
          <p>
            This is not a zero balance or a statement about activity elsewhere
            on the chain.
          </p>
        </div>
      ) : (
        <>
          {!m.complete && (
            <div className="coverage-notice">
              <strong>Incomplete accounting: PnL is unavailable.</strong>
              <p>
                {m.row.flags.join(", ")}. Raw observed swaps remain visible for
                inspection.
              </p>
            </div>
          )}
          <div className="workspace-grid">
            <div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Cumulative realized PnL · {period}</h2>
                  </div>
                </div>
                {m.complete ? (
                  <Chart
                    points={m.curve}
                    label="Cumulative realized PnL"
                    profit
                  />
                ) : (
                  <div className="empty-state">
                    Cannot chart profit with unknown basis.
                  </div>
                )}
              </section>
              {activityTabs}
              <section
                className="panel live-section"
                hidden={tab !== "Positions"}
              >
                <div className="panel-heading">
                  <h2>Open position · {a.market.symbol}</h2>
                </div>
                {m.complete &&
                m.position &&
                BigInt(m.position.quantity) > 0n ? (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Inventory</th>
                          <th>Cost</th>
                          <th>Spot value</th>
                          <th>Unrealized</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>
                            <Link href={poolHref(a.market)}>
                              {a.market.symbol}
                            </Link>
                          </td>
                          <td>
                            {new Intl.NumberFormat("en-US", {
                              maximumSignificantDigits: 7,
                            }).format(
                              Number(m.position.quantity) /
                                10 ** a.market.decimals,
                            )}
                          </td>
                          <td>
                            <Eth wei={m.position.costWei} />
                          </td>
                          <td>
                            <Eth wei={m.valueWei} />
                          </td>
                          <td>
                            <Eth wei={m.unrealizedWei} signed />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="panel-footnote">
                    {m.complete
                      ? "No open inventory in this audited pool."
                      : "Position value is withheld because cost or inventory is incomplete."}
                  </p>
                )}
                <p className="panel-footnote">
                  Marked at the audit’s latest observed pool price, through{" "}
                  {utc(a.toTimestamp)}. Spot value is not guaranteed exit
                  proceeds.
                </p>
              </section>
              <section className="panel live-section" hidden={tab !== "Trades"}>
                <div className="panel-heading">
                  <h2>Observed trade history</h2>
                </div>
                <Trades
                  trades={m.trades.map((e) => e.trade).reverse()}
                  markets={[a.market]}
                />
              </section>
            </div>
            <aside className="market-sidebar">
              <TradingPreviewPanels />
              <section className="panel">
                <div className="panel-heading">
                  <h2>Behaviour</h2>
                </div>
                <dl className="live-facts">
                  <div>
                    <dt>First 5 blocks share</dt>
                    <dd>{pct(m.earlyBuyShare)}</dd>
                  </div>
                  <div>
                    <dt>Closed holds under 60s</dt>
                    <dd>{pct(m.fastHoldShare)}</dd>
                  </div>
                  <div>
                    <dt>Crowd entries</dt>
                    <dd>
                      <Unavailable reason="Auction coverage is not collected" />
                    </dd>
                  </div>
                  <div>
                    <dt>Record</dt>
                    <dd>
                      {m.complete ? (
                        `${m.wins}W / ${m.losses}L`
                      ) : (
                        <Unavailable />
                      )}
                    </dd>
                  </div>
                </dl>
                <p className="panel-footnote">
                  Early share is the fraction of this wallet’s supported buy
                  quantity acquired in the first five blocks after launch.
                  Same-block activity alone does not establish bundling.
                </p>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>PnL share card</h2>
                </div>
                <p className="panel-footnote">
                  1200 × 630 PNG. Includes this pool, window, audit cutoff and
                  before-gas qualification. The server calculates card values
                  from RPC audit data.
                </p>
                <div className="live-share-actions">
                  <button
                    className="button"
                    onClick={() => {
                      setCardError(false);
                      setCard(true);
                    }}
                  >
                    Generate share card
                  </button>
                  <button className="button secondary" onClick={copyLink}>
                    Copy link
                  </button>
                  <button
                    className="button secondary"
                    onClick={() =>
                      window.open(
                        `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl())}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    Post on X
                  </button>
                </div>
                {copy && (
                  <p role="status" className="panel-footnote">
                    {copy}
                  </p>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
      <dialog
        ref={cardDialog}
        className={styles.cardModal}
        aria-labelledby="share-card-title"
        onClose={() => setCard(false)}
        onClick={(e) => {
          if (e.target === cardDialog.current) setCard(false);
        }}
      >
        <div className={styles.cardTop}>
          <h2 id="share-card-title">
            Share card<small>1200 × 630 · selected pool and window</small>
          </h2>
          <button
            className="icon-button"
            aria-label="Close share card"
            onClick={() => setCard(false)}
          >
            ×
          </button>
        </div>
        <div className={styles.cardPreview}>
          {card && !cardError && market ? (
            // The image endpoint uses independently audited data, never client-supplied PnL.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cardUrl}
              alt={`${shortAddress(address)} PnL card for ${market.symbol}`}
              onError={() => setCardError(true)}
            />
          ) : (
            <p className={styles.cardError}>
              A share card needs a completed pool audit. Close this preview and
              audit a covered pool to generate one.
            </p>
          )}
        </div>
        <div className={styles.cardActions}>
          <button className="button secondary" onClick={copyLink}>
            Copy link
          </button>
          <button
            className="button secondary"
            onClick={() =>
              window.open(
                `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl())}`,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            Post on X
          </button>
          {market && !cardError && (
            <a
              className="button"
              href={cardUrl}
              download={`${address}-${period}.png`}
            >
              Download PNG ↗
            </a>
          )}
        </div>
        {copy && (
          <p className="panel-footnote" role="status">
            {copy}
          </p>
        )}
      </dialog>
    </div>
  );
}
export const walletWindows: LiveWindow[] = ["24h", "7d", "30d", "All"];
