"use client";
import Link from "next/link";
import { ArrowRight, Info, Search, Trophy } from "lucide-react";
import { shortAddress, since, type WalletRow, type Window } from "@pools/core";
import { Avatar, EmptyState, Money, Pagination, PeriodTabs } from "./ui";
import { useManifest, useQuery } from "./state";

export function LeaderTable({
  rows,
}: {
  rows: (WalletRow & { rank?: number })[];
}) {
  const manifest = useManifest();
  return (
    <div className="table-scroll">
      <table className="data-table leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Trader</th>
            <th>Realized PnL ↓</th>
            <th>Win rate</th>
            <th className="optional-col">Trades</th>
            <th className="optional-col">Volume</th>
            <th className="optional-col">Last active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w, i) => (
            <tr key={w.address}>
              <td>
                <span className={`rank ${i < 3 ? "top" : ""}`}>
                  {String(w.rank ?? i + 1).padStart(2, "0")}
                </span>
              </td>
              <td>
                <Link className="wallet-cell" href={`/wallet/${w.address}/`}>
                  <Avatar address={w.address} color={w.color} />
                  <span>
                    <strong>{w.label}</strong>
                    <small className="cell-sub mono">
                      {shortAddress(w.address)}
                    </small>
                  </span>
                </Link>
              </td>
              <td>
                <Money wei={w.realizedWei} signed />
              </td>
              <td>
                <span className="win-meter">
                  {w.winRate === null ? "N/A" : `${w.winRate.toFixed(0)}%`}
                  <span className="win-bar">
                    <i style={{ width: `${w.winRate ?? 0}%` }} />
                  </span>
                </span>
                <small className="cell-sub">
                  {w.wins}W / {w.losses}L
                </small>
              </td>
              <td className="optional-col">{w.trades}</td>
              <td className="optional-col">
                <Money wei={w.volumeWei} />
              </td>
              <td className="optional-col muted">
                {since(w.lastActive, manifest.to)} before cutoff
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Traders({ rows }: { rows: Record<Window, WalletRow[]> }) {
  const { params, set } = useQuery();
  const window: Window = params.get("window") === "24h" ? "24h" : "7d";
  const query = params.get("q") ?? "";
  const filtered = rows[window]
    .map((w, i) => ({ ...w, rank: i + 1 }))
    .filter((w) =>
      `${w.label} ${w.address}`.toLowerCase().includes(query.toLowerCase()),
    );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">THE PEOPLE BEHIND THE POOLS</div>
          <h1>
            Trader leaderboard<span className="title-dot">.</span>
          </h1>
          <p>
            Realized performance. Transparent accounting. Every tracked wallet.
          </p>
        </div>
        <Link className="button secondary" href="/wallet/">
          Look up a wallet <ArrowRight size={14} />
        </Link>
      </div>
      <div className="podium">
        {rows[window].slice(0, 3).map((w, i) => (
          <Link
            className="podium-card"
            key={w.address}
            href={`/wallet/${w.address}/`}
          >
            <div className="podium-top">
              <div className="podium-identity">
                <Avatar address={w.address} color={w.color} />
                <span>
                  <strong>{w.label}</strong>
                  <small className="mono">{shortAddress(w.address)}</small>
                </span>
              </div>
              <span className="rank top">
                {i === 0 ? <Trophy size={19} /> : `#${i + 1}`}
              </span>
            </div>
            <div className="podium-amount">
              <Money wei={w.realizedWei} signed />
            </div>
            <div className="podium-bottom">
              <span>{window.toUpperCase()} realized PnL</span>
              <span>{w.trades} eligible trades</span>
            </div>
          </Link>
        ))}
      </div>
      <div className="panel">
        <div className="table-toolbar">
          <h2 style={{ fontSize: 14 }}>
            Top traders <span className="count">{filtered.length}</span>
          </h2>
          <PeriodTabs value={window} onChange={(w) => set({ window: w })} />
        </div>
        <div className="filter-row">
          <label className="filter-input">
            <Search size={15} />
            <input
              name="trader-filter"
              aria-label="Filter traders"
              placeholder="Filter by wallet or label"
              value={query}
              onChange={(e) => set({ q: e.target.value || null })}
            />
          </label>
          <span className="filter-select">10+ trades · instant pools</span>
        </div>
        <LeaderTable rows={filtered} />
        {!filtered.length && (
          <EmptyState
            title="No ranked traders match"
            description="Try a different wallet label or address."
          />
        )}
        <Pagination
          total={filtered.length}
          page={1}
          pageSize={20}
          onChange={() => {}}
        />
      </div>
      <div className="page-intro-note">
        <Info size={14} />
        <span>
          ETH-native average-cost accounting. Gas excluded. Crowd pools and
          unknown-basis positions excluded from rankings.{" "}
          <Link href="/methodology/">How it works</Link>
        </span>
      </div>
    </div>
  );
}
