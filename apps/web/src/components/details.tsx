"use client";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Download,
  Info,
  Share2,
  Shield,
  Users,
  X,
} from "lucide-react";
import {
  shortAddress,
  since,
  sumWei,
  type PoolDetail,
  type WalletDetail,
  type Window,
} from "@pools/core";
import {
  AddressLabel,
  Avatar,
  Change,
  Chart,
  ModeBadge,
  Money,
  PeriodTabs,
  TokenIcon,
  TradeTable,
  WatchButton,
} from "./ui";
import { LeaderTable } from "./traders";
import { useManifest, useQuery } from "./state";

export function PoolView({ detail }: { detail: PoolDetail }) {
  const { pool, trades, traders } = detail;
  const manifest = useManifest();
  const { params, set } = useQuery();
  const window: Window = params.get("window") === "24h" ? "24h" : "7d";
  const points = pool.series.filter(
    (p) => p.time >= manifest.to - (window === "24h" ? 86400 : 604800),
  );
  return (
    <div className="page">
      <div className="breadcrumb">
        <Link href="/">Pools</Link>
        <ChevronRight size={12} />
        <span>{pool.name}</span>
      </div>
      <div className="detail-heading">
        <div className="detail-identity">
          <TokenIcon pool={pool} size="large" />
          <div>
            <h1>
              {pool.name}
              <small>{pool.symbol}</small>
              <ModeBadge mode={pool.mode} />
            </h1>
            <AddressLabel address={pool.token} />
          </div>
        </div>
        <div className="detail-actions">
          <WatchButton id={pool.id} />
          <Link
            className="button secondary"
            href={`/creators/#${pool.creator}`}
          >
            View creator <ArrowRight size={14} />
          </Link>
        </div>
      </div>
      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel">
            <div className="detail-stats">
              <div className="detail-stat">
                <span>Fully diluted value</span>
                <strong>
                  <Money wei={pool.fdvWei} />
                </strong>
              </div>
              <div className="detail-stat">
                <span>{window.toUpperCase()} volume</span>
                <strong>
                  <Money wei={pool.stats[window].volumeWei} />
                </strong>
              </div>
              <div className="detail-stat">
                <span>Liquidity</span>
                <strong>
                  <Money wei={pool.liquidityWei} />
                </strong>
              </div>
              <div className="detail-stat">
                <span>{window.toUpperCase()} change</span>
                <strong>
                  <Change value={pool.stats[window].change} />
                </strong>
              </div>
            </div>
            <div className="panel-heading">
              <h2>
                {pool.symbol} / ETH <span className="badge">Price history</span>
              </h2>
              <PeriodTabs value={window} onChange={(w) => set({ window: w })} />
            </div>
            <Chart points={points} />
            <div className="panel-footnote">
              Price observations from simulated swaps. Hover or use arrow keys
              to inspect.
            </div>
          </section>
          <TradeTable trades={trades} pools={[pool]} showPool={false} />
          <section className="panel">
            <div className="panel-heading">
              <h2>Traders in this pool</h2>
              <span className="subtle-badge">7D</span>
            </div>
            {pool.mode === "crowd" ? (
              <div className="holder-unavailable">
                <Info size={20} />
                <h3>Crowd trades are not ranked</h3>
                <p>
                  Auction entry costs need separate verification. This pool’s
                  trading activity is visible above, but it is excluded from
                  realized PnL rankings.
                </p>
              </div>
            ) : (
              <LeaderTable rows={traders} />
            )}
          </section>
        </div>
        <aside className="market-sidebar">
          <section className="panel">
            <div className="panel-heading">
              <h2>Pool overview</h2>
              <Shield size={15} className="muted" />
            </div>
            <div className="facts">
              <div className="fact-row">
                <span>Network</span>
                <span>Robinhood Chain</span>
              </div>
              <div className="fact-row">
                <span>Launch</span>
                <ModeBadge mode={pool.mode} />
              </div>
              <div className="fact-row">
                <span>Created</span>
                <span>
                  {since(pool.createdAt, manifest.to)} before snapshot
                </span>
              </div>
              <div className="fact-row">
                <span>Total supply</span>
                <span>1,000,000,000</span>
              </div>
              <div className="fact-row">
                <span>LP fee</span>
                <span>0.25%</span>
              </div>
              <div className="fact-row">
                <span>Creator</span>
                <Link
                  className="wallet-link mono"
                  href={`/wallet/${pool.creator}/`}
                >
                  {shortAddress(pool.creator)}
                </Link>
              </div>
              <div className="fact-row">
                <span>Pool ID</span>
                <AddressLabel address={pool.id} />
              </div>
              <div className="fact-row">
                <span>Traders ({window})</span>
                <span>{pool.stats[window].traders}</span>
              </div>
            </div>
            <p className="pool-description">
              {pool.description} All token details on this page are part of the
              demo dataset.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Holder distribution</h2>
              <Users size={15} className="muted" />
            </div>
            <div className="holder-unavailable">
              <h3>Holder data isn’t in this snapshot</h3>
              <p>
                We won’t infer holders from swaps. Verified balances and
                protocol-adjusted concentration will appear when a reliable
                source is connected.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
function ShareCard({ detail }: { detail: WalletDetail }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const path = `/cards/${detail.wallet.address}.png`;
  async function downloadCard() {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error("Card unavailable");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${detail.wallet.label}-demo-pnl.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      setError("The card could not be downloaded. Please try again.");
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/wallet/${detail.wallet.address}/`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard unavailable. Copy the address from your browser.");
    }
  }
  return (
    <>
      <button className="button" onClick={() => dialog.current?.showModal()}>
        <Share2 size={14} /> Share performance
      </button>
      <dialog
        className="share-dialog"
        ref={dialog}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <Image
          src={path}
          width={1200}
          height={630}
          alt={`${detail.wallet.label} simulated seven-day performance card`}
          unoptimized
        />
        <div className="share-actions">
          <a
            className="button"
            href={path}
            download={`${detail.wallet.label}-demo-pnl.png`}
            onClick={(event) => {
              event.preventDefault();
              void downloadCard();
            }}
          >
            <Download size={14} /> Download PNG
          </a>
          <button className="button secondary" onClick={copy}>
            {copied ? "Link copied" : "Copy profile link"}
          </button>
          <button
            className="icon-button"
            aria-label="Close share card"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <p className="share-caption" role="status">
          {error ||
            "Demo label and snapshot date are included in the image. Hosted link previews work after deployment."}
        </p>
      </dialog>
    </>
  );
}
export function WalletView({
  detail,
  rank,
}: {
  detail: WalletDetail;
  rank: number | null;
}) {
  const { params, set } = useQuery();
  const window: Window = params.get("window") === "24h" ? "24h" : "7d";
  const summary = detail.summary[window];
  const manifest = useManifest();
  const from = manifest.to - (window === "24h" ? 86400 : 604800);
  const baseline = BigInt(
    detail.pnlSeries.filter((p) => p.time < from).at(-1)?.wei ?? "0",
  );
  const series = [
    { time: from, wei: "0" },
    ...detail.pnlSeries
      .filter((p) => p.time >= from)
      .map((p) => ({ ...p, wei: (BigInt(p.wei) - baseline).toString() })),
    { time: manifest.to, wei: summary.realizedWei },
  ];
  const positionTab = params.get("positions") ?? "all";
  const positions = detail.positions.filter(
    (p) =>
      positionTab === "all" ||
      (positionTab === "open" ? p.quantity !== "0" : p.quantity === "0"),
  );
  const pools = detail.positions.map((p) => p.pool);
  return (
    <div className="page">
      <div className="breadcrumb">
        <Link href="/traders/">Traders</Link>
        <ChevronRight size={12} />
        <span>{detail.wallet.label}</span>
      </div>
      <div className="detail-heading">
        <div className="detail-identity">
          <Avatar address={detail.wallet.address} color={detail.wallet.color} />
          <div>
            <h1>
              {detail.wallet.label}
              <span className="badge">Demo label</span>
              {rank !== null && <span className="rank-medal">7D #{rank}</span>}
            </h1>
            <AddressLabel address={detail.wallet.address} />
          </div>
        </div>
        <div className="detail-actions">
          <ShareCard detail={detail} />
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat">
          <span>
            Realized PnL{" "}
            <span className="subtle-badge">{window.toUpperCase()}</span>
          </span>
          <strong>
            <Money wei={summary.realizedWei} signed />
          </strong>
          <small>Instant pools · gas excluded</small>
        </div>
        <div className="stat">
          <span>Win rate</span>
          <strong>
            {summary.winRate === null
              ? "N/A"
              : `${summary.winRate.toFixed(0)}%`}
          </strong>
          <small>
            {summary.wins} wins / {summary.losses} losses · closed positions
          </small>
        </div>
        <div className="stat">
          <span>Trade volume</span>
          <strong>
            <Money wei={summary.volumeWei} />
          </strong>
          <small>All pools, buys + sells</small>
        </div>
        <div className="stat">
          <span>Tracked inventory value</span>
          <strong>
            <Money wei={sumWei(detail.positions.map((p) => p.valueWei))} />
          </strong>
          <small>Swap-derived inventory, not wallet balance</small>
        </div>
      </div>
      <section className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-heading">
          <h2>
            Cumulative realized PnL{" "}
            <span className="subtle-badge">{window.toUpperCase()}</span>
          </h2>
          <PeriodTabs value={window} onChange={(w) => set({ window: w })} />
        </div>
        <Chart key={window} points={series} profit label="Cumulative PnL" />
        <div className="panel-footnote">
          Realized gains in the selected period, with cost basis carried from
          earlier trades. Values remain unchanged between sales.
        </div>
      </section>
      <section className="panel" style={{ marginBottom: 24 }}>
        <div className="table-toolbar">
          <div className="table-tabs">
            {["all", "open", "closed"].map((t) => (
              <button
                key={t}
                className={positionTab === t ? "active" : ""}
                onClick={() => set({ positions: t === "all" ? null : t })}
              >
                {t === "all"
                  ? "All positions"
                  : t === "open"
                    ? "Open positions"
                    : "Closed positions"}
              </button>
            ))}
          </div>
          <span className="count">{positions.length}</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Status</th>
                <th>Realized PnL (7D)</th>
                <th>Unrealized</th>
                <th>Remaining basis</th>
                <th>Buys / sells</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.poolId}>
                  <td>
                    <Link className="token-cell" href={`/pool/${p.poolId}/`}>
                      <TokenIcon pool={p.pool} />
                      <span>
                        <strong>{p.pool.name}</strong>
                        <small className="cell-sub">{p.pool.symbol}</small>
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="badge">
                      {p.quantity === "0" ? "Closed" : "Open"}
                    </span>
                    {p.pool.mode === "crowd" && (
                      <small className="cell-sub">Crowd · unranked</small>
                    )}
                  </td>
                  <td>
                    {p.realizedWei === null ? (
                      <span className="muted">Unknown basis</span>
                    ) : (
                      <Money wei={p.realizedWei} signed />
                    )}
                  </td>
                  <td>
                    {p.unrealizedWei === null ? (
                      "Unavailable"
                    ) : (
                      <Money wei={p.unrealizedWei} signed />
                    )}
                  </td>
                  <td>
                    <Money wei={p.costWei} />
                  </td>
                  <td className="muted">
                    {p.buys} / {p.sells}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {positions.length === 0 && (
          <div className="empty-state">
            <h3>No {positionTab} positions</h3>
            <p>Try another position filter.</p>
          </div>
        )}
      </section>
      <TradeTable trades={detail.trades} pools={pools} />
      <div className="page-intro-note">
        <Info size={14} />
        <span>
          Position PnL uses the full snapshot; the ranked total excludes crowd
          pools. Unrealized values use snapshot prices and may not be
          realizable. <Link href="/methodology/">Coverage and methodology</Link>
        </span>
      </div>
      <Link className="button secondary" href="/traders/">
        <ArrowLeft size={14} /> Back to traders
      </Link>
    </div>
  );
}
