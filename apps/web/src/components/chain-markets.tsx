"use client";
import { useState } from "react";
import { ArrowUpRight, Search, ShieldCheck } from "lucide-react";
import { shortAddress, type ChainSnapshot } from "@pools/core";
import { Sparkline } from "./ui";

const explorer = "https://robinhoodchain.blockscout.com";
const eth = (wei: string) =>
  new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 }).format(
    Number(wei) / 1e18,
  );
const date = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
export function ChainMarkets({ snapshot: s }: { snapshot: ChainSnapshot }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(s.markets[0]?.id);
  const markets = s.markets.filter((p) =>
    `${p.name} ${p.symbol} ${p.token} ${p.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selected = s.markets.find((p) => p.id === selectedId)!;
  const trades = s.trades.filter((t) => t.poolId === selectedId);
  return (
    <div className="page chain-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ROBINHOOD CHAIN / REAL MARKET DATA</div>
          <h1>
            On-chain markets<span className="title-dot">.</span>
          </h1>
          <p>
            Recent instant launches. Actual swaps. Every number has a source.
          </p>
        </div>
        <div className="heading-note">
          <ShieldCheck size={18} />
          <span>
            Chain 4663
            <br />
            <small>Through {date(s.toTimestamp)} UTC</small>
          </span>
        </div>
      </div>
      <div className="chain-coverage">
        <span className="chain-status-dot" />
        <div>
          <strong>On-chain snapshot</strong>
          <p>
            Captured {date(Math.floor(Date.parse(s.generatedAt) / 1000))} UTC.
            Newest {s.markets.length} of {s.discoveredLaunches} instant launches
            discovered between blocks {s.fromBlock.toLocaleString("en-US")} and{" "}
            {s.toBlock.toLocaleString("en-US")}. Each pool includes swaps from
            its launch to that cutoff. This is a captured dataset, not a
            streaming feed.
          </p>
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat">
          <span>Observed swap volume</span>
          <strong>
            {eth(
              s.markets
                .reduce((n, p) => n + BigInt(p.volumeWei), 0n)
                .toString(),
            )}{" "}
            <span className="stat-side">ETH</span>
          </strong>
          <small>Since each selected pool launched</small>
        </div>
        <div className="stat">
          <span>Recorded swaps</span>
          <strong>{s.trades.length.toLocaleString("en-US")}</strong>
          <small>Decoded from the v4 PoolManager</small>
        </div>
        <div className="stat">
          <span>New pools covered</span>
          <strong>{s.markets.length}</strong>
          <small>Official instant-launch strategies</small>
        </div>
        <div className="stat">
          <span>Source cutoff</span>
          <strong className="chain-block">
            {s.toBlock.toLocaleString("en-US")}
          </strong>
          <small>128 blocks behind scan head, not L1-finalized</small>
        </div>
      </div>
      <div className="chain-workspace">
        <section className="panel">
          <div className="panel-heading">
            <h2>Recent launches</h2>
            <span className="subtle-badge">REAL DATA · ETH</span>
          </div>
          <div className="filter-row">
            <label className="filter-input">
              <Search size={15} />
              <input
                name="chain-search"
                aria-label="Filter on-chain pools"
                placeholder="Token, symbol, or address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="chain-pool-list">
            {markets.map((p) => (
              <button
                key={p.id}
                className={`chain-pool-row ${p.id === selectedId ? "selected" : ""}`}
                onClick={() => setSelectedId(p.id)}
                aria-pressed={p.id === selectedId}
              >
                <span className="chain-token-icon">{p.symbol.slice(0, 2)}</span>
                <span className="chain-token-name">
                  <strong>{p.name}</strong>
                  <small>
                    {p.symbol} · {date(p.launchedAt)} UTC
                  </small>
                </span>
                <span className="align-right">
                  <strong>{p.priceWei ? eth(p.priceWei) : "N/A"}</strong>
                  <small>ETH / token</small>
                </span>
                <span className="chain-row-volume align-right">
                  <strong>{eth(p.volumeWei)} ETH</strong>
                  <small>{p.swaps} swaps</small>
                </span>
              </button>
            ))}
            {!markets.length && (
              <div className="empty-state">
                <h3>No matching on-chain pools</h3>
                <p>Try a symbol or token address.</p>
              </div>
            )}
          </div>
        </section>
        <aside className="panel chain-detail">
          <div className="panel-heading">
            <h2>{selected.symbol}</h2>
            <span className="subtle-badge">INSTANT</span>
          </div>
          <div className="chain-detail-body">
            <h3>{selected.name}</h3>
            <div className="chain-spot">
              {selected.priceWei ? eth(selected.priceWei) : "No swaps"}{" "}
              <small>{selected.priceWei ? "ETH / token" : ""}</small>
            </div>
            <p className="chain-muted">
              Spot price after the last captured swap.
            </p>
            <div className="chain-chart">
              <Sparkline
                points={selected.series}
                positive={
                  selected.series.length < 2 ||
                  BigInt(selected.series.at(-1)!.wei) >=
                    BigInt(selected.series[0].wei)
                }
              />
            </div>
            <dl className="chain-facts">
              <div>
                <dt>Observed volume</dt>
                <dd>{eth(selected.volumeWei)} ETH</dd>
              </div>
              <div>
                <dt>Buys / sells</dt>
                <dd>
                  {selected.buys} / {selected.sells}
                </dd>
              </div>
              <div>
                <dt>Pool fee</dt>
                <dd>{selected.fee / 10000}%</dd>
              </div>
              <div>
                <dt>Creator fee strategy</dt>
                <dd>{selected.creatorFees ? "Enabled" : "Disabled"}</dd>
              </div>
              <div>
                <dt>Launch sender</dt>
                <dd>
                  <a
                    href={`${explorer}/address/${selected.launchSender}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(selected.launchSender)} ↗
                  </a>
                </dd>
              </div>
            </dl>
            <a
              className="button chain-link"
              href={`${explorer}/token/${selected.token}`}
              target="_blank"
              rel="noreferrer"
            >
              Token contract <ArrowUpRight size={14} />
            </a>
            <a
              className="button chain-link"
              href={`${explorer}/tx/${selected.launchTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Launch transaction <ArrowUpRight size={14} />
            </a>
            <p className="chain-muted">
              Launch sender is the transaction origin, not a verified creator
              identity. Liquidity, holders, USD prices, and wallet PnL are not
              yet reported for this dataset.
            </p>
          </div>
        </aside>
      </div>
      <section className="panel chain-trades">
        <div className="panel-heading">
          <h2>{selected.symbol} swaps</h2>
          <span className="subtle-badge">
            LATEST {Math.min(20, trades.length)}
          </span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Side</th>
                <th>ETH amount</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 20).map((t) => (
                <tr key={`${t.txHash}:${t.logIndex}`}>
                  <td>{date(t.timestamp)}</td>
                  <td className={t.side === "buy" ? "positive" : "negative"}>
                    {t.side}
                  </td>
                  <td>{eth(t.ethWei)}</td>
                  <td>
                    <a
                      className="mono"
                      href={`${explorer}/tx/${t.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddress(t.txHash)} ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!trades.length && (
            <div className="empty-state">No swaps before the cutoff.</div>
          )}
        </div>
      </section>
      <section className="chain-evidence">
        <ShieldCheck size={20} />
        <div>
          <h2>Check the evidence</h2>
          <p>
            Events are decoded from official Uniswap deployments. Pool IDs are
            checked against their PoolKey; block hashes and successful receipts
            are checked during collection. No demo trades enter this view.
          </p>
          {s.reconciliation && (
            <p>
              One receipt’s token movement{" "}
              {s.reconciliation.matches ? "matches" : "does not match"} its pool
              swap deltas for the transaction sender.{" "}
              <a
                href={`${explorer}/tx/${s.reconciliation.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                Inspect reconciliation ↗
              </a>{" "}
              This does not establish historical cost basis.
            </p>
          )}
          <p>
            <a
              href="https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments"
              target="_blank"
              rel="noreferrer"
            >
              Launch contracts ↗
            </a>{" "}
            ·{" "}
            <a
              href="https://developers.uniswap.org/docs/protocols/v4/deployments"
              target="_blank"
              rel="noreferrer"
            >
              PoolManager deployment ↗
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
