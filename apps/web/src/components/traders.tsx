"use client";
import Link from "next/link";
import { useState } from "react";
import {
  walletMetrics,
  walletHref,
  shortAddress,
  type PoolAudit,
  type LiveWindow,
} from "@pools/core";
import { useLive } from "./live-provider";
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
    [fast, setFast] = useState(false);
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
  return (
    <>
      <div className="live-controls">
        <label>
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
      </div>
      <div className="live-filters">
        <label>
          <input
            type="checkbox"
            checked={noBuy}
            onChange={(e) => setNoBuy(e.target.checked)}
          />{" "}
          Exclude no-purchase histories
        </label>
        <label>
          <input
            type="checkbox"
            checked={oversold}
            onChange={(e) => setOversold(e.target.checked)}
          />{" "}
          Exclude sold more than bought
        </label>
        <label>
          <input
            type="checkbox"
            checked={fast}
            onChange={(e) => setFast(e.target.checked)}
          />{" "}
          Exclude closed holds under 60s
        </label>
        <label title="No blacklist data source is connected">
          <input type="checkbox" disabled /> Known-bad token filter: unavailable
        </label>
      </div>
      <p className="panel-footnote">
        Rank within {audit.market.symbol} only. Unknown basis and unsupported
        attribution always remain excluded, regardless of filter toggles. Net
        ETH includes spending on unsold inventory. Fast holds are observations,
        not proof of wash trading.
      </p>
      {rows.length > 0 && (
        <div className="live-podium">
          {rows.slice(0, 3).map((w, i) => (
            <Link
              href={walletHref(w.row.address, audit.market)}
              key={w.row.address}
            >
              <small>#{i + 1} · this pool</small>
              <strong>{shortAddress(w.row.address)}</strong>
              <Eth
                wei={metric === "realized" ? w.realizedWei : w.netWei}
                signed
              />
            </Link>
          ))}
        </div>
      )}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Trader</th>
              <th>{metric === "realized" ? "Realized PnL" : "Net ETH"}</th>
              <th>Realized ROI</th>
              <th>W / L</th>
              <th>Swaps</th>
              <th>Volume</th>
              <th>Avg closed hold</th>
              <th>Best sale</th>
              <th>Last (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w, i) => (
              <tr key={w.row.address}>
                <td>{i + 1}</td>
                <td>
                  <Link
                    className="mono"
                    href={walletHref(w.row.address, audit.market)}
                  >
                    {shortAddress(w.row.address)}
                  </Link>
                </td>
                <td>
                  <Eth
                    wei={metric === "realized" ? w.realizedWei : w.netWei}
                    signed
                  />
                </td>
                <td>
                  {w.roi === null ? <Unavailable /> : `${w.roi.toFixed(2)}%`}
                </td>
                <td>
                  {w.wins} / {w.losses}
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
                <td>{w.last ? utc(w.last) : <Unavailable />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <div className="empty-state">
          <h3>No qualifying traders in this pool and window</h3>
          <p>
            The minimum stays at {minimum} swaps.{" "}
            {audit.wallets.filter((w) => w.realizedWei === null).length} senders
            have incomplete or unsupported accounting.
          </p>
        </div>
      )}
      <details className="live-details">
        <summary>
          Inspect all {audit.wallets.length} audited senders and exclusions
        </summary>
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
    </>
  );
}
export function Traders() {
  const { market, error, loading } = useSelectedMarket(),
    { audits } = useLive(),
    { window, setWindow } = useWindow();
  const a = market ? audits[market.id] : undefined;
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PERFORMANCE WITH PROVENANCE</div>
          <h1>
            Trader leaderboard<span className="title-dot">.</span>
          </h1>
          <p>
            Realized swap PnL before gas. Start with a fully audited pool;
            chain-wide ranking is not established yet.
          </p>
        </div>
        <Link className="button secondary" href="/wallet/">
          Look up your wallet
        </Link>
      </div>
      <section className="panel">
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
            <h3>Audit before ranking</h3>
            <p>
              Receipts and token balances establish supported attribution and
              cost basis. No synthetic rankings are shown.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
