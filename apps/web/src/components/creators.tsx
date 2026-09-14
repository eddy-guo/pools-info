"use client";
import Link from "next/link";
import { poolHref, shortAddress, walletHref } from "@pools/core";
import { useLive } from "./live-provider";
import { Eth, Unavailable, utc } from "./live-ui";
import { AddressLabel } from "./ui";
export function Creators({ address }: { address?: string }) {
  const { snapshot: s, audits } = useLive();
  const senders = [
    ...new Set(s.markets.map((m) => m.launchSender.toLowerCase())),
  ].filter((a) => !address || a === address.toLowerCase());
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            FOLLOW THE BUILDERS / ON-CHAIN LAUNCH CONTEXT
          </div>
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
        Only {s.markets.length} recent pools are covered. Active means at least
        one observed swap in the 24 hours before the cutoff. New pools have had
        less time to trade.
      </p>
      <div className="creator-grid">
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
                          {trading ? "Active" : "Dormant"}
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
      {!senders.length && (
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
