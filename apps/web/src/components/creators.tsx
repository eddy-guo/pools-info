"use client";
import Link from "next/link";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress, walletHref } from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
import { useLive } from "./live-provider";
import { Eth, Unavailable, utc } from "./live-ui";
import { AddressLabel } from "./ui";
export function Creators({ address }: { address?: string }) {
  const { snapshot: s, audits } = useLive();
  const senders = [
    ...new Set(s.markets.map((m) => m.launchSender.toLowerCase())),
  ].filter((a) => !address || a === address.toLowerCase());
  const catalogPools = catalog.pools.filter(
    (m) =>
      (!address || m.launchSender.toLowerCase() === address.toLowerCase()) &&
      !s.markets.some((live) => live.id === m.id),
  );
  return (
    <div className={`page ${styles.page}`}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">THE PEOPLE BEHIND THE POOLS</div>
          <h1>
            {address ? shortAddress(address) : "Creators"}
            <span className="title-dot">.</span>
          </h1>
          {address && <AddressLabel address={address} full />}
          <p>
            Launches grouped by transaction sender. This is observed launch
            activity, not independently verified creator identity.
          </p>
        </div>
      </div>
      <p className="coverage-notice">
        Trading analytics cover {s.markets.length} recent pools. The wider
        launch catalog below contains metadata only. Active means at least one
        observed swap in the 24 hours before the cutoff. New pools have had less
        time to trade.
      </p>
      {!address && <CreatorTable />}
      <div className="creator-grid" hidden={!address}>
        {senders.map((sender) => {
          const pools = s.markets.filter(
              (m) => m.launchSender.toLowerCase() === sender,
            ),
            volumes = pools
              .map((m) => BigInt(m.volumeWei))
              .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
            median =
              volumes.length % 2
                ? volumes[Math.floor(volumes.length / 2)]
                : (volumes[volumes.length / 2 - 1] +
                    volumes[volumes.length / 2]) /
                  2n,
            active = pools.filter((m) =>
              s.trades.some(
                (t) =>
                  t.poolId === m.id && t.timestamp >= s.toTimestamp - 86400,
              ),
            ).length,
            best = [...pools].sort((a, b) =>
              Number(BigInt(b.volumeWei) - BigInt(a.volumeWei)),
            )[0];
          return (
            <section className="panel creator-card" key={sender}>
              <div className="creator-card-head">
                <div>
                  <h2>
                    <Link href={`/creators/${sender}/`}>
                      {shortAddress(sender)}
                    </Link>
                  </h2>
                  <AddressLabel address={sender} />
                </div>
                <span className="badge">{pools.length} covered launches</span>
              </div>
              <dl className="live-facts">
                <div>
                  <dt>Still-trading ratio</dt>
                  <dd>
                    {((active / pools.length) * 100).toFixed(0)}% · {active}/
                    {pools.length}
                  </dd>
                </div>
                <div>
                  <dt>Observed volume</dt>
                  <dd>
                    <Eth wei={volumes.reduce((a, b) => a + b, 0n).toString()} />
                  </dd>
                </div>
                <div>
                  <dt>Median pool volume</dt>
                  <dd>
                    <Eth wei={median.toString()} />
                  </dd>
                </div>
                <div>
                  <dt>Best launch by volume</dt>
                  <dd>
                    <Link href={poolHref(best)}>{best.symbol}</Link>
                  </dd>
                </div>
              </dl>
              <div className="creator-pools">
                {pools.map((m) => {
                  const a = audits[m.id],
                    bought = a?.executions.some(
                      (e) =>
                        e.trade.trader.toLowerCase() === sender &&
                        e.trade.side === "buy" &&
                        !e.flags.length,
                    ),
                    trading = s.trades.some(
                      (t) =>
                        t.poolId === m.id &&
                        t.timestamp >= s.toTimestamp - 86400,
                    );
                  return (
                    <div className="creator-pool" key={m.id}>
                      <div>
                        <Link href={poolHref(m)}>
                          <strong>{m.name}</strong>
                          <small className="cell-sub">
                            {utc(m.launchedAt)}
                          </small>
                        </Link>
                      </div>
                      <div className="live-launch-badges">
                        <span className="badge">
                          {trading ? "Active" : "No swap observed"}
                        </span>
                        <small>
                          Creator fees {m.creatorFees ? "on" : "off"}
                        </small>
                        {bought ? (
                          <span className="badge lavender">
                            BOUGHT OWN · sender
                          </span>
                        ) : (
                          <small>
                            Own purchase{" "}
                            {a ? (
                              "not established"
                            ) : (
                              <Unavailable reason="Run a pool audit to check supported sender purchases" />
                            )}
                          </small>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <Link className="leader-link" href={walletHref(sender, pools[0])}>
                View wallet profile ↗
              </Link>
            </section>
          );
        })}
      </div>
      {!!catalogPools.length && (
        <section className="panel live-section">
          <div className="panel-heading">
            <h2>Verified launch catalog</h2>
          </div>
          <p className="panel-footnote">
            {catalogPools.length} additional launches · catalog captured{" "}
            {catalog.generatedAt.replace("T", " ").slice(0, 19)} UTC. Trading
            metrics load when you open a pool; activity and profitability are
            not assumed.
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Launch sender</th>
                  <th>Launched (UTC)</th>
                  <th>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {catalogPools.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={poolHref(m)}>
                        {m.name} ({m.symbol})
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="mono"
                        href={`/creators/${m.launchSender.toLowerCase()}/`}
                      >
                        {shortAddress(m.launchSender)}
                      </Link>
                    </td>
                    <td>{utc(m.launchedAt)}</td>
                    <td>Verified launch · analytics on demand</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {!senders.length && !catalogPools.length && (
        <section className="panel empty-state">
          <h2>No launches for this address in the recent sample</h2>
          <p>This does not establish the address’s full launch history.</p>
          <Link className="button" href="/creators/">
            Browse covered creators
          </Link>
        </section>
      )}
    </div>
  );
}

/** Public launch history only. This does not assert creator identity or allocation. */
export function WalletLaunches({ address }: { address: string }) {
  const { snapshot, audits } = useLive();
  const pools = [
    ...new Map(
      [...catalog.pools, ...snapshot.markets].map((m) => [m.id, m]),
    ).values(),
  ]
    .filter((m) => m.launchSender.toLowerCase() === address.toLowerCase())
    .sort((a, b) => b.launchBlock - a.launchBlock);
  return (
    <section className="panel live-section">
      <div className="panel-heading">
        <h2>
          Launches <span className="badge">{pools.length} covered</span>
        </h2>
      </div>
      {pools.length ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Launched (UTC)</th>
                <th>Status</th>
                <th>Observed volume</th>
                <th>Own purchase</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => {
                const market = snapshot.markets.find((m) => m.id === p.id);
                const active =
                  market &&
                  snapshot.trades.some(
                    (t) =>
                      t.poolId === p.id &&
                      t.timestamp >= snapshot.toTimestamp - 86400,
                  );
                const audit = audits[p.id];
                const bought = audit?.executions.some(
                  (e) =>
                    e.trade.trader.toLowerCase() === address.toLowerCase() &&
                    e.trade.side === "buy" &&
                    !e.flags.length,
                );
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={poolHref(p)}>
                        <strong>{p.symbol}</strong>
                        <small className="cell-sub">{p.name}</small>
                      </Link>
                    </td>
                    <td>{utc(p.launchedAt)}</td>
                    <td>
                      {market ? (
                        <span className="badge">
                          {active ? "Active" : "No swap observed"}
                        </span>
                      ) : (
                        <Unavailable reason="Activity has not been collected" />
                      )}
                    </td>
                    <td>
                      <Eth wei={market?.volumeWei} />
                    </td>
                    <td>
                      {bought ? (
                        <span className="badge lavender">BOUGHT OWN</span>
                      ) : (
                        <Unavailable reason="No supported own purchase established" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <h3>No launches in current coverage</h3>
          <p>A launch outside this catalog may not appear yet.</p>
        </div>
      )}
      <p className="panel-footnote">
        Grouped by launch transaction sender. Active means an observed swap in
        the 24 hours before the captured cutoff. This is a covered launch
        record, not a complete creator identity or allocation audit.
      </p>
    </section>
  );
}

function CreatorTable() {
  const { snapshot: s, audits } = useLive();
  const groups = [
    ...new Set(s.markets.map((m) => m.launchSender.toLowerCase())),
  ]
    .map((sender) => {
      const pools = s.markets.filter(
        (m) => m.launchSender.toLowerCase() === sender,
      );
      const volumes = pools
        .map((m) => BigInt(m.volumeWei))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const volume = volumes.reduce((sum, v) => sum + v, 0n);
      const middle = Math.floor(volumes.length / 2);
      const median =
        volumes.length % 2
          ? volumes[middle]
          : (volumes[middle - 1] + volumes[middle]) / 2n;
      const active = pools.filter((m) =>
        s.trades.some(
          (t) => t.poolId === m.id && t.timestamp >= s.toTimestamp - 86400,
        ),
      ).length;
      const best = [...pools].sort((a, b) =>
        BigInt(a.volumeWei) > BigInt(b.volumeWei)
          ? -1
          : BigInt(a.volumeWei) < BigInt(b.volumeWei)
            ? 1
            : 0,
      )[0];
      const bought = pools.some((m) =>
        audits[m.id]?.executions.some(
          (e) =>
            e.trade.trader.toLowerCase() === sender &&
            e.trade.side === "buy" &&
            !e.flags.length,
        ),
      );
      return { sender, pools, volume, median, active, best, bought };
    })
    .sort((a, b) =>
      a.volume > b.volume
        ? -1
        : a.volume < b.volume
          ? 1
          : a.sender.localeCompare(b.sender),
    );
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Creator discovery</h2>
        <span className="badge">{groups.length} covered senders</span>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Creator / launch sender</th>
              <th>Launches</th>
              <th>Still trading</th>
              <th>Volume created</th>
              <th>Median volume</th>
              <th>Best launch</th>
              <th>Creator fees</th>
              <th>Own purchase</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.sender}>
                <td>
                  <Link
                    href={`/creators/${g.sender}/`}
                    className={styles.identity}
                  >
                    <span
                      className={styles.avatar}
                      style={{
                        height: 32,
                        flexBasis: 32,
                        borderRadius: 10,
                        fontSize: 12,
                      }}
                    >
                      {g.sender.slice(2, 4).toUpperCase()}
                    </span>
                    <strong className="mono">{shortAddress(g.sender)}</strong>
                  </Link>
                </td>
                <td>{g.pools.length}</td>
                <td>
                  {g.active}/{g.pools.length}
                  <small className="cell-sub">observed in 24h</small>
                </td>
                <td>
                  <Eth wei={g.volume.toString()} />
                </td>
                <td>
                  <Eth wei={g.median.toString()} />
                </td>
                <td>
                  <Link href={poolHref(g.best)}>{g.best.symbol}</Link>
                </td>
                <td>
                  {g.pools.filter((m) => m.creatorFees).length}/{g.pools.length}{" "}
                  enabled
                </td>
                <td>
                  {g.bought ? (
                    <span className="badge lavender">BOUGHT OWN</span>
                  ) : (
                    <Unavailable reason="No supported own purchase established" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="panel-footnote">
        Sorted by observed volume across {s.markets.length} covered pools.
        Counts and activity describe this sample, not each sender’s entire
        launch history. Open a creator for their wider catalog.
      </p>
    </section>
  );
}
