"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  AnalyticsPoolRow,
  AnalyticsCoverage,
  AnalyticsExploreResponse,
} from "@pools/core";
import type { Delivered, ProductDelivery } from "@/lib/use-product";
import { ProductCoverage } from "./product-common";
import styles from "./detail-design.module.css";
import { poolHref, shortAddress } from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
import { useLive } from "./live-provider";
import { Eth, Unavailable, utc } from "./live-ui";
import { AddressLabel } from "./ui";
export function Creators({ address }: { address?: string }) {
  const [state, setState] = useState<{
    items: AnalyticsPoolRow[];
    coverage?: AnalyticsCoverage;
    delivery?: ProductDelivery;
    loading: boolean;
    error?: string;
  }>({ items: [], loading: true });
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const items: AnalyticsPoolRow[] = [];
      let offset = 0;
      try {
        for (;;) {
          const response = await fetch(
            `/api/product/explore?window=24h&sort=launch&limit=100&offset=${offset}${address ? `&q=${encodeURIComponent(address)}` : ""}`,
            {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(12000),
              ]),
            },
          );
          if (!response.ok)
            throw Error(
              "The saved creator catalog is temporarily unavailable.",
            );
          const page =
            (await response.json()) as Delivered<AnalyticsExploreResponse>;
          items.push(...page.items);
          if (controller.signal.aborted) return;
          setState({
            items: [...items],
            coverage: page.coverage,
            delivery: page.delivery,
            loading: page.nextOffset !== null,
          });
          if (page.nextOffset === null) break;
          if (page.nextOffset <= offset || page.nextOffset > 10000)
            throw Error(
              "Showing the first 10,000 catalog pools; remaining creator totals are unavailable.",
            );
          offset = page.nextOffset;
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setState((prior) => ({
            ...prior,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Saved catalog unavailable",
          }));
      }
    })();
    return () => controller.abort();
  }, [address]);
  const groups = [
    ...new Set(state.items.map((p) => p.launchSender.toLowerCase())),
  ]
    .filter((sender) => !address || sender === address.toLowerCase())
    .map((sender) => {
      const pools = state.items.filter(
          (p) => p.launchSender.toLowerCase() === sender,
        ),
        measured = pools.filter((p) => p.stats.volumeWei !== null);
      const volumes = measured
          .map((p) => BigInt(p.stats.volumeWei!))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        mid = Math.floor(volumes.length / 2);
      const volume = volumes.length
        ? volumes.reduce((a, b) => a + b, 0n)
        : null;
      const median = volumes.length
        ? volumes.length % 2
          ? volumes[mid]
          : (volumes[mid - 1] + volumes[mid]) / 2n
        : null;
      const best = [...measured].sort((a, b) =>
        BigInt(a.stats.volumeWei!) > BigInt(b.stats.volumeWei!) ? -1 : 1,
      )[0];
      const active = pools.filter((p) => (p.stats.trades ?? 0) > 0).length;
      const complete = pools.every(
        (p) => p.processed && p.stats.completeWindow,
      );
      return {
        sender,
        pools,
        volume,
        median,
        best,
        active,
        complete,
        measured: measured.length,
      };
    })
    .sort((a, b) =>
      a.volume === b.volume
        ? a.sender.localeCompare(b.sender)
        : a.volume === null
          ? 1
          : b.volume === null
            ? -1
            : a.volume > b.volume
              ? -1
              : 1,
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
            Launches grouped by transaction sender, not independently verified
            creator identity.
          </p>
        </div>
      </div>
      {state.coverage && (
        <ProductCoverage coverage={state.coverage} delivery={state.delivery} />
      )}
      {state.loading && (
        <p role="status" className="panel-footnote">
          Loading the saved creator catalog · {state.items.length} pools loaded.
          Totals are partial until all catalog pages arrive.
        </p>
      )}
      {state.error && (
        <p role="alert" className="coverage-notice">
          {state.error}
        </p>
      )}
      {!address && (
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
                  <th>Observed 24h volume</th>
                  <th>Median measured volume</th>
                  <th>Best measured launch</th>
                  <th>Analytics</th>
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
                        <strong className="mono">
                          {shortAddress(g.sender)}
                        </strong>
                      </Link>
                    </td>
                    <td>{g.pools.length}</td>
                    <td>
                      {g.complete ? (
                        `${g.active}/${g.pools.length}`
                      ) : (
                        <Unavailable
                          reason={`${g.active} pools have observed swaps; full 24h coverage is incomplete`}
                        />
                      )}
                    </td>
                    <td>
                      <Eth wei={g.volume?.toString()} />
                    </td>
                    <td>
                      <Eth wei={g.median?.toString()} />
                    </td>
                    <td>
                      {g.best ? (
                        <Link href={poolHref(g.best)}>{g.best.symbol}</Link>
                      ) : (
                        <Unavailable />
                      )}
                    </td>
                    <td>
                      {g.measured}/{g.pools.length} measured
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-footnote">
            Sorted by measured 24h volume across the saved catalog. Unprocessed
            launches remain included; unknown activity is never treated as zero.
          </p>
        </section>
      )}
      {address &&
        groups.map((g) => (
          <section className="panel live-section" key={g.sender}>
            <div className="panel-heading">
              <h2>Launches · {g.pools.length} covered</h2>
              <Link href={`/wallet/${g.sender}/?window=All`}>
                View wallet profile ↗
              </Link>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Launch (UTC)</th>
                    <th>24h activity</th>
                    <th>24h volume</th>
                    <th>Creator fees</th>
                  </tr>
                </thead>
                <tbody>
                  {g.pools.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={poolHref(p)}>
                          {p.name} ({p.symbol})
                        </Link>
                      </td>
                      <td>{utc(p.launchedAt)}</td>
                      <td>
                        {(p.stats.trades ?? 0) > 0
                          ? "Active"
                          : p.processed
                            ? "No swap observed"
                            : "Processing"}
                      </td>
                      <td>
                        <Eth wei={p.stats.volumeWei} />
                      </td>
                      <td>
                        {p.market ? (
                          p.market.creatorFees ? (
                            "On"
                          ) : (
                            "Off"
                          )
                        ) : (
                          <Unavailable />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="panel-footnote">
              Activity refers to saved pool cutoffs. An unobserved trade does
              not establish inactivity outside coverage.
            </p>
          </section>
        ))}
      {!groups.length && !state.loading && (
        <section className="panel empty-state">
          <h2>No launches in current coverage</h2>
          <p>This does not establish the address’s full launch history.</p>
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
