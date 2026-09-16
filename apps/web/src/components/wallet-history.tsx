"use client";
import { useEffect, useState } from "react";
import {
  shortAddress,
  type WalletHistoryTokenTransfer,
  type WalletHistoryTransaction,
} from "@pools/core";
import {
  useWalletHistory,
  type WalletHistoryFailure,
} from "@/lib/use-wallet-history";
import { Unavailable, utc } from "./live-ui";
import { AddressLabel, Price } from "./ui";
import styles from "./wallet-history.module.css";

/** Blockscout serves a fixed page; the reserved rows match it exactly. */
const page = 50;
const unavailableCopy: Record<WalletHistoryFailure["reason"], string> = {
  not_configured: "Explorer history is not connected here.",
  budget_exhausted: "Explorer history is unavailable right now.",
  upstream_unavailable: "The explorer did not answer.",
  key_rejected: "Explorer history is unavailable right now.",
};
// `.number` belongs on the value, not the cell: as a cell class the shared
// table rule would turn the cell itself into an inline block.
const when = (timestamp: number | null) =>
  timestamp === null ? (
    <Unavailable reason="Not yet mined" />
  ) : (
    <span className="number">{utc(timestamp).replace(" UTC", "")}</span>
  );

function RetryButton({
  failure,
  retry,
}: {
  failure: WalletHistoryFailure;
  retry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (failure.retryAt <= now) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(1000, failure.retryAt - now),
    );
    return () => clearTimeout(timer);
  }, [failure, now]);
  const left = Math.ceil((failure.retryAt - now) / 1000);
  return (
    <button className="button secondary" disabled={left > 0} onClick={retry}>
      {left <= 0
        ? "Try again"
        : `Try again in ${left < 60 ? `${left}s` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}`}
    </button>
  );
}

type History = Omit<
  ReturnType<typeof useWalletHistory<"transactions">>,
  "items"
>;
function Panel<T>({
  title,
  kind,
  active,
  columns,
  layout,
  history,
  items,
  row,
  card,
}: {
  title: string;
  kind: string;
  active: boolean;
  columns: string[];
  layout: string;
  history: History;
  items: T[];
  row: (item: T) => React.ReactNode;
  card: (item: T) => React.ReactNode;
}) {
  const { failure } = history;
  // The page in flight owns its rows before it arrives, so the ones already on
  // screen never move as it resolves.
  const reserved = history.loading ? page : 0;
  return (
    <div hidden={!active}>
      <div className="panel-heading">
        <h2>{title}</h2>
        <span className={styles.attribution}>via Blockscout</span>
      </div>
      {failure && !items.length ? (
        <div className={styles.region} data-history={kind} role="status">
          <div className={styles.unavailable}>
            <p>{unavailableCopy[failure.reason]}</p>
            {failure.reason !== "not_configured" && (
              <RetryButton failure={failure} retry={history.retry} />
            )}
          </div>
        </div>
      ) : (
        <div
          className={styles.region}
          data-history={kind}
          aria-busy={history.loading}
        >
          <table
            className={`data-table ${styles.table} ${layout}`}
            aria-label={title}
          >
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(row)}
              {Array.from({ length: reserved }, (_, index) => (
                <tr key={`reserved-${index}`} aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column}>
                      <span data-pending="true">Pending</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {/* A phone reads the same page as cards rather than a seven-column scroll. */}
          <div className={styles.cards}>
            {items.map(card)}
            {Array.from({ length: reserved }, (_, index) => (
              <article
                className={styles.card}
                key={`reserved-${index}`}
                aria-hidden="true"
              >
                {[0, 1, 2].map((line) => (
                  <span key={line} data-pending="true">
                    Pending
                  </span>
                ))}
              </article>
            ))}
          </div>
          {!history.loading && !items.length && (
            <div className={styles.empty}>No explorer activity.</div>
          )}
        </div>
      )}
      <div className={styles.footer}>
        <span>
          {items.length ? `${items.length.toLocaleString("en-US")} shown` : " "}
        </span>
        {failure ? (
          // A failure with rows on screen keeps its retry here; one without
          // owns the whole panel above and leaves the bar to hold its height.
          items.length ? (
            <span className={styles.footerFailure}>
              <span>{unavailableCopy[failure.reason]}</span>
              {failure.reason !== "not_configured" && (
                <RetryButton failure={failure} retry={history.retry} />
              )}
            </span>
          ) : null
        ) : (
          <button
            className="button secondary"
            disabled={!history.nextCursor || history.loading}
            onClick={history.loadMore}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

function Amount({ item }: { item: WalletHistoryTokenTransfer }) {
  const { value, tokenId, token } = item;
  return (
    <span
      className="number"
      title={value === null ? undefined : `${value} raw`}
    >
      {value !== null &&
        (token.decimals === null ? (
          <>
            {value} <small>units</small>
          </>
        ) : (
          new Intl.NumberFormat("en-US", {
            maximumSignificantDigits: 6,
          }).format(Number(value) / 10 ** token.decimals)
        ))}
      {value !== null && tokenId !== null && " "}
      {tokenId !== null && <span className={styles.tokenId}>#{tokenId}</span>}
    </span>
  );
}

function StatusPill({
  status,
}: {
  status: WalletHistoryTransaction["status"];
}) {
  if (status === "ok") return null;
  return (
    <span
      className={`${styles.pill} ${status === "error" ? styles.failed : styles.waiting}`}
    >
      {status === "error" ? "Failed" : "Pending"}
    </span>
  );
}
function Method({ method }: { method: string | null }) {
  return method ? (
    <span className="mono">{method}</span>
  ) : (
    <Unavailable reason="No decoded method" />
  );
}
function Fee({ fee }: { fee: string | null }) {
  return fee === null ? (
    <Unavailable reason="Not yet mined" />
  ) : (
    <Price wei={fee} />
  );
}
function To({ to }: { to: string | null }) {
  return to ? (
    <AddressLabel address={to} />
  ) : (
    <Unavailable reason="Contract creation" />
  );
}
function Flow({ from, to }: { from: string; to: React.ReactNode }) {
  return (
    <div className={styles.cardFlow}>
      <AddressLabel address={from} />
      <span aria-hidden="true">→</span>
      {to}
    </div>
  );
}
function transactionRow(item: WalletHistoryTransaction) {
  return (
    <tr key={item.hash}>
      <td>
        <span className={styles.subject}>
          <AddressLabel address={item.hash} kind="tx" />
          <StatusPill status={item.status} />
        </span>
      </td>
      <td className={styles.method}>
        <Method method={item.method} />
      </td>
      <td>
        <AddressLabel address={item.from} />
      </td>
      <td>
        <To to={item.to} />
      </td>
      <td className={styles.numeric}>
        <Price wei={item.value} />
      </td>
      <td className={styles.numeric}>
        <Fee fee={item.fee} />
      </td>
      <td className={styles.time}>{when(item.timestamp)}</td>
    </tr>
  );
}

function transferRow(item: WalletHistoryTokenTransfer) {
  return (
    <tr key={`${item.transactionHash}:${item.logIndex}`}>
      <td>
        <AddressLabel address={item.transactionHash} kind="tx" />
      </td>
      <td className={styles.token} title={item.token.name ?? undefined}>
        {item.token.symbol ? (
          <strong>{item.token.symbol}</strong>
        ) : (
          <span className="mono">{shortAddress(item.token.address)}</span>
        )}
      </td>
      <td className={styles.numeric}>
        <Amount item={item} />
      </td>
      <td>
        <AddressLabel address={item.from} />
      </td>
      <td>
        <AddressLabel address={item.to} />
      </td>
      <td className={styles.time}>{when(item.timestamp)}</td>
    </tr>
  );
}

function transactionCard(item: WalletHistoryTransaction) {
  return (
    <article className={styles.card} key={item.hash}>
      <div className={styles.cardTop}>
        <AddressLabel address={item.hash} kind="tx" />
        <span className={styles.cardMeta}>
          <StatusPill status={item.status} />
          <Method method={item.method} />
        </span>
      </div>
      <Flow from={item.from} to={<To to={item.to} />} />
      <div className={styles.cardStats}>
        <span>
          <small>Value</small>
          <Price wei={item.value} />
        </span>
        <span>
          <small>Fee</small>
          <Fee fee={item.fee} />
        </span>
        <span className={styles.time}>{when(item.timestamp)}</span>
      </div>
    </article>
  );
}
function transferCard(item: WalletHistoryTokenTransfer) {
  return (
    <article
      className={styles.card}
      key={`${item.transactionHash}:${item.logIndex}`}
    >
      <div className={styles.cardTop}>
        <span className={styles.token} title={item.token.name ?? undefined}>
          {item.token.symbol ? (
            <strong>{item.token.symbol}</strong>
          ) : (
            <span className="mono">{shortAddress(item.token.address)}</span>
          )}
        </span>
        <Amount item={item} />
      </div>
      <Flow from={item.from} to={<AddressLabel address={item.to} />} />
      <div className={styles.cardStats}>
        <AddressLabel address={item.transactionHash} kind="tx" />
        <span className={styles.time}>{when(item.timestamp)}</span>
      </div>
    </article>
  );
}
/** A wallet's own explorer activity, paged on demand and never joined to PnL. */
export function WalletTransactions({
  wallet,
  active,
}: {
  wallet: string;
  active: boolean;
}) {
  const history = useWalletHistory(wallet, "transactions", active);
  return (
    <Panel
      title="Transactions"
      kind="transactions"
      active={active}
      layout={styles.transactions}
      columns={[
        "Transaction",
        "Method",
        "From",
        "To",
        "Value",
        "Fee",
        "Time (UTC)",
      ]}
      history={history}
      items={history.items}
      row={transactionRow}
      card={transactionCard}
    />
  );
}
export function WalletTokenTransfers({
  wallet,
  active,
}: {
  wallet: string;
  active: boolean;
}) {
  const history = useWalletHistory(wallet, "token-transfers", active);
  return (
    <Panel
      title="Token transfers"
      kind="token-transfers"
      active={active}
      layout={styles.transfers}
      columns={["Transaction", "Token", "Amount", "From", "To", "Time (UTC)"]}
      history={history}
      items={history.items}
      row={transferRow}
      card={transferCard}
    />
  );
}
