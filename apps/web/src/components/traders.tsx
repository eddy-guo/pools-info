"use client";
import Link from "next/link";
import { ProductTraders } from "./product-traders";
import { useQuery } from "./state";
import { useState } from "react";
import { ArrowUpRight, ShieldCheck, Trophy } from "lucide-react";
import {
  walletMetrics,
  walletHref,
  shortAddress,
  type PoolAudit,
  type LiveWindow,
} from "@pools/core";
import { PersonalRankPreview } from "./feature-preview";
import { useLive } from "./live-provider";
import { Avatar, Change } from "./ui";
import {
  AuditAction,
  Eth,
  PoolPicker,
  Unavailable,
  useSelectedMarket,
  useWindow,
  WindowTabs,
  utc,
} from "./live-ui";
function RecordBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  return (
    <span className="record-cell">
      <span className="record-bar" aria-hidden="true">
        <i style={{ width: `${total ? (wins / total) * 100 : 0}%` }} />
        <b style={{ width: `${total ? (losses / total) * 100 : 0}%` }} />
      </span>
      <small>
        <span className={wins ? "positive" : "muted"}>{wins}W</span> /{" "}
        <span className={losses ? "negative" : "muted"}>{losses}L</span>
      </small>
    </span>
  );
}
export function AuditLeaderboard({
  audit,
  window = "All",
}: {
  audit: PoolAudit;
  window?: LiveWindow;
}) {
  const [minimum, setMinimum] = useState(10),
    [metric, setMetric] = useState("realized"),
    [noBuy, setNoBuy] = useState(true),
    [oversold, setOversold] = useState(true),
    [fast, setFast] = useState(false),
    [flat, setFlat] = useState(false);
  const rows = audit.wallets
    .map((w) => walletMetrics(audit, w.address, window)!)
    .filter(
      (w) =>
        w.complete &&
        w.trades.length >= minimum &&
        (!noBuy || !w.didNotBuy) &&
        (!oversold || !w.soldMoreThanBought) &&
        (!fast || !w.fastHoldShare),
    )
    .sort((a, b) => {
      const av = BigInt(metric === "realized" ? a.realizedWei! : a.netWei!),
        bv = BigInt(metric === "realized" ? b.realizedWei! : b.netWei!);
      return av > bv
        ? -1
        : av < bv
          ? 1
          : a.row.address.localeCompare(b.row.address);
    });
  const showPodium = !flat && rows.length >= 3;
  const listRows = showPodium ? rows.slice(3) : rows;
  const rankOffset = showPodium ? 3 : 0;
  return (
    <div className="leaderboard-results">
      <div className="live-controls ranking-controls">
        <div className="segmented" aria-label="Ranking metric">
          <button
            aria-pressed={metric === "realized"}
            onClick={() => setMetric("realized")}
          >
            Realized PnL
          </button>
          <button
            aria-pressed={metric === "net"}
            onClick={() => setMetric("net")}
          >
            Net ETH
          </button>
        </div>
        <div className="segmented" aria-label="Leaderboard layout">
          <button aria-pressed={!flat} onClick={() => setFlat(false)}>
            Podium
          </button>
          <button aria-pressed={flat} onClick={() => setFlat(true)}>
            Flat list
          </button>
        </div>
      </div>
      {showPodium && (
        <div className="live-podium">
          {rows.slice(0, 3).map((w, i) => (
            <Link
              href={walletHref(w.row.address, audit.market)}
              key={w.row.address}
            >
              <div className="podium-identity">
                <span className={`podium-rank place-${i + 1}`}>{i + 1}</span>
                <span>
                  <strong>{shortAddress(w.row.address)}</strong>
                </span>
                <ArrowUpRight size={15} />
              </div>
              <div className="podium-value">
                <Eth
                  wei={metric === "realized" ? w.realizedWei : w.netWei}
                  signed
                />
              </div>
              <div className="podium-description">
                {metric === "realized" ? "realized" : "net flow"} · ROI{" "}
                {w.roi === null ? <Unavailable /> : <Change value={w.roi} />}
              </div>
              <RecordBar wins={w.wins} losses={w.losses} />
              <span className="podium-trades">{w.trades.length} swaps</span>
            </Link>
          ))}
        </div>
      )}
      <div className="live-filters">
        <span className="filter-caption">
          <ShieldCheck size={13} /> Anti-gaming filters
        </span>
        <label>
          <input
            type="checkbox"
            checked={noBuy}
            onChange={(e) => setNoBuy(e.target.checked)}
          />
          Exclude no-purchase histories
        </label>
        <label>
          <input
            type="checkbox"
            checked={oversold}
            onChange={(e) => setOversold(e.target.checked)}
          />
          Exclude sold more than bought
        </label>
        <label>
          <input
            type="checkbox"
            checked={fast}
            onChange={(e) => setFast(e.target.checked)}
          />
          Exclude closed holds under 60s
        </label>
        <label
          title="No blacklist data source is connected"
          className="disabled-filter"
        >
          <input type="checkbox" disabled />
          Known-bad tokens <small>Unavailable</small>
        </label>
        <label className="minimum-filter">
          Minimum swaps
          <select
            aria-label="Minimum swaps"
            value={minimum}
            onChange={(e) => setMinimum(Number(e.target.value))}
          >
            {[10, 25, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="ranking-scope">
        <span className="subtle-badge">{audit.market.symbol} ONLY</span>
        <p>
          Ranked across supported positions in this pool.{" "}
          {metric === "net"
            ? "Net ETH includes spending on unsold inventory."
            : "Realized PnL before gas, using verified cost basis."}
        </p>
      </div>
      <div className="table-scroll desktop-traders">
        <table className="data-table trader-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Trader</th>
              <th>{metric === "realized" ? "Realized PnL" : "Net ETH"}</th>
              <th>Realized ROI</th>
              <th>Record</th>
              <th>Swaps</th>
              <th>Volume</th>
              <th>Avg hold</th>
              <th>Best sale</th>
              <th>Last (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {listRows.map((w, i) => (
              <tr key={w.row.address}>
                <td className="rank-number">{i + 1 + rankOffset}</td>
                <td>
                  <Link
                    className="trader-identity"
                    href={walletHref(w.row.address, audit.market)}
                  >
                    <Avatar address={w.row.address} small />
                    <span className="mono">{shortAddress(w.row.address)}</span>
                  </Link>
                </td>
                <td>
                  <Eth
                    wei={metric === "realized" ? w.realizedWei : w.netWei}
                    signed
                  />
                </td>
                <td>
                  {w.roi === null ? <Unavailable /> : <Change value={w.roi} />}
                </td>
                <td>
                  <RecordBar wins={w.wins} losses={w.losses} />
                </td>
                <td>{w.trades.length}</td>
                <td>
                  <Eth wei={w.volumeWei} />
                </td>
                <td>
                  {w.avgHold === null ? (
                    <Unavailable reason="No closed position in window" />
                  ) : (
                    `${Math.round(w.avgHold)}s`
                  )}
                </td>
                <td>
                  <Eth wei={w.bestWei} signed />
                </td>
                <td title={w.last ? utc(w.last) : undefined}>
                  {w.last ? (
                    new Date(w.last * 1000).toISOString().slice(11, 16)
                  ) : (
                    <Unavailable />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-traders">
        {listRows.map((w, i) => (
          <div key={w.row.address} className="mobile-trader">
            <div className="mobile-trader-heading">
              <span className="rank-number">#{i + 1 + rankOffset}</span>
              <Link
                className="trader-identity"
                href={walletHref(w.row.address, audit.market)}
              >
                <Avatar address={w.row.address} small />
                <span className="mono">{shortAddress(w.row.address)}</span>
              </Link>
              <ArrowUpRight size={14} />
            </div>
            <div className="mobile-trader-value">
              <Eth
                wei={metric === "realized" ? w.realizedWei : w.netWei}
                signed
              />
              <span>{metric === "realized" ? "realized" : "net flow"}</span>
            </div>
            <div className="mobile-pool-stats">
              <span>
                ROI
                <strong>
                  {w.roi === null ? <Unavailable /> : <Change value={w.roi} />}
                </strong>
              </span>
              <span>
                Swaps<strong>{w.trades.length}</strong>
              </span>
              <span>
                Volume
                <strong>
                  <Eth wei={w.volumeWei} />
                </strong>
              </span>
              <span>
                Best sale
                <strong>
                  <Eth wei={w.bestWei} signed />
                </strong>
              </span>
            </div>
            <RecordBar wins={w.wins} losses={w.losses} />
          </div>
        ))}
      </div>
      {!rows.length && (
        <div className="empty-state">
          <span className="empty-symbol">
            <Trophy size={24} />
          </span>
          <h3>No qualifying traders in this pool and window</h3>
          <p>
            The minimum stays at {minimum} swaps.{" "}
            {audit.wallets.filter((w) => w.realizedWei === null).length} senders
            have incomplete or unsupported accounting.
          </p>
        </div>
      )}
      <div className="corpus-footer">
        <span>
          Showing <strong>{rows.length}</strong> qualifying traders of{" "}
          <strong>{audit.wallets.length}</strong> audited senders
        </span>
        <span>
          {audit.market.symbol} · {window}
        </span>
      </div>
      <details className="live-details">
        <summary>
          Inspect all {audit.wallets.length} audited senders and exclusions
        </summary>
        <p className="panel-footnote">
          Unknown basis and unsupported attribution remain excluded regardless
          of toggles. Fast holds are observations, not proof of wash trading.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Sender</th>
                <th>Swaps</th>
                <th>Accounting status</th>
              </tr>
            </thead>
            <tbody>
              {audit.wallets.map((w) => (
                <tr key={w.address}>
                  <td>
                    <Link href={walletHref(w.address, audit.market)}>
                      {shortAddress(w.address)}
                    </Link>
                  </td>
                  <td>{w.swaps}</td>
                  <td>
                    {w.flags.length
                      ? w.flags.join(", ")
                      : "Complete supported position"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
function PoolTraders() {
  const { market, error, loading } = useSelectedMarket(),
    { audits } = useLive(),
    { window, setWindow } = useWindow();
  const a = market ? audits[market.id] : undefined;
  return (
    <div className="page traders-page">
      <div className="page-heading">
        <div>
          <h1>
            Trader leaderboard<span className="title-dot">.</span>
          </h1>
          <p>Follow the wallets. Understand the performance.</p>
        </div>
        <Link className="button secondary" href="/wallet/">
          Look up your wallet <ArrowUpRight size={14} />
        </Link>
      </div>
      <PersonalRankPreview />
      <section className="panel leaderboard-panel">
        <div className="live-controls">
          <PoolPicker />
          <WindowTabs value={window} onChange={setWindow} />
        </div>
        {market ? (
          <AuditAction market={market} />
        ) : (
          <p className="panel-footnote">
            {loading
              ? "Loading linked pool…"
              : error || "This pool is outside the available sample."}
          </p>
        )}
        {a ? (
          <AuditLeaderboard audit={a} window={window} />
        ) : (
          <div className="empty-state">
            <span className="empty-symbol">
              <ShieldCheck size={26} />
            </span>
            <h3>Audit before ranking</h3>
            <p>
              Receipts and token balances establish who traded and their cost
              basis. Run an audit to view supported positions in this pool.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export function Traders() {
  const { params } = useQuery();
  return params.has("pool") ? <PoolTraders /> : <ProductTraders />;
}
