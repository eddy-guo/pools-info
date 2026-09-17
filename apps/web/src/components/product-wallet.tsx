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
import { AddressLabel, Avatar, Change, Chart, EmptyState } from "./ui";
import { ComingSoonRow } from "./feature-preview";
import { FollowButton } from "./following";
import { useQuery } from "./state";
import { WalletTokenTransfers, WalletTransactions } from "./wallet-history";
import styles from "./detail-design.module.css";
/** Saved profile tabs first, then the wallet's own on-demand explorer history. */
const tabs = [
  { id: "positions", label: "Positions" },
  { id: "trades", label: "Trades" },
  { id: "launches", label: "Launches" },
  { id: "transactions", label: "Transactions" },
  { id: "token-transfers", label: "Token transfers" },
];
const historyTabs = ["transactions", "token-transfers"];
export function ProductWallet({ address }: { address: string }) {
  const { window: period, setWindow } = useWindow("All");
  const { params, set } = useQuery();
  const { data, loading, stale, error } = useProduct<AnalyticsWalletResponse>(
    `wallets/${address.toLowerCase()}?window=${period}`,
  );
  const tab = tabs.find((t) => t.id === params.get("tab"))?.id ?? "positions",
    [opened, setOpened] = useState<string[]>([]),
    [showSignals, setShowSignals] = useState(false),
    [copied, setCopied] = useState(false),
    [card, setCard] = useState(false),
    [cardError, setCardError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  // An explorer page costs credits, so a tab keeps its pages once opened
  // instead of paying for them again on every visit.
  if (historyTabs.includes(tab) && !opened.includes(tab))
    setOpened([...opened, tab]);
  useEffect(() => {
    if (card) dialog.current?.showModal();
    else dialog.current?.close();
  }, [card]);
  const w = data?.wallet,
    cardUrl = `/cards/${address.toLowerCase()}.png?window=${period}`;
  const topPools = (data?.positions ?? [])
    .slice()
    .sort((a, b) => (BigInt(b.volumeWei) > BigInt(a.volumeWei) ? 1 : -1))
    .slice(0, 5);
  const pct = (n: number | null | undefined) =>
    n == null ? <Unavailable /> : <span>{n.toFixed(1)}%</span>;
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
            </div>
            <AddressLabel address={address} full />
          </div>
        </div>
        <div className={styles.actions}>
          <button
            className="button"
            aria-expanded={showSignals}
            aria-controls="wallet-signals"
            onClick={() => setShowSignals(!showSignals)}
          >
            {showSignals ? "Hide copy signals" : "View copy signals"}
          </button>
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
        </div>
      </div>
      {showSignals && (
        <FollowActivity addresses={[address.toLowerCase()]} mode="wallet" />
      )}
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
          <Stat pending={loading && !data} label="Realized PnL">
            <Eth pending={!data} wei={w?.realizedWei} signed digits={5} />
          </Stat>
          <Stat pending={loading && !data} label="Unrealized">
            <Eth pending={!data} wei={w?.unrealizedWei} signed digits={5} />
          </Stat>
          <Stat pending={loading && !data} label="ROI">
            {w?.roi == null ? (
              <Unavailable />
            ) : (
              <Change value={w.roi} digits={1} />
            )}
          </Stat>
          <Stat pending={loading && !data} label="Win rate">
            {pct(w?.winRate)}
          </Stat>
          <Stat pending={loading && !data} label="Trades">
            {w?.rankingTradeCount ?? w?.supportedTradeCount ?? <Unavailable />}
          </Stat>
          <Stat pending={loading && !data} label="Volume">
            <Eth pending={!data} wei={w?.volumeWei} digits={5} />
          </Stat>
          <Stat pending={loading && !data} label="Avg hold">
            {w?.avgHold == null ? <Unavailable /> : `${Math.round(w.avgHold)}s`}
          </Stat>
          <Stat pending={loading && !data} label="Best trade">
            <Eth pending={!data} wei={w?.bestWei} signed digits={5} />
          </Stat>
        </div>
        <div className="workspace-grid">
          <div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Cumulative realized PnL</h2>
                <WindowTabs value={period} onChange={setWindow} />
              </div>
              <div className="wallet-chart-region" data-pending={!data}>
                <Chart
                  points={data?.curve ?? []}
                  pending={!data}
                  profit
                  label="Cumulative realized PnL"
                />
              </div>
            </section>
            <section className="panel live-section">
              <div
                className={styles.tabs}
                role="tablist"
                aria-label="Wallet activity"
              >
                {tabs.map((t) => (
                  <button
                    role="tab"
                    aria-selected={tab === t.id}
                    key={t.id}
                    onClick={() => set({ tab: t.id })}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {tab === "positions" && (
                <>
                  <div className="panel-heading">
                    <h2>Positions by pool</h2>
                  </div>
                  <div
                    className="table-region"
                    data-empty={!!data && !data.positions.length}
                  >
                    <div
                      className="table-scroll wallet-list-region"
                      aria-busy={stale}
                      data-stale-rows={stale}
                    >
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Token</th>
                            <th>Inventory</th>
                            <th>Cost</th>
                            <th>Realized</th>
                            <th>Unrealized</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.from(
                            {
                              length: Math.max(25, data?.positions.length ?? 0),
                            },
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
                                {p || !data ? (
                                  <Eth
                                    pending={!data}
                                    wei={p?.position?.costWei}
                                  />
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                              <td data-pending={!p && !data}>
                                {p || !data ? (
                                  <Eth
                                    pending={!data}
                                    wei={p?.realizedWei}
                                    signed
                                  />
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                              <td data-pending={!p && !data}>
                                {p || !data ? (
                                  <Eth
                                    pending={!data}
                                    wei={p?.unrealizedWei}
                                    signed
                                  />
                                ) : (
                                  "\u00a0"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {data && !data.positions.length && (
                      <EmptyState
                        title="No positions in this window"
                        description="Select All to see this wallet's full history."
                      />
                    )}
                  </div>
                  {data?.positionsTruncated && (
                    <p className="panel-footnote">
                      Showing the first {data.positions.length} positions.
                    </p>
                  )}
                </>
              )}
              {tab === "trades" && (
                <>
                  <div className="panel-heading">
                    <h2>Trade history</h2>
                  </div>
                  <div
                    className="table-scroll wallet-list-region"
                    aria-busy={stale}
                    data-stale-rows={stale}
                  >
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Time (UTC)</th>
                          <th>Pool</th>
                          <th>Side</th>
                          <th>ETH</th>
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
                      Showing the latest {data.trades.length} trades.
                    </p>
                  )}
                </>
              )}
              {tab === "launches" && (
                <>
                  <div className="panel-heading">
                    <h2>Launches · {data?.launches.length ?? 0}</h2>
                  </div>
                  <div
                    className="table-scroll wallet-list-region"
                    aria-busy={stale}
                    data-stale-rows={stale}
                  >
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
                      Showing the latest {data.launches.length} launches.
                    </p>
                  )}
                </>
              )}
              {opened.includes("transactions") && (
                <WalletTransactions
                  wallet={address.toLowerCase()}
                  active={tab === "transactions"}
                />
              )}
              {opened.includes("token-transfers") && (
                <WalletTokenTransfers
                  wallet={address.toLowerCase()}
                  active={tab === "token-transfers"}
                />
              )}
            </section>
          </div>
          <aside className="market-sidebar">
            <section className="panel">
              <div className="panel-heading">
                <h2>Most traded pools</h2>
              </div>
              <div
                className="wallet-top-pools"
                aria-busy={!data || stale}
                data-stale-rows={stale}
              >
                {!data &&
                  Array.from({ length: 5 }, (_, index) => (
                    <div
                      className="wallet-top-pool"
                      key={index}
                      aria-hidden="true"
                    >
                      <span data-pending="true">Pool pending</span>
                      <span className="number" data-pending="true">
                        Pending
                      </span>
                    </div>
                  ))}
                {topPools.map((p) => (
                  <Link
                    className="wallet-top-pool"
                    key={p.poolId}
                    href={poolHref({ id: p.poolId, launchTx: p.launchTx })}
                  >
                    <span>
                      <strong>{p.symbol}</strong>
                      <small>
                        <Eth wei={p.volumeWei} /> traded
                      </small>
                    </span>
                    <Eth wei={p.realizedWei} signed />
                  </Link>
                ))}
                {data && !topPools.length && (
                  <p className="panel-footnote">
                    No pool activity in this window.
                  </p>
                )}
              </div>
            </section>
            <ComingSoonRow
              items={["Copy trading", "Alerts", "Profile editing"]}
            />
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
        {card && !cardError ? ( // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cardUrl}
            alt="Saved wallet PnL card"
            style={{
              width: "100%",
              maxWidth: 800,
              display: "block",
              margin: "20px auto 0",
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
