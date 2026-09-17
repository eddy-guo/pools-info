"use client";
import Link from "next/link";
import { Fragment, useState } from "react";
import {
  shortAddress,
  poolHref,
  since,
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
import { MyWalletButton, useMyWallet } from "./my-wallet";
import { PoolImage } from "./pool-image";
import { useQuery } from "./state";
import { WalletTokenTransfers, WalletTransactions } from "./wallet-history";
import { PnlCardModal } from "./pnl-card-modal";
import { CopyTradePreview } from "./copy-trade-preview";
import styles from "./detail-design.module.css";
/** Saved profile tabs first, then the wallet's own on-demand explorer history. */
const tabs = [
  { id: "positions", label: "Positions" },
  { id: "trades", label: "Trades" },
  { id: "launches", label: "Launches" },
  { id: "transactions", label: "Transactions" },
  { id: "token-transfers", label: "Token transfers" },
];
/**
 * The export's tab counts, from the rows the read sent: a bounded list has
 * no total, so its tab carries no count. The slot is reserved at three
 * digits so a count arriving moves no tab beside it.
 */
function tabCount(data: AnalyticsWalletResponse | undefined, id: string) {
  if (!data) return null;
  if (id === "positions")
    return data.positionsTruncated ? null : data.positions.length;
  if (id === "trades") return data.tradesTruncated ? null : data.trades.length;
  if (id === "launches")
    return data.launchesTruncated ? null : data.launches.length;
  return null;
}
const historyTabs = ["transactions", "token-transfers"];
/** The export's four alert toggles, drawn off until alerts exist. */
const alerts = (creator: boolean) => [
  ["Every trade", "Buy or sell, within the block"],
  creator
    ? ["New launch", "When this wallet launches a pool"]
    : ["First launch", "If this wallet ever launches a pool"],
  ["Large exit", "Sells over 25% of a position"],
  ["Leaderboard move", "Enters or leaves the top 100"],
];
/**
 * The export's five behaviour bars from the figures the wallet read carries:
 * a bar is a share of a real denominator, and a figure the read does not
 * have leaves its bar and value empty rather than inventing one.
 */
function behaviour(data: AnalyticsWalletResponse | undefined) {
  const w = data?.wallet;
  const wins = w?.wins ?? 0,
    losses = w?.losses ?? 0,
    closed = wins + losses;
  const known = (data?.positions ?? []).flatMap((p) =>
    p.position ? [p.position] : [],
  );
  const held = known.filter((p) => BigInt(p.quantity) > 0n).length;
  const total = w ? BigInt(w.volumeWei) : 0n;
  const top = (data?.positions ?? []).reduce(
    (best, p) => (BigInt(p.volumeWei) > best ? BigInt(p.volumeWei) : best),
    0n,
  );
  const topShare = total > 0n ? Number((top * 10000n) / total) / 10000 : null;
  const pct = (share: number | null) =>
    share === null ? null : `${Math.round(share * 100)}%`;
  return [
    {
      label: "Win rate",
      value: pct(w?.winRate == null ? null : w.winRate / 100),
      share: w?.winRate == null ? 0 : w.winRate / 100,
      tone: "up",
    },
    {
      label: "Wins",
      value: w ? String(wins) : null,
      share: closed ? wins / closed : 0,
      tone: "up",
    },
    {
      label: "Losses",
      value: w ? String(losses) : null,
      share: closed ? losses / closed : 0,
      tone: "down",
    },
    {
      label: "Still held",
      value: known.length ? `${held} of ${known.length}` : null,
      share: known.length ? held / known.length : 0,
      tone: "accent",
    },
    {
      label: "Volume in top pool",
      value: pct(topShare),
      share: topShare ?? 0,
      tone: "muted",
    },
  ];
}
export function ProductWallet({ address }: { address: string }) {
  const { window: period, setWindow } = useWindow("All");
  const { params, set } = useQuery();
  const { data, loading, stale, error } = useProduct<AnalyticsWalletResponse>(
    `wallets/${address.toLowerCase()}?window=${period}`,
  );
  // The browser's own wallet reads as its portfolio; the server paints the
  // public framing and hydration swaps whole nodes, never text in place.
  const mine = useMyWallet().isMine(address);
  const tab = tabs.find((t) => t.id === params.get("tab"))?.id ?? "positions",
    [opened, setOpened] = useState<string[]>([]),
    [copyTrade, setCopyTrade] = useState(false),
    [card, setCard] = useState(false),
    // A clock frozen at mount: the header's "last Nm ago" only ever paints
    // once data resolves, so nothing already on screen depends on it ticking.
    [renderedAt] = useState(() => Math.floor(Date.now() / 1000));
  // An explorer page costs credits, so a tab keeps its pages once opened
  // instead of paying for them again on every visit.
  if (historyTabs.includes(tab) && !opened.includes(tab))
    setOpened([...opened, tab]);
  const w = data?.wallet;
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
        <span key={mine ? "portfolio" : "address"}>
          {mine ? "Portfolio" : shortAddress(address)}
        </span>
      </nav>
      <div className="page-heading">
        <div className={styles.identity}>
          <Avatar address={address} large />
          <div>
            <div className={styles.title}>
              <Fragment key={mine ? "portfolio" : "address"}>
                <h1>{mine ? "Portfolio" : shortAddress(address)}</h1>
                <span className={styles.mode} data-pending={!data}>
                  {w?.rank
                    ? `RANK ${w.rank}`
                    : data
                      ? "UNRANKED"
                      : "RANK PENDING"}
                </span>
              </Fragment>
            </div>
            <div className="wallet-meta">
              <AddressLabel address={address} full />
              {/* The read carries only a last-trade timestamp today; a date
                  it does not send (first trade) leaves its segment out
                  rather than showing a placeholder. The slot itself stays in
                  the flex row from first paint either way, so the address
                  beside it never reflows once the fact resolves. */}
              <span className="wallet-last-meta-slot">
                {w?.last != null && (
                  <span className="wallet-last-meta">
                    last{" "}
                    <time
                      dateTime={new Date(w.last * 1000).toISOString()}
                      title={utc(w.last)}
                    >
                      {since(w.last, renderedAt)}
                    </time>{" "}
                    ago
                  </span>
                )}
              </span>
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
          <button className="button secondary" onClick={() => setCard(true)}>
            Share PnL card
          </button>
          <FollowButton address={address} />
          <MyWalletButton address={address} />
          <button
            className="button"
            aria-haspopup="dialog"
            onClick={() => setCopyTrade(true)}
          >
            Copy trade
          </button>
        </div>
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
                className="table-tabs"
                role="tablist"
                aria-label="Wallet activity"
              >
                {tabs.map((t) => {
                  const count = tabCount(data, t.id);
                  return (
                    <button
                      role="tab"
                      aria-selected={tab === t.id}
                      key={t.id}
                      onClick={() => set({ tab: t.id })}
                    >
                      {t.label}
                      {!historyTabs.includes(t.id) && (
                        <span className="tab-count">
                          {/* Keyed so a count replaces its node rather than
                              rewriting text in place. */}
                          {count !== null && (
                            <Fragment key={count}>{count}</Fragment>
                          )}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {tab === "positions" && (
                <>
                  <div
                    className="table-region"
                    data-empty={!!data && !data.positions.length}
                  >
                    <div
                      className="table-scroll wallet-list-region"
                      aria-busy={stale}
                      data-stale-rows={stale}
                    >
                      <table className="data-table wallet-positions-table">
                        {/* Fixed pixel widths, not percentages: a fractional
                            percentage of the panel's own width can round to
                            a different sub-pixel value between layout
                            passes, which the layout-shift observer scores
                            even though nothing visibly moves. */}
                        <colgroup>
                          <col />
                          <col style={{ width: "150px" }} />
                          <col style={{ width: "150px" }} />
                          <col style={{ width: "150px" }} />
                          <col style={{ width: "150px" }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Token</th>
                            <th>Holding</th>
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
                                  <Link
                                    className="wallet-token-cell"
                                    href={poolHref({
                                      id: p.poolId,
                                      launchTx: p.launchTx,
                                    })}
                                  >
                                    <Avatar address={p.token} />
                                    <span>{p.symbol}</span>
                                  </Link>
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
                <h2>Alerts</h2>
              </div>
              <div className="wallet-alerts">
                {alerts(!!data?.launches.length).map(([label, note]) => (
                  <button
                    type="button"
                    className={styles.alert}
                    key={label}
                    aria-pressed={false}
                    disabled
                  >
                    <span>
                      {label}
                      <small>{note}</small>
                    </span>
                    <span className={styles.switch} aria-hidden="true" />
                  </button>
                ))}
              </div>
              <p className="panel-footnote">Alerts are not available yet.</p>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Behaviour</h2>
              </div>
              <div className="wallet-behaviour" aria-busy={!data || stale}>
                {behaviour(data).map((b) => (
                  <div className="wallet-behaviour-row" key={b.label}>
                    <span>{b.label}</span>
                    <span className="number" data-pending={!data}>
                      {/* Keyed so a value replaces its node: rewriting
                          right-aligned text in place moves its start. */}
                      {!data ? (
                        "Pending"
                      ) : b.value === null ? null : (
                        <Fragment key={b.value}>{b.value}</Fragment>
                      )}
                    </span>
                    <span
                      className="wallet-behaviour-bar"
                      data-tone={b.tone}
                      aria-hidden="true"
                    >
                      <i
                        style={{
                          width: `${Math.round(Math.min(1, Math.max(0, b.share)) * 100)}%`,
                        }}
                      />
                    </span>
                  </div>
                ))}
              </div>
            </section>
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
                      <span className="avatar small" data-pending="true" />
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
                    <PoolImage
                      poolId={p.poolId}
                      token={p.token}
                      hasImage={false}
                      size="small"
                    />
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
            <ComingSoonRow items={["Copy trading", "Profile editing"]} />
          </aside>
        </div>
      </>
      <CopyTradePreview open={copyTrade} onClose={() => setCopyTrade(false)} />
      <PnlCardModal
        address={address}
        window={period}
        open={card}
        onClose={() => setCard(false)}
      />
    </div>
  );
}
