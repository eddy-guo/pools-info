"use client";
import Link from "next/link";
import { useState } from "react";
import {
  walletMetrics,
  walletHref,
  shortAddress,
  poolHref,
  type LiveWindow,
} from "@pools/core";
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
} from "./live-ui";
export function WalletView({ address }: { address: string }) {
  const { market, error, loading } = useSelectedMarket(),
    { audits } = useLive(),
    { window: period, setWindow } = useWindow();
  const a = market ? audits[market.id] : undefined,
    m = a ? walletMetrics(a, address, period) : null;
  const [card, setCard] = useState(false),
    [copy, setCopy] = useState("");
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
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">WALLET PROFILE / VERIFIED COVERAGE</div>
          <h1>
            {shortAddress(address)}
            <span className="title-dot">.</span>
          </h1>
          <AddressLabel address={address} full />
          <p>
            Any address, no account. Metrics below cover one audited pool; they
            are not wallet-wide totals.
          </p>
        </div>
        <Link className="button secondary" href="/wallet/">
          Look up another wallet
        </Link>
      </div>
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
          {pct(m?.roi)}
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
                  <h2>Cumulative realized PnL · {period}</h2>
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
              <section className="panel live-section">
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
              <section className="panel live-section">
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
                  <button className="button" onClick={() => setCard(true)}>
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
                {card && (
                  <>
                    <a
                      className="leader-link"
                      href={cardUrl}
                      download={`${address}-${period}.png`}
                    >
                      Download PNG ↗
                    </a>
                    <p className="panel-footnote">
                      <a href={cardUrl} target="_blank" rel="noreferrer">
                        Open card preview
                      </a>
                    </p>
                  </>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
export const walletWindows: LiveWindow[] = ["24h", "7d", "30d", "All"];
