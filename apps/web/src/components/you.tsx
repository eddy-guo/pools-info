"use client";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ArrowRight, Star, UserRoundPlus, X } from "lucide-react";
import {
  shortAddress,
  since,
  walletHref,
  type AnalyticsPoolRow,
  type LiveWindow,
} from "@pools/core";
import { useExploreRows } from "@/lib/use-explore-rows";
import { useFollowedLeaderboard } from "@/lib/use-followed-leaderboard";
import { useHydrated } from "@/lib/use-hydrated";
import { useReportCut } from "@/lib/freshness";
import { useProfileStore, type ProfileStore } from "@/lib/profile-store";
import {
  MAX_SHARED_POOLS,
  MAX_WATCHLIST_QUERY_POOLS,
  watchlistShareUrl,
} from "@/lib/watchlist";
import { FOLLOWING_CAP, YOU_PAGE_STEP } from "@/lib/saved";
import { useMyWallet } from "./my-wallet";
import { SetWalletDialog } from "./wallet-profile";
import { MyRankFacts, tradeCountLabel } from "./product-traders";
import { confirmFollow } from "./saved-toast";
import {
  AddressChip,
  Avatar,
  Change,
  EmptyState,
  Price,
  UnavailableState,
  WatchButton,
} from "./ui";
import { Eth, utc } from "./live-ui";
import {
  FollowActivity,
  FollowStatus,
  pendingFeed,
  useFollowActivity,
} from "./follow-activity";
import {
  launchOnly,
  PoolCell,
  reservedRowCount,
  ShowMore,
  useClockSeconds,
} from "./product-common";
import { LaunchLine, PoolChange, RowSubtitle } from "./pool-row";
import { youCopy as copy } from "./you-copy";

/*
 * The You page: what this browser has saved for itself, on one page, read
 * through the one profile facade (`useProfileStore`). There is no account
 * behind it today: the follow list, the watchlist and the marked wallet are
 * the same browser-local stores every follow button and star write, and the
 * page is the single place they show up. The layout is the contract a
 * signed-in profile keeps: the heading, the identity row (the export's YOU
 * row, with the one control that marks or forgets a wallet), the watchlist
 * with live figures, then the followed wallets with their 7d summary and the
 * Following activity feed; a later mode swaps the stores under the facade
 * and the sections stay.
 *
 * Every section paints at its final height from first paint. The served
 * page cannot see this browser's lists, so `youPrepaintScript` (lib/saved.ts)
 * reads them before paint and the stylesheet shows, per section, either the
 * empty state or the rows' reserved height (`.you-prepaint` in globals.css)
 * until hydration replaces that shell with the real list on the same
 * geometry: the rows have fixed heights, the feed is the same component in
 * its own pending state, and every foot holds its row from the start. A
 * count, a control or a row that arrives is a new node in a slot that was
 * already there, never text rewritten in place.
 */

/** The watchlist is read by identity, in launch order over the whole
    history: a window metric's order drops a starred pool with no volume in
    that window, and a saved list must never lose a row that way. */
const WATCH_WINDOW: LiveWindow = "All";
const WATCH_QUERY = { window: WATCH_WINDOW, sort: "launch", direction: "desc" };
/** The screener's Watchlist view under the same order. */
const SCREENER_WATCHLIST = `/?view=watchlist&window=${WATCH_WINDOW}&sort=launch`;
/** The identity row's summary window, the leaderboard's own default. */
const RANK_WINDOW: LiveWindow = "7d";

export function YouPage() {
  const hydrated = useHydrated();
  const store = useProfileStore();
  return (
    <div className="page you-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{copy.eyebrow}</div>
          <h1>
            {copy.title}
            <span className="title-dot">.</span>
          </h1>
          <p>{copy.lede}</p>
        </div>
      </div>
      <IdentityRow hydrated={hydrated} address={store.address} />
      <WatchlistSection hydrated={hydrated} ids={store.watch} />
      <FollowingSection hydrated={hydrated} store={store} />
    </div>
  );
}

/**
 * The export's YOU row (`.my-rank`, one height in every state): the marked
 * wallet's identity and 7d summary with its portfolio link and the way to
 * forget it, or the empty tile with the one control that marks a wallet.
 * Either fills after hydration inside the same box.
 */
function IdentityRow({
  hydrated,
  address,
}: {
  hydrated: boolean;
  address: string;
}) {
  const { set } = useMyWallet();
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      {hydrated && address ? (
        <div className="my-rank you-identity" key="set">
          <MyRankFacts
            address={address}
            window={RANK_WINDOW}
            cutSource="you-identity"
          />
          <span className="you-identity-actions">
            <Link
              className="my-rank-link"
              href={`${walletHref(address)}?window=${RANK_WINDOW}`}
              aria-label={copy.identity.portfolio}
            >
              <span>{copy.identity.portfolio}</span> →
            </Link>
            <button
              type="button"
              className="text-button you-forget"
              aria-label={copy.identity.forget}
              onClick={() => set("")}
            >
              <span className="you-forget-long">{copy.identity.forget}</span>
              <span className="you-forget-short" aria-hidden="true">
                {copy.identity.forgetShort}
              </span>
            </button>
          </span>
        </div>
      ) : (
        <div className="my-rank you-identity" key="unset">
          <span className="my-rank-identity">
            <span className="my-rank-empty" aria-hidden="true" />
            <span className="my-rank-chip">{copy.identity.chip}</span>
          </span>
          <span className="my-rank-summary">{copy.identity.prompt}</span>
          <span className="you-identity-actions">
            {hydrated && (
              <button
                type="button"
                className="button secondary"
                aria-haspopup="dialog"
                onClick={() => setDialogOpen(true)}
              >
                {copy.identity.set}
              </button>
            )}
          </span>
        </div>
      )}
      {dialogOpen && (
        <SetWalletDialog
          onClose={() => setDialogOpen(false)}
          onSet={(next) => {
            set(next);
            setDialogOpen(false);
          }}
        />
      )}
    </>
  );
}

function SectionHead({
  id,
  title,
  count,
  link,
}: {
  id: string;
  title: string;
  /** Shown once known; keyed so a change mounts a new node. */
  count: number | null;
  link: { href: string; label: string };
}) {
  return (
    <div className="you-section-head">
      <h2 id={id}>
        {title}
        {count !== null && count > 0 && (
          <span className="you-section-count" key={count}>
            {" "}
            ({count.toLocaleString("en-US")})
          </span>
        )}
      </h2>
      <Link className="section-link" href={link.href}>
        {link.label}
        <ArrowRight aria-hidden="true" />
      </Link>
    </div>
  );
}

/** A Show more foot with nothing to say yet: the row the real control takes
    once a list is on hand, so it never appears under one. */
function PendingFoot() {
  return (
    <div className="pagination" aria-hidden="true">
      <span className="pagination-count">{" "}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- watchlist */

function WatchlistEmpty() {
  return (
    <EmptyState
      symbol={<Star size={25} />}
      title={copy.watchlist.empty.title}
      description={copy.watchlist.empty.description}
      action={
        <Link className="button secondary" href="/">
          {copy.watchlist.empty.action}
          <ArrowRight aria-hidden="true" />
        </Link>
      }
    />
  );
}

function WatchlistSection({
  hydrated,
  ids,
}: {
  hydrated: boolean;
  ids: string[];
}) {
  const [shown, setShown] = useState(YOU_PAGE_STEP);
  return (
    <section
      className="you-section"
      id="watchlist"
      aria-labelledby="you-watchlist-heading"
    >
      <SectionHead
        id="you-watchlist-heading"
        title={copy.watchlist.heading}
        count={hydrated ? ids.length : null}
        link={{ href: SCREENER_WATCHLIST, label: copy.watchlist.open }}
      />
      {hydrated ? (
        ids.length ? (
          <WatchedPools
            ids={ids}
            shown={shown}
            onMore={() =>
              setShown((n) =>
                Math.min(n + YOU_PAGE_STEP, MAX_WATCHLIST_QUERY_POOLS),
              )
            }
          />
        ) : (
          <div className="panel you-panel">
            <WatchlistEmpty />
          </div>
        )
      ) : (
        <div className="you-prepaint" data-section="watchlist">
          <div className="panel you-panel">
            <WatchlistEmpty />
          </div>
          <div className="you-prepaint-rows">
            <div className="panel you-panel">
              <div className="table-region">
                <div className="table-scroll desktop-pools" aria-hidden="true">
                  <table className="data-table pool-table you-pool-table">
                    <WatchColumns />
                    <WatchHead />
                    <tbody />
                  </table>
                </div>
                <div className="mobile-pools" aria-hidden="true" />
              </div>
              <PendingFoot />
              <div className="you-panel-foot" aria-hidden="true" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function WatchColumns() {
  return (
    <colgroup>
      <col className="col-watch" />
      <col className="col-token" />
      <col className="col-price" />
      <col className="col-change" />
      <col className="col-volume" />
    </colgroup>
  );
}
function WatchHead() {
  return (
    <thead>
      <tr>
        <th>
          <span className="sr-only">Watchlist</span>
        </th>
        <th>Token</th>
        <th>Price</th>
        <th>{WATCH_WINDOW}</th>
        <th>Volume</th>
      </tr>
    </thead>
  );
}

function WatchedPools({
  ids,
  shown,
  onMore,
}: {
  ids: string[];
  shown: number;
  onMore: () => void;
}) {
  const now = useClockSeconds();
  /* The ids that drove the last read, frozen against a bare unstar as the
     screener's Watchlist view freezes its own: the row leaves through the
     client-side filter below and nothing is read again. A pool starred in
     another tab, which the read has never seen, reads through as a normal
     new query. Corrected during render, as `useDebouncedInput` corrects its
     own state, so nothing downstream sees a stale value. */
  const [fetched, setFetched] = useState<string[]>([]);
  let queryIds = fetched;
  if (ids.some((id) => !fetched.includes(id))) {
    queryIds = ids;
    setFetched(ids);
  }
  const query = new URLSearchParams({
    ...WATCH_QUERY,
    view: "watchlist",
    q: "",
    ids: queryIds.slice(0, MAX_WATCHLIST_QUERY_POOLS).join(","),
  }).toString();
  const target = Math.min(shown, queryIds.length, MAX_WATCHLIST_QUERY_POOLS);
  const { list, loading, settled, error, refresh, asOf } = useExploreRows(
    query,
    target,
  );
  useReportCut("you-watchlist", null, asOf);
  const removed = queryIds.filter((id) => !ids.includes(id));
  const rows = list
    ? removed.length
      ? list.rows.filter((row) => !removed.includes(row.id))
      : list.rows
    : undefined;
  const total = list ? Math.max(0, list.total - removed.length) : null;
  const failed = !!error && !list;
  const empty = settled && total === 0;
  /* Reserved from the list this browser holds, never from the response, so
     a read that lands only fills rows; a failed first read collapses them
     for the retry control instead of holding blank rows above it. */
  const reserved = reservedRowCount(
    Math.min(shown, ids.length, MAX_WATCHLIST_QUERY_POOLS),
    failed,
  );
  const shownRows = Array.from({ length: reserved }, (_, i) => rows?.[i]);
  const skeletonAt = (index: number) =>
    !failed && (!list || (loading && index < list.total));
  const rowsVar = { "--you-watchlist-rows": reserved } as CSSProperties;
  const panelRef = useRef<HTMLDivElement>(null);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAt.current;
    if (index === null || !rows || rows.length <= index) return;
    focusAt.current = null;
    const links = panelRef.current?.querySelectorAll<HTMLElement>(
      `[data-row-index="${index}"] a.token-cell`,
    );
    /* Both layouts hold the row; the one the container query shows has a box. */
    [...(links ?? [])].find((link) => link.getClientRects().length)?.focus();
  }, [rows]);
  return (
    <div className="panel you-panel" ref={panelRef}>
      {loading && (
        <span className="sr-only" role="status">
          Updating saved pools
        </span>
      )}
      {error && !failed && (
        <p className="panel-footnote" role="alert">
          {error}
        </p>
      )}
      {ids.length > MAX_WATCHLIST_QUERY_POOLS && (
        <p className="panel-footnote">
          {copy.watchlist.capped(MAX_WATCHLIST_QUERY_POOLS, ids.length)}
        </p>
      )}
      <div className="table-region" data-empty={empty}>
        <div
          className="table-scroll desktop-pools"
          aria-busy={loading}
          style={rowsVar}
        >
          <table className="data-table pool-table you-pool-table">
            <WatchColumns />
            <WatchHead />
            <tbody>
              {shownRows.map((p, index) => {
                const skeleton = !p && skeletonAt(index);
                return (
                  <tr
                    key={index}
                    data-row-index={index}
                    aria-hidden={!p}
                    data-row={
                      p ? "resolved" : skeleton ? "skeleton" : "reserved"
                    }
                  >
                    <td data-pending={skeleton}>
                      {p ? (
                        <WatchButton id={p.id} />
                      ) : skeleton ? (
                        "Pending"
                      ) : (
                        " "
                      )}
                    </td>
                    <td data-pending={skeleton}>
                      {p ? (
                        <PoolCell
                          pool={p}
                          subtitle={
                            <RowSubtitle
                              key={`${WATCH_WINDOW}:${p.stats.trades}`}
                              pool={p}
                              now={now}
                            />
                          }
                        />
                      ) : skeleton ? (
                        "Pending"
                      ) : (
                        " "
                      )}
                    </td>
                    {p && launchOnly(p) ? (
                      <td className="launch-cell" colSpan={3}>
                        <LaunchLine pool={p} now={now} />
                      </td>
                    ) : (
                      <>
                        <td data-pending={skeleton}>
                          {p || skeleton ? (
                            <Price wei={p?.stats.priceWei} pending={skeleton} />
                          ) : (
                            " "
                          )}
                        </td>
                        <td data-pending={skeleton}>
                          {p || skeleton ? (
                            p ? (
                              <PoolChange
                                key={`${WATCH_WINDOW}:${p.stats.change}`}
                                pool={p}
                                window={WATCH_WINDOW}
                                now={now}
                              />
                            ) : (
                              <Change pending />
                            )
                          ) : (
                            " "
                          )}
                        </td>
                        <td data-pending={skeleton}>
                          {p || skeleton ? (
                            <Eth pending={skeleton} wei={p?.stats.volumeWei} />
                          ) : (
                            " "
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mobile-pools" aria-busy={loading} style={rowsVar}>
          {shownRows.map((p, index) => (
            <WatchedPoolCard
              key={index}
              index={index}
              pool={p}
              skeleton={!p && skeletonAt(index)}
              now={now}
            />
          ))}
        </div>
        {empty && (
          <EmptyState
            title={copy.watchlist.unserved.title}
            description={copy.watchlist.unserved.description}
          />
        )}
      </div>
      {failed && (
        <UnavailableState subject={copy.watchlist.subject} onRetry={refresh} />
      )}
      <ShowMore
        shown={reserved}
        total={failed ? 0 : total}
        cap={MAX_WATCHLIST_QUERY_POOLS}
        loading={loading}
        onMore={() => {
          focusAt.current = reserved;
          onMore();
        }}
      />
      <WatchlistShare ids={ids} />
    </div>
  );
}

/** The screener's Copy watchlist link, for the list this page shows: the
    same share URL (`watchlistShareUrl`), the same clipboard fallback. */
function WatchlistShare({ ids }: { ids: string[] }) {
  const [feedback, setFeedback] = useState<{
    key: string;
    message: string;
    link: string;
  } | null>(null);
  const key = ids.join(",");
  const current = feedback?.key === key ? feedback : null;
  const tooMany = ids.length > MAX_SHARED_POOLS;
  return (
    <div className="you-panel-foot">
      <button
        type="button"
        className="button secondary"
        disabled={!ids.length || tooMany}
        title={
          tooMany
            ? `Share links support up to ${MAX_SHARED_POOLS} pools.`
            : undefined
        }
        onClick={async () => {
          let link = "";
          try {
            link = watchlistShareUrl(window.location.href, ids);
            await navigator.clipboard.writeText(link);
            setFeedback({ key, message: copy.watchlist.copied, link: "" });
          } catch (error) {
            setFeedback({
              key,
              message: link
                ? copy.watchlist.clipboard
                : error instanceof Error
                  ? error.message
                  : "Unable to create this link.",
              link,
            });
          }
        }}
      >
        {copy.watchlist.copy}
      </button>
      <span className="you-panel-foot-status" role="status" aria-live="polite">
        {current?.message ?? ""}
      </span>
      {current?.link && (
        <input
          className="you-panel-foot-link"
          aria-label={copy.watchlist.linkLabel}
          readOnly
          value={current.link}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </div>
  );
}

/** The screener's phone card, row for row (`.mobile-pool` in globals.css). */
function WatchedPoolCard({
  index,
  pool: p,
  skeleton,
  now,
}: {
  index: number;
  pool: AnalyticsPoolRow | undefined;
  skeleton: boolean;
  now: number | null;
}) {
  return (
    <article
      className="mobile-pool"
      data-row-index={index}
      data-row={p ? "resolved" : skeleton ? "skeleton" : "reserved"}
    >
      {p ? (
        <>
          <div className="mobile-pool-top">
            <PoolCell
              pool={p}
              subtitle={
                <RowSubtitle
                  key={WATCH_WINDOW}
                  pool={p}
                  now={now}
                  trades={false}
                />
              }
            />
            {!launchOnly(p) && (
              <div className="mobile-pool-price">
                <Price wei={p.stats.priceWei} />
                <PoolChange
                  key={`${WATCH_WINDOW}:${p.stats.change}`}
                  pool={p}
                  window={WATCH_WINDOW}
                  now={now}
                />
              </div>
            )}
            <WatchButton id={p.id} />
          </div>
          {launchOnly(p) ? (
            <div className="mobile-pool-stats" data-launch-row="true">
              <span>
                Launched{" "}
                <time
                  data-pending={now === null}
                  dateTime={new Date(p.launchedAt * 1000).toISOString()}
                  title={utc(p.launchedAt)}
                >
                  {now === null ? "Pending" : `${since(p.launchedAt, now)} ago`}
                </time>
              </span>
              <AddressChip
                address={p.launchSender}
                href={`/wallet/${p.launchSender.toLowerCase()}/`}
              />
            </div>
          ) : (
            <div className="mobile-pool-stats">
              <span
                key={`${WATCH_WINDOW}:${p.stats.volumeWei}:${p.stats.trades}`}
              >
                Vol <Eth wei={p.stats.volumeWei} />
                {p.stats.trades !== null && (
                  <>
                    {" · "}
                    {p.stats.trades.toLocaleString("en-US")}{" "}
                    {p.stats.trades === 1 ? "trade" : "trades"}
                  </>
                )}
              </span>
            </div>
          )}
        </>
      ) : skeleton ? (
        <>
          <div className="mobile-pool-top">
            <span className="token-cell">
              <span className="chain-token" data-pending="true">
                Token
              </span>
              <span>
                <strong data-pending="true">Pool pending</strong>
                <small data-pending="true">{" "}</small>
              </span>
            </span>
            <div className="mobile-pool-price">
              <Price pending />
              <Change pending />
            </div>
            <button
              className="icon-button watch"
              disabled
              aria-hidden="true"
              tabIndex={-1}
            >
              <Star size={16} />
            </button>
          </div>
          <div className="mobile-pool-stats">
            <span data-pending="true">{" "}</span>
          </div>
        </>
      ) : null}
    </article>
  );
}

/* ---------------------------------------------------------------- following */

function FollowingEmpty() {
  return (
    <EmptyState
      symbol={<UserRoundPlus size={25} />}
      title={copy.following.empty.title}
      description={copy.following.empty.description}
      action={
        <Link className="button secondary" href="/traders/">
          {copy.following.empty.action}
          <ArrowRight aria-hidden="true" />
        </Link>
      }
    />
  );
}

function FollowingSection({
  hydrated,
  store,
}: {
  hydrated: boolean;
  store: ProfileStore;
}) {
  const { follow: addresses, toggleFollow, followError: error } = store;
  const [shown, setShown] = useState(YOU_PAGE_STEP);
  const count = addresses.length;
  return (
    <section
      className="you-section"
      id="following"
      aria-labelledby="you-following-heading"
    >
      <SectionHead
        id="you-following-heading"
        title={copy.following.heading}
        count={hydrated ? count : null}
        link={{
          href: "/traders/?view=following",
          label: copy.following.compare,
        }}
      />
      {error && (
        <p role="alert" className="panel-footnote">
          {error}
        </p>
      )}
      {hydrated ? (
        count ? (
          <FollowedWallets
            addresses={addresses}
            toggleFollow={toggleFollow}
            shown={shown}
            onMore={() =>
              setShown((n) => Math.min(n + YOU_PAGE_STEP, FOLLOWING_CAP))
            }
          />
        ) : (
          <div className="panel you-panel">
            <FollowingEmpty />
          </div>
        )
      ) : (
        <div className="you-prepaint" data-section="following">
          <div className="panel you-panel">
            <FollowingEmpty />
          </div>
          <div className="you-prepaint-rows">
            <div className="panel you-panel">
              <div className="you-followed-rows" aria-hidden="true" />
              <PendingFoot />
            </div>
            <FollowActivity feed={pendingFeed} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Mounted only while something is followed, so unfollowing the last wallet
    unmounts the feed and cancels its reads. */
function FollowedWallets({
  addresses,
  toggleFollow,
  shown,
  onMore,
}: {
  addresses: string[];
  toggleFollow: ProfileStore["toggleFollow"];
  shown: number;
  onMore: () => void;
}) {
  const feed = useFollowActivity(addresses);
  /* The rows on show, one identity each: the summary reads only these, one
     wallet read apiece, and the whole list's feed reads once below. */
  const rows = useMemo(() => addresses.slice(0, shown), [addresses, shown]);
  const board = useFollowedLeaderboard(rows, RANK_WINDOW, true);
  useReportCut("you-following", null, board.asOf);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAt.current;
    if (index === null || rows.length <= index) return;
    focusAt.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-row-index="${index}"] .you-followed-identity`,
      )
      ?.focus();
  }, [rows.length]);
  return (
    <>
      <div className="panel you-panel">
        <ul
          ref={listRef}
          className="you-followed-rows"
          aria-label="Followed wallets"
          style={{ "--you-following-rows": rows.length } as CSSProperties}
        >
          {rows.map((address, index) => (
            <li
              key={address}
              className="you-followed-row"
              data-row-index={index}
            >
              <Link
                className="you-followed-identity"
                href={`/wallet/${address}/`}
              >
                <Avatar address={address} small />
                <span className="you-followed-lines">
                  <span className="you-followed-name">
                    <strong>{shortAddress(address)}</strong>
                    <FollowStatus status={feed.status(address)} />
                  </span>
                  <small className="mono">{address}</small>
                </span>
              </Link>
              <FollowedSummary address={address} board={board} />
              <button
                type="button"
                className="icon-button"
                aria-label={copy.following.unfollow(address)}
                onClick={() =>
                  confirmFollow(toggleFollow(address), address, () =>
                    toggleFollow(address),
                  )
                }
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
        <ShowMore
          shown={rows.length}
          total={addresses.length}
          cap={FOLLOWING_CAP}
          loading={board.loading}
          onMore={() => {
            focusAt.current = rows.length;
            onMore();
          }}
        />
      </div>
      <FollowActivity feed={feed} />
    </>
  );
}

/** One wallet's 7d summary from the same read the leaderboard's Following
    tab makes, as separate keyed nodes: Pending until the board settles,
    the figures once it has, "unavailable" where its read failed. */
function FollowedSummary({
  address,
  board,
}: {
  address: string;
  board: ReturnType<typeof useFollowedLeaderboard>;
}) {
  const w = board.items.find((item) => item.address.toLowerCase() === address);
  return (
    <span className="you-followed-summary">
      {board.loading ? (
        <span key="pending" data-pending="true">
          {copy.following.summaryPending}
        </span>
      ) : w ? (
        (w.rankingTradeCount ?? w.supportedTradeCount) > 0 ? (
          <span key="summary">
            realized <Eth wei={w.realizedWei} signed /> · {tradeCountLabel(w)}
          </span>
        ) : (
          <span key="quiet">{copy.following.summaryQuiet(RANK_WINDOW)}</span>
        )
      ) : (
        <span key="unavailable">{copy.following.summaryUnavailable}</span>
      )}
    </span>
  );
}
