"use client";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import {
  shortAddress,
  poolHref,
  since,
  type AnalyticsWalletResponse,
} from "@pools/core";
import { useProduct } from "@/lib/use-product";
import {
  useWalletTradeHistory,
  REVEAL_STEP as TRADE_HISTORY_STEP,
} from "@/lib/use-wallet-trade-history";
import {
  Eth,
  Stat,
  Unavailable,
  WindowTabs,
  useWindow,
  utc,
  explorer,
} from "./live-ui";
import {
  AddressChip,
  AddressLabel,
  Avatar,
  Change,
  Chart,
  EmptyState,
  UnavailableState,
  WinLossRecord,
} from "./ui";
import { ComingSoonRow } from "./feature-preview";
import { FollowButton } from "./following";
import { useMyWallet } from "./my-wallet";
import { PoolImage } from "./pool-image";
import { reservedRowCount, SHOW_MORE_STEP, ShowMore } from "./product-common";
import { useQuery } from "./state";
import { PnlCardModal } from "./pnl-card-modal";
import {
  RowFiller,
  TradeAmount,
  TradeSide,
  TradeTime,
  TradeTransaction,
} from "./trade-cells";
import { CopyTradePreview } from "./copy-trade-preview";
import styles from "./detail-design.module.css";
const tabs = [
  { id: "positions", label: "Positions" },
  { id: "trades", label: "Trades" },
  { id: "launches", label: "Launches" },
];
/**
 * The accounting has never observed this wallet: `asOf` is the latest cut of
 * the pools it holds a position in and is null only when it holds none, while
 * a measured wallet with no trades in the window still carries the cut. Its
 * launches come from the catalog and stay real either way.
 */
const unindexed = (data: AnalyticsWalletResponse | undefined) =>
  !!data && data.wallet.asOf === null;
/** The one line an unobserved wallet's positions, curve and most traded
    pools carry instead of zeros. */
const UNINDEXED = "This wallet's trading has not been indexed yet.";
/** The most positions the read sends (`apps/api/README.md`, the wallet
    route's bound), and so the most rows a hand-edited URL can reserve. */
const POSITIONS_CAP = 500;
/** The line under an empty curve on a measured wallet with trades: the read
    served its figures without a curve, which is not the same as no PnL. */
const CURVE_UNSERVED = "The PnL curve is not served for this wallet yet.";
/**
 * The export's tab counts, from the rows the read sent: a bounded list has
 * no total, so its tab carries no count. The slot is reserved at three
 * digits so a count arriving moves no tab beside it.
 */
function tabCount(data: AnalyticsWalletResponse | undefined, id: string) {
  if (!data) return null;
  // The explorer history's own length is never the wallet's trade count (a
  // page covers pools the ledger does not register), so this tab never
  // carries one; the real count stays on the header's Trades stat tile.
  if (id === "trades") return null;
  if (id !== "launches" && unindexed(data)) return null;
  if (id === "positions")
    return data.positionsTruncated ? null : data.positions.length;
  if (id === "launches")
    return data.launchesTruncated ? null : data.launches.length;
  return null;
}
/** A position's token quantity in whole tokens, or null where the read has none. */
function holding(p: AnalyticsWalletResponse["positions"][number]) {
  return p.position && p.decimals !== null
    ? new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(
        Number(p.position.quantity) / 10 ** p.decimals,
      )
    : null;
}
/** The existing Behaviour-panel figure, now presented with the positions it describes. */
function stillHeld(data: AnalyticsWalletResponse | undefined) {
  const known = (data?.positions ?? []).flatMap((p) =>
    p.position ? [p.position] : [],
  );
  const held = known.filter((p) => BigInt(p.quantity) > 0n).length;
  return known.length ? `${held} of ${known.length}` : null;
}
export function ProductWallet({ address }: { address: string }) {
  const { window: period, setWindow } = useWindow("All");
  const { params, set } = useQuery();
  const { data, loading, stale, error, refresh } =
    useProduct<AnalyticsWalletResponse>(
      `wallets/${address.toLowerCase()}?window=${period}`,
    );
  /* Nothing was served for this wallet. Its identity is in the URL and stays
     on screen; every figure below it is replaced by the one honest line,
     never by a placeholder that goes on shimmering. */
  const failed = !!error && !data;
  // The browser's own wallet reads as its portfolio; the server paints the
  // public framing and hydration swaps whole nodes, never text in place.
  const mine = useMyWallet().isMine(address);
  const tab = tabs.find((t) => t.id === params.get("tab"))?.id ?? "positions",
    [copyTrade, setCopyTrade] = useState(false),
    [card, setCard] = useState(false),
    // A clock frozen at mount: the header's "last Nm ago" only ever paints
    // once data resolves, so nothing already on screen depends on it ticking.
    [renderedAt] = useState(() => Math.floor(Date.now() / 1000));
  const w = data?.wallet;
  const topPools = (data?.positions ?? [])
    .slice()
    .sort((a, b) => (BigInt(b.volumeWei) > BigInt(a.volumeWei) ? 1 : -1))
    .slice(0, 5);
  const pct = (n: number | null | undefined) =>
    n == null ? <Unavailable /> : <span>{n.toFixed(1)}%</span>;
  /* The positions the URL's `limit` names, 25 by default, are reserved from
     first paint and grown by the shared Show more control: the read sends
     every position at once, so growing shows rows already on hand and the
     list never resizes under a response. */
  const rawShown = Number(params.get("limit"));
  const shown =
    Number.isInteger(rawShown) && rawShown > 0
      ? Math.min(rawShown, POSITIONS_CAP)
      : SHOW_MORE_STEP;
  const positionRows = Array.from(
    { length: shown },
    (_, index) => data?.positions[index],
  );
  const positionsTotal = data ? data.positions.length : null;
  const focusAt = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const showMore = useCallback(() => {
    focusAt.current = shown;
    set({
      limit: String(
        Math.min(shown + SHOW_MORE_STEP, positionsTotal ?? POSITIONS_CAP),
      ),
    });
  }, [shown, set, positionsTotal]);
  useEffect(() => {
    const index = focusAt.current;
    if (index === null || index >= shown) return;
    if (!data || data.positions.length <= index) return;
    focusAt.current = null;
    const links = panelRef.current?.querySelectorAll<HTMLElement>(
      `[data-row-index="${index}"] a`,
    );
    /* Both layouts hold the row; the one the container query shows has a box. */
    [...(links ?? [])].find((link) => link.getClientRects().length)?.focus();
  }, [data, shown]);
  const held = stillHeld(data);
  const tradeHistory = useWalletTradeHistory(
    address.toLowerCase(),
    tab === "trades",
  );
  /* Reserved at the fixed step while pending, exactly like the positions
     table's own `shown` reservation: a wallet with fewer trades than the
     step blank-fills the shortfall (RowFiller) rather than shrinking the
     region once the read resolves, so the skeleton-to-content transition
     moves nothing. Growing past the step is a "Load more" click, which
     Chrome never scores against CLS. */
  const tradeRowCount = reservedRowCount(
    Math.max(TRADE_HISTORY_STEP, tradeHistory.trades.length),
    tradeHistory.failed,
  );
  const tradeRows = Array.from(
    { length: tradeRowCount },
    (_, index) => tradeHistory.trades[index],
  );
  const tradesLoaded = !tradeHistory.loading && !tradeHistory.failed;
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
                {/* An unobserved wallet has no rank to be without: the badge
                    goes rather than reading UNRANKED beside a board that
                    ranks it. It sits after the heading, so nothing moves. */}
                {!unindexed(data) && (
                  <span className={styles.mode} data-pending={!data && !failed}>
                    {w?.rank
                      ? `RANK ${w.rank}`
                      : data
                        ? "UNRANKED"
                        : failed
                          ? "RANK UNAVAILABLE"
                          : "RANK PENDING"}
                  </span>
                )}
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
          <button
            type="button"
            className="button"
            aria-haspopup="dialog"
            onClick={() => setCopyTrade(true)}
          >
            Copy trade
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </div>
      {loading && data && (
        <span className="sr-only" role="status">
          Updating saved wallet activity
        </span>
      )}
      {error && !failed && (
        <p role="alert" className="coverage-notice">
          {error}
        </p>
      )}
      {failed && <UnavailableState subject="Wallet" onRetry={refresh} />}
      {!failed && (
        <>
          <div className="stats-grid live-eight-stats wallet-stats">
            <Stat pending={loading && !data} label="Realized PnL">
              <Eth pending={!data} wei={w?.realizedWei} signed digits={5} />
            </Stat>
            <Stat pending={loading && !data} label="ROI">
              {w?.roi == null ? (
                <Unavailable />
              ) : (
                <Change value={w.roi} digits={1} />
              )}
            </Stat>
            <Stat
              pending={loading && !data}
              label="Win rate"
              note={
                data && !unindexed(data) ? (
                  <WinLossRecord wins={w?.wins ?? 0} losses={w?.losses ?? 0} />
                ) : undefined
              }
            >
              {pct(w?.winRate)}
            </Stat>
            <Stat pending={loading && !data} label="Trades">
              {unindexed(data) ? (
                <Unavailable />
              ) : (
                ((
                  w?.rankingTradeCount ?? w?.supportedTradeCount
                )?.toLocaleString("en-US") ?? <Unavailable />)
              )}
            </Stat>
            <Stat pending={loading && !data} label="Volume">
              <Eth
                pending={!data}
                wei={unindexed(data) ? null : w?.volumeWei}
                digits={5}
              />
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
                    emptyNote={
                      unindexed(data)
                        ? UNINDEXED
                        : w && w.tradeCount > 0
                          ? CURVE_UNSERVED
                          : undefined
                    }
                  />
                </div>
              </section>
              <section
                className="panel live-section wallet-activity"
                ref={panelRef}
              >
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
                        <span className="tab-count">
                          {/* Keyed so a count replaces its node rather than
                            rewriting text in place. */}
                          {count !== null && (
                            <Fragment key={count}>{count}</Fragment>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {tab === "positions" && (
                  <>
                    <div className="wallet-positions-context">
                      <span>Still held</span>
                      <strong data-pending={!data}>
                        {!data ? (
                          "Pending"
                        ) : held === null ? null : (
                          <Fragment key={held}>{held}</Fragment>
                        )}
                      </strong>
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
                            {positionRows.map((p, index) => (
                              <tr
                                key={index}
                                aria-hidden={!p}
                                data-row={p ? "resolved" : "reserved"}
                                data-row-index={index}
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
                                  ) : (
                                    <RowFiller blank={!!data} />
                                  )}
                                </td>
                                <td data-pending={!p && !data}>
                                  {p ? (
                                    <>
                                      {holding(p) === null ? (
                                        <Unavailable />
                                      ) : (
                                        `${holding(p)} ${p.symbol}`
                                      )}
                                    </>
                                  ) : (
                                    <RowFiller blank={!!data} />
                                  )}
                                </td>
                                <td data-pending={!p && !data}>
                                  {p || !data ? (
                                    <Eth
                                      pending={!data}
                                      wei={p?.position?.costWei}
                                    />
                                  ) : (
                                    <RowFiller blank />
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
                                    <RowFiller blank />
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
                                    <RowFiller blank />
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {/* The rows where the table does not fit: the token with
                        its realized and unrealized PnL at the right, then the
                        holding and its cost. */}
                      <div
                        className="mobile-wallet-rows"
                        aria-busy={stale}
                        data-stale-rows={stale}
                      >
                        {positionRows.map((p, index) => (
                          <div
                            className="mobile-position"
                            key={index}
                            aria-hidden={!p}
                            data-row={p ? "resolved" : "reserved"}
                            data-row-index={index}
                          >
                            {p ? (
                              <Fragment key="resolved">
                                <div className="mobile-wallet-row-top">
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
                                  <span className="mobile-position-pnl">
                                    <Eth wei={p.realizedWei} signed />
                                    <span>
                                      Unrealized{" "}
                                      <Eth wei={p.unrealizedWei} signed />
                                    </span>
                                  </span>
                                </div>
                                <div className="mobile-wallet-row-stats">
                                  Holding {holding(p) ?? <Unavailable />} · Cost{" "}
                                  <Eth wei={p.position?.costWei} />
                                </div>
                              </Fragment>
                            ) : data ? null : (
                              <Fragment key="pending">
                                <div className="mobile-wallet-row-top">
                                  <span data-pending="true">Token pending</span>
                                  <span className="mobile-position-pnl">
                                    <Eth wei={undefined} pending />
                                  </span>
                                </div>
                                <div
                                  className="mobile-wallet-row-stats"
                                  data-pending="true"
                                >
                                  Pending
                                </div>
                              </Fragment>
                            )}
                          </div>
                        ))}
                      </div>
                      {data && !data.positions.length && (
                        /* The hint offers the All window only while another
                           is selected: with All on show there is nothing
                           left to select. An unobserved wallet has no
                           window to select either, so it carries its one
                           line in every window. */
                        <EmptyState
                          title={
                            period === "All" || unindexed(data)
                              ? "No positions"
                              : "No positions in this window"
                          }
                          description={
                            unindexed(data)
                              ? UNINDEXED
                              : period === "All"
                                ? "This wallet has no positions."
                                : "Select All to see this wallet's full history."
                          }
                        />
                      )}
                    </div>
                    <ShowMore
                      shown={shown}
                      total={positionsTotal}
                      cap={POSITIONS_CAP}
                      loading={!data}
                      onMore={showMore}
                    />
                    {data?.positionsTruncated && (
                      <p className="panel-footnote">
                        Showing the first {data.positions.length} positions.
                      </p>
                    )}
                  </>
                )}
                {tab === "trades" && (
                  <>
                    <div className="wallet-positions-context">
                      <span>Updated</span>
                      <strong data-pending={!tradeHistory.fetchedAt}>
                        {tradeHistory.fetchedAt == null ? (
                          "Pending"
                        ) : (
                          <Fragment key={tradeHistory.fetchedAt}>
                            <time
                              dateTime={new Date(
                                tradeHistory.fetchedAt * 1000,
                              ).toISOString()}
                              title={utc(tradeHistory.fetchedAt)}
                            >
                              {since(tradeHistory.fetchedAt, renderedAt)}
                            </time>{" "}
                            ago
                          </Fragment>
                        )}
                      </strong>
                    </div>
                    <div
                      className="table-region"
                      data-empty={
                        tradesLoaded &&
                        !tradeHistory.trades.length &&
                        !tradeHistory.hasMore
                      }
                    >
                      <div
                        className="table-scroll wallet-list-region"
                        data-failed={tradeHistory.failed}
                        aria-busy={tradeHistory.loading}
                        data-stale-rows={false}
                      >
                        <table className="data-table wallet-trades-table">
                          <colgroup>
                            <col />
                            <col style={{ width: "150px" }} />
                            <col style={{ width: "150px" }} />
                            <col style={{ width: "90px" }} />
                            <col style={{ width: "170px" }} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>Token</th>
                              <th>Amount</th>
                              <th>Time (UTC)</th>
                              <th>Side</th>
                              <th>Transaction</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tradeRows.map((t, index) => (
                              <tr
                                key={index}
                                aria-hidden={!t}
                                data-row={t ? "resolved" : "reserved"}
                                data-row-index={index}
                              >
                                <td data-pending={!t && tradeHistory.loading}>
                                  {t ? (
                                    <AddressChip
                                      address={t.token.address}
                                      href={`${explorer}/address/${t.token.address}`}
                                      external
                                    />
                                  ) : (
                                    <RowFiller blank={tradesLoaded} />
                                  )}
                                </td>
                                <td data-pending={!t && tradeHistory.loading}>
                                  {t ? (
                                    <span className="number">
                                      <TradeAmount
                                        raw={t.tokenRaw}
                                        decimals={t.token.decimals}
                                        symbol={t.token.symbol}
                                      />
                                    </span>
                                  ) : (
                                    <RowFiller blank={tradesLoaded} />
                                  )}
                                </td>
                                <td data-pending={!t && tradeHistory.loading}>
                                  {t ? (
                                    <TradeTime timestamp={t.timestamp} />
                                  ) : (
                                    <RowFiller blank={tradesLoaded} />
                                  )}
                                </td>
                                <td data-pending={!t && tradeHistory.loading}>
                                  {t ? (
                                    <TradeSide side={t.side} />
                                  ) : (
                                    <RowFiller blank={tradesLoaded} />
                                  )}
                                </td>
                                <td data-pending={!t && tradeHistory.loading}>
                                  {t ? (
                                    <TradeTransaction
                                      hash={t.transactionHash}
                                    />
                                  ) : (
                                    <RowFiller blank={tradesLoaded} />
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div
                        className="mobile-wallet-rows"
                        aria-busy={tradeHistory.loading}
                        data-stale-rows={false}
                      >
                        {tradeRows.map((t, index) => (
                          <div
                            className="mobile-wallet-row"
                            key={index}
                            aria-hidden={!t}
                            data-row={t ? "resolved" : "reserved"}
                            data-row-index={index}
                          >
                            {t ? (
                              <Fragment key="resolved">
                                <div className="mobile-wallet-row-top">
                                  <AddressChip
                                    address={t.token.address}
                                    href={`${explorer}/address/${t.token.address}`}
                                    external
                                  />
                                  <TradeSide side={t.side} />
                                </div>
                                <div className="mobile-wallet-row-stats">
                                  <TradeAmount
                                    raw={t.tokenRaw}
                                    decimals={t.token.decimals}
                                    symbol={t.token.symbol}
                                  />{" "}
                                  · <TradeTime timestamp={t.timestamp} /> ·{" "}
                                  <TradeTransaction hash={t.transactionHash} />
                                </div>
                              </Fragment>
                            ) : (
                              <Fragment key="pending">
                                <div className="mobile-wallet-row-top">
                                  <span data-pending="true">
                                    {tradesLoaded ? " " : "Trade pending"}
                                  </span>
                                </div>
                                <div
                                  className="mobile-wallet-row-stats"
                                  data-pending="true"
                                >
                                  {tradesLoaded ? " " : "Pending"}
                                </div>
                              </Fragment>
                            )}
                          </div>
                        ))}
                      </div>
                      {tradesLoaded &&
                        !tradeHistory.trades.length &&
                        !tradeHistory.hasMore && (
                          <EmptyState
                            title="No trade history"
                            description="This wallet has no explorer trade history yet."
                          />
                        )}
                    </div>
                    {tradeHistory.failed && (
                      <UnavailableState
                        subject="Trade history"
                        onRetry={
                          tradeHistory.canRetry ? tradeHistory.retry : undefined
                        }
                      />
                    )}
                    {/* The wrapper always renders once the tab is reachable,
                        reserving the button's row from first paint the same
                        way ShowMore does elsewhere: this list never learns a
                        total, so whether more exists is only known after the
                        first page resolves, and the button must not pop the
                        row in once it is. */}
                    {!tradeHistory.failed && (
                      <div className="pagination">
                        <span className="pagination-count">
                          {tradeHistory.moreFailed
                            ? "Some trades could not be loaded."
                            : " "}
                        </span>
                        {(tradeHistory.loading || tradeHistory.hasMore) && (
                          <button
                            type="button"
                            className="button secondary"
                            disabled={
                              tradeHistory.loading || tradeHistory.loadingMore
                            }
                            onClick={tradeHistory.loadMore}
                          >
                            {tradeHistory.moreFailed
                              ? "Try again"
                              : `Load ${TRADE_HISTORY_STEP} more`}
                          </button>
                        )}
                      </div>
                    )}
                    {!tradeHistory.failed && (
                      <p className="panel-footnote">
                        Explorer history for display only; not accounting or PnL
                        evidence.
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
                      <table className="data-table wallet-launches-table">
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
                    <div
                      className="mobile-wallet-rows"
                      aria-busy={stale}
                      data-stale-rows={stale}
                    >
                      {data?.launches.map((p) => (
                        <div className="mobile-wallet-row" key={p.id}>
                          <div className="mobile-wallet-row-top">
                            <Link href={poolHref(p)}>
                              {p.name} ({p.symbol})
                            </Link>
                            <a
                              href={`${explorer}/tx/${p.launchTx}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Launch transaction ↗
                            </a>
                          </div>
                          <div className="mobile-wallet-row-stats">
                            {utc(p.launchedAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                    {data?.launchesTruncated && (
                      <p className="panel-footnote">
                        Showing the latest {data.launches.length} launches.
                      </p>
                    )}
                  </>
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
                      {unindexed(data)
                        ? UNINDEXED
                        : "No pool activity in this window."}
                    </p>
                  )}
                </div>
              </section>
              <ComingSoonRow items={["Copy trading", "Profile editing"]} />
            </aside>
          </div>
        </>
      )}
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
