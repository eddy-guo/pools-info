"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  identityTint,
  shortAddress,
  type AnalyticsLeaderboardResponse,
  type AnalyticsWalletResponse,
  type AnalyticsWalletSummary,
  type LiveWindow,
} from "@pools/core";
import { DATA_UNAVAILABLE, fetchProduct, useProduct } from "@/lib/use-product";
import { useFollowedLeaderboard } from "@/lib/use-followed-leaderboard";
import { useQuery } from "./state";
import { useFollowing, FollowRowButton } from "./following";
import { Eth, Unavailable, WindowTabs, useWindow, utc } from "./live-ui";
import { AddressChip, Avatar, Change, UnavailableState } from "./ui";
import { SHOW_MORE_STEP, ShowMore } from "./product-common";
import { useMyWallet } from "./my-wallet";

/** The podium always holds ranks 1-3; the flat list starts past them when the
    podium shows, and shows every rank (including 1-3, coloured) when it does
    not - a window with fewer than three wallets, or the Following tab. */
const PODIUM_SIZE = 3;
/** Pump.fun-style gold/silver/bronze for a flat list's own ranks 1-3, keyed
    by the wallet's actual rank rather than row position so the Following
    tab's out-of-order rows never pick up a colour that isn't theirs. */
const RANK_TIER_CLASS: Record<number, string> = {
  1: "rank-gold",
  2: "rank-silver",
  3: "rank-bronze",
};
function rankTierClass(rank: number | null | undefined) {
  return (rank && RANK_TIER_CLASS[rank]) || undefined;
}
/** `3m`, `2h`, `4d`: relative to a `now` frozen once at mount so an
    unrelated re-render (a Show more click) never rewrites an already-painted
    row's text out from under it. */
function relativeAge(seconds: number, now: number) {
  const delta = Math.max(0, now - seconds);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}
function WinLossBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  return (
    <span className="wl-bar" aria-hidden="true">
      <i style={{ width: `${total ? (wins / total) * 100 : 0}%` }} />
      <b style={{ width: `${total ? (losses / total) * 100 : 0}%` }} />
    </span>
  );
}
function WinLossRecord({ wins, losses }: { wins: number; losses: number }) {
  return (
    <span className="wl-record">
      <WinLossBar wins={wins} losses={losses} />
      <span className="wl-text">
        {wins}W · {losses}L
      </span>
    </span>
  );
}

/** The leaderboard never requests past its top 100, whatever the API allows. */
const CAP = 100;
/** Followed wallets are already capped by the local follow store itself. */
const FOLLOWED_CAP = 200;

type Metric = "realized" | "net";

type LeaderboardState = {
  key: string;
  items: AnalyticsWalletSummary[];
  total: number;
  loadedShown: number;
  loading: boolean;
  settled: boolean;
  error?: string;
};

/**
 * Grows a leaderboard window/metric pair page by page: a metric or window
 * change (a new `key`) replaces the list from scratch, while a growing
 * `shown` target on the same key fetches only the rows not already held and
 * appends them, so an already-loaded row is never requested twice.
 */
function useLeaderboard(
  key: string,
  window: string,
  metric: string,
  shown: number,
) {
  const [state, setState] = useState<LeaderboardState>({
    key: "",
    items: [],
    total: 0,
    loadedShown: 0,
    loading: true,
    settled: false,
  });
  useEffect(() => {
    const isReset = state.key !== key;
    if (!isReset && shown <= state.loadedShown) return;
    const baseItems = isReset ? [] : state.items;
    const baseLoaded = isReset ? 0 : state.loadedShown;
    const fetchLimit = shown - baseLoaded;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const query = new URLSearchParams({
      window,
      metric,
      offset: String(baseLoaded),
      limit: String(fetchLimit),
    });
    void (async () => {
      try {
        const data = await fetchProduct<AnalyticsLeaderboardResponse>(
          `leaderboard?${query}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setState({
          key,
          items: [...baseItems, ...data.items],
          total: data.total,
          loadedShown: baseLoaded + data.items.length,
          loading: false,
          settled: true,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          key,
          loading: false,
          error: error instanceof Error ? error.message : DATA_UNAVAILABLE,
        }));
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, window, metric, shown]);
  return state;
}

/** Shared row markup for the ranked list and the Following tab: `pending`
    means the slot is reserved but not yet resolved, `w` undefined with
    `pending` false means the slot is known to hold nothing. */
/** The trades the board ranked a wallet on, with thousands separators as the
    pool page prints its trade count (30,160, never 30160). */
const tradeCount = (w: AnalyticsWalletSummary) =>
  (w.rankingTradeCount ?? w.supportedTradeCount).toLocaleString("en-US");
function DesktopTraderRow({
  w,
  index,
  pending,
  metric,
  window,
  now,
}: {
  w: AnalyticsWalletSummary | undefined;
  index: number;
  pending: boolean;
  metric: Metric;
  window: LiveWindow;
  now: number;
}) {
  return (
    <tr
      data-row-index={index}
      aria-hidden={!w}
      data-row={w ? "resolved" : "reserved"}
    >
      <td data-pending={pending} className={rankTierClass(w?.rank)}>
        {w ? <>#{w.rank}</> : pending ? "Pending" : " "}
      </td>
      <td data-pending={pending}>
        {w ? (
          <AddressChip
            address={w.address}
            href={`/wallet/${w.address}/?window=${window}`}
            avatarSize="monogram"
          />
        ) : pending ? (
          "Pending"
        ) : (
          " "
        )}
      </td>
      <td data-pending={pending}>
        <Eth
          pending={pending}
          wei={metric === "realized" ? w?.realizedWei : w?.netWei}
          signed
        />
      </td>
      <td data-pending={pending}>
        {w ? (
          <>
            {w.roi === null ? (
              <Unavailable />
            ) : (
              <Change value={w.roi} abbreviate />
            )}
          </>
        ) : pending ? (
          "Pending"
        ) : (
          " "
        )}
      </td>
      <td data-pending={pending}>
        {w ? (
          <WinLossRecord wins={w.wins} losses={w.losses} />
        ) : pending ? (
          "Pending"
        ) : (
          " "
        )}
      </td>
      <td data-pending={pending}>
        {w ? <>{tradeCount(w)}</> : pending ? "Pending" : " "}
      </td>
      <td data-pending={pending}>
        <Eth pending={pending} wei={w?.volumeWei} />
      </td>
      <td data-pending={pending}>
        {w ? (
          <>{w.realizedPositionCount ?? w.supportedPositionCount}</>
        ) : pending ? (
          "Pending"
        ) : (
          " "
        )}
      </td>
      <td data-pending={pending}>
        <Eth pending={pending} wei={w?.bestWei} signed />
      </td>
      <td data-pending={pending}>
        {w ? (
          w.last ? (
            <span title={utc(w.last)}>{relativeAge(w.last, now)}</span>
          ) : (
            <Unavailable />
          )
        ) : pending ? (
          "Pending"
        ) : (
          " "
        )}
      </td>
      <td data-pending={pending}>
        {w ? (
          <FollowRowButton address={w.address} />
        ) : pending ? (
          "Pending"
        ) : (
          " "
        )}
      </td>
    </tr>
  );
}

/** The 97px phone row: rank, identity and address controls on one line with
    PnL over ROI at the right, then the win/loss bar with volume and hold on
    a second line. The follow toggle sits in the second line's free right edge
    so it never competes with the monogram, address or PnL for width. */
function MobileTraderCard({
  w,
  index,
  pending,
  metric,
  window,
}: {
  w: AnalyticsWalletSummary | undefined;
  index: number;
  pending: boolean;
  metric: Metric;
  window: LiveWindow;
}) {
  return (
    <div
      className="mobile-trader"
      data-row-index={index}
      data-row={w ? "resolved" : "reserved"}
    >
      {w ? (
        <>
          <div className="mobile-trader-heading">
            <div className="mobile-trader-identity">
              <span className={`rank-number ${rankTierClass(w.rank) ?? ""}`}>
                #{w.rank}
              </span>
              <AddressChip
                address={w.address}
                href={`/wallet/${w.address}/?window=${window}`}
                avatarSize="monogram"
              />
            </div>
            <div className="mobile-trader-actions">
              <div className="mobile-trader-pnl">
                <Eth
                  wei={metric === "realized" ? w.realizedWei : w.netWei}
                  signed
                />
                {w.roi === null ? (
                  <Unavailable />
                ) : (
                  <Change value={w.roi} abbreviate />
                )}
              </div>
              <FollowRowButton address={w.address} />
            </div>
          </div>
          <div className="mobile-trader-foot">
            <WinLossBar wins={w.wins} losses={w.losses} />
            <span className="wl-text">
              {w.wins}W · {w.losses}L
            </span>
            <span className="mobile-trader-foot-stat">
              Vol <Eth wei={w.volumeWei} />
            </span>
            <span className="mobile-trader-foot-stat">
              Hold{" "}
              {w.avgHold == null ? (
                <Unavailable />
              ) : (
                `${Math.round(w.avgHold)}s`
              )}
            </span>
          </div>
        </>
      ) : pending ? (
        <>
          <div className="mobile-trader-heading">
            <div className="mobile-trader-identity">
              <span className="rank-number" data-pending="true">
                Rank
              </span>
              <span className="trader-identity" data-pending="true">
                Wallet pending
              </span>
            </div>
            <div className="mobile-trader-pnl">
              <span className="number" data-pending="true">
                Pending
              </span>
            </div>
          </div>
          <div className="mobile-trader-foot">
            <span data-pending="true">Pending</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The export's podium card: a rank medallion in the trader's own identity
 * hue, the address chip, the headline PnL, a neutral realized/ROI line, the
 * win/loss bar and the record. Not a link itself - AddressChip already
 * carries the wallet's navigation, copy and explorer actions, and nesting
 * another interactive wrapper around those would be invalid HTML.
 */
function PodiumCard({
  w,
  rank,
  pending,
  metric,
  window,
}: {
  w: AnalyticsWalletSummary | undefined;
  rank: number;
  pending: boolean;
  metric: Metric;
  window: LiveWindow;
}) {
  const tint = w ? identityTint(w.address) : undefined;
  return (
    <div className="trader-podium-card" data-row-index={rank - 1}>
      {w && <FollowRowButton address={w.address} />}
      <div className="trader-podium-card-head">
        <span
          className="trader-podium-card-rank"
          style={
            tint
              ? ({
                  "--podium-rank-bg": tint.background,
                  "--podium-rank-fg": tint.foreground,
                } as React.CSSProperties)
              : undefined
          }
        >
          {rank}
        </span>
        {w ? (
          <AddressChip
            address={w.address}
            href={`/wallet/${w.address}/?window=${window}`}
            avatarSize="monogram"
          />
        ) : (
          <span className="trader-podium-card-identity" data-pending={pending}>
            {pending ? "Pending" : " "}
          </span>
        )}
      </div>
      <div className="trader-podium-card-pnl">
        <Eth
          pending={pending}
          wei={
            w ? (metric === "realized" ? w.realizedWei : w.netWei) : undefined
          }
          signed
        />
      </div>
      <div className="trader-podium-card-meta">
        {w ? (
          <>
            realized · ROI{" "}
            {w.roi === null ? (
              <Unavailable />
            ) : (
              <Change value={w.roi} abbreviate />
            )}
          </>
        ) : (
          <span data-pending={pending}>{pending ? "Pending" : " "}</span>
        )}
      </div>
      <WinLossBar wins={w?.wins ?? 0} losses={w?.losses ?? 0} />
      <div className="trader-podium-card-record">
        {w ? (
          <>
            <span>
              {w.wins}W · {w.losses}L
            </span>
            <span>{tradeCount(w)} trades</span>
          </>
        ) : (
          <span data-pending={pending}>{pending ? "Pending" : " "}</span>
        )}
      </div>
    </div>
  );
}
/**
 * The export's "YOU · RANK N" row above the podium, for the wallet this
 * browser marked as its own. Its rank is the wallet read's, never derived
 * here; without a wallet the row is the quiet prompt at the same height.
 */
function MyRank({ window }: { window: LiveWindow }) {
  const { address } = useMyWallet();
  return address ? (
    <MyRankRow address={address} window={window} />
  ) : (
    <Link className="my-rank" href="/wallet/">
      <span className="my-rank-identity">
        <span className="my-rank-empty" aria-hidden="true" />
        <span className="my-rank-chip">YOU</span>
      </span>
      <span className="my-rank-summary">
        Mark your wallet on its page to see your rank here
      </span>
      <span className="my-rank-link">
        <span>Find your wallet</span> →
      </span>
    </Link>
  );
}
function MyRankRow({
  address,
  window,
}: {
  address: string;
  window: LiveWindow;
}) {
  const { data, error } = useProduct<AnalyticsWalletResponse>(
    `wallets/${address}?window=${window}`,
  );
  const w = data?.wallet;
  return (
    <Link className="my-rank" href={`/wallet/${address}/?window=${window}`}>
      <span className="my-rank-identity">
        <Avatar address={address} small />
        <span className="mono my-rank-address">{shortAddress(address)}</span>
        <span className="my-rank-chip">
          {w?.rank ? `YOU · RANK ${w.rank}` : "YOU"}
        </span>
      </span>
      {/* Each state is its own node, so a resolved value never rewrites the
          pending text in place. */}
      {!w && error ? (
        <span className="my-rank-summary" key="unavailable">
          unavailable
        </span>
      ) : !w ? (
        <span className="my-rank-summary" data-pending="true" key="pending">
          Pending
        </span>
      ) : w.rank ? (
        <span className="my-rank-summary" key="ranked">
          realized <Eth wei={w.realizedWei} signed /> across{" "}
          <span className="number">{tradeCount(w)}</span> trades
        </span>
      ) : (
        <span className="my-rank-summary" key="unranked">
          not ranked in this window
        </span>
      )}
      <span className="my-rank-link">
        <span>Your wallet</span> →
      </span>
    </Link>
  );
}
export function ProductTraders() {
  const { params, set } = useQuery(),
    { window, setWindow } = useWindow("7d");
  const metric = (params.get("metric") ?? "realized") as Metric;
  const view = params.get("view") === "following" ? "following" : "leaderboard";
  const rawShown = Number(params.get("limit"));
  const shown =
    Number.isInteger(rawShown) && rawShown > 0 && rawShown <= CAP
      ? rawShown
      : 25;
  const key = `${window}:${metric}`;
  const state = useLeaderboard(key, window, metric, shown);
  const forKey = state.key === key;
  const settled = forKey && state.settled;
  const items = forKey ? state.items.slice(0, shown) : [];
  /* The board is a top-100 board, so its display total is the API's count
     capped there, as the creators list reads its own: the count line and the
     Show more button then agree on where the list ends. */
  const total = settled ? Math.min(state.total, CAP) : null;
  const knownAbsent = (index: number) => settled && index >= state.total;
  /* No ranking was served, so none is drawn: the podium and the rows would
     otherwise shimmer indefinitely, reading as a board still on its way. */
  const failed = forKey && !!state.error && items.length === 0;
  // Optimistic until settled, so the podium band never pops in after first
  // paint; a settled total under 3 wallets is the one case it disappears.
  const showPodium = !failed && (total === null || total >= PODIUM_SIZE);
  const listOffset = showPodium ? PODIUM_SIZE : 0;
  const listCount = failed ? 0 : Math.max(0, shown - listOffset);
  // Frozen at mount so a later re-render (a Show more click) never rewrites
  // an already-painted "Last" cell's relative age out from under it.
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const { addresses: followed } = useFollowing();
  const following = useFollowedLeaderboard(
    followed,
    window,
    view === "following",
  );
  const followedTotal = followed.length;
  const rawFollowedShown = Number(params.get("flimit"));
  const followedShown =
    Number.isInteger(rawFollowedShown) &&
    rawFollowedShown > 0 &&
    rawFollowedShown <= FOLLOWED_CAP
      ? rawFollowedShown
      : SHOW_MORE_STEP;
  const followedReserved = Math.min(followedShown, followedTotal);
  const followedPending = !following.settled;
  const followingFailed = !!following.error && following.items.length === 0;

  const focusFromRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const handleMore = useCallback(() => {
    focusFromRef.current = shown;
    const ceiling = total === null ? CAP : Math.min(CAP, total);
    set({ limit: String(Math.min(shown + SHOW_MORE_STEP, ceiling)) });
  }, [shown, set, total]);
  const handleFollowedMore = useCallback(() => {
    set({
      flimit: String(Math.min(followedShown + SHOW_MORE_STEP, followedTotal)),
    });
  }, [followedShown, followedTotal, set]);
  useEffect(() => {
    const index = focusFromRef.current;
    if (index === null || state.loading) return;
    if (state.items.length <= index) return;
    focusFromRef.current = null;
    const container = panelRef.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>(
      `[data-row-index="${index}"]`,
    );
    for (const row of rows) {
      if (row.offsetParent === null) continue;
      const target =
        row.querySelector<HTMLElement>(".address-chip-link") ?? row;
      target.focus();
      break;
    }
  }, [state.items.length, state.loading]);

  return (
    <div className="page traders-page ranked-traders">
      <div className="page-heading">
        <h1>
          Trader leaderboard<span className="title-dot">.</span>
        </h1>
        <div className="traders-controls">
          <div className="segmented" aria-label="Trader view">
            {(
              [
                ["leaderboard", "Leaderboard"],
                ["following", "Following"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={view === key}
                onClick={() =>
                  set({ view: key === "leaderboard" ? null : key })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="segmented" aria-label="Ranking metric">
            {[
              ["realized", "Realized PnL"],
              ["net", "Net ETH"],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={metric === key}
                onClick={() => set({ metric: key, limit: null })}
              >
                {label}
              </button>
            ))}
          </div>
          <WindowTabs
            value={window}
            onChange={(value) => {
              setWindow(value);
              set({ limit: null });
            }}
          />
        </div>
      </div>
      <MyRank window={window} />
      <section className="panel leaderboard-panel" ref={panelRef}>
        {view === "leaderboard" ? (
          <>
            {state.loading && items.length > 0 && (
              <span className="sr-only" role="status">
                Updating saved rankings
              </span>
            )}
            {/* Rows already on show keep their place and this line reports
                what did not arrive; a first read that failed has no rows and
                speaks through the unavailable state below instead. */}
            {state.error && !failed && (
              <p role="alert" className="panel-footnote">
                {state.error}
              </p>
            )}
            <>
              {showPodium && (
                <div className="live-podium">
                  {Array.from(
                    { length: PODIUM_SIZE },
                    (_, index) => items[index],
                  ).map((w, index) => (
                    <PodiumCard
                      key={index}
                      rank={index + 1}
                      w={w}
                      pending={!w && !knownAbsent(index)}
                      metric={metric}
                      window={window}
                    />
                  ))}
                </div>
              )}
              <div className="table-scroll desktop-traders">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Trader</th>
                      <th>
                        {metric === "realized" ? "Realized PnL" : "Net ETH"}
                      </th>
                      <th>ROI</th>
                      <th>W / L</th>
                      <th>Trades</th>
                      <th>Volume</th>
                      <th>Positions</th>
                      <th>Best sale</th>
                      <th>Last</th>
                      <th aria-label="Follow" />
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(
                      { length: listCount },
                      (_, i) => listOffset + i,
                    ).map((index) => (
                      <DesktopTraderRow
                        key={index}
                        index={index}
                        w={items[index]}
                        pending={!items[index] && !knownAbsent(index)}
                        metric={metric}
                        window={window}
                        now={now}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mobile-traders">
                {Array.from(
                  { length: listCount },
                  (_, i) => listOffset + i,
                ).map((index) => (
                  <MobileTraderCard
                    key={index}
                    index={index}
                    w={items[index]}
                    pending={!items[index] && !knownAbsent(index)}
                    metric={metric}
                    window={window}
                  />
                ))}
              </div>
            </>
            {failed && <UnavailableState subject="Leaderboard" />}
            {settled && total === 0 && (
              <div className="empty-state">
                <h3>No qualifying traders in this window</h3>
                <p>Try a wider window.</p>
              </div>
            )}
            <ShowMore
              shown={shown}
              total={failed ? 0 : total}
              cap={CAP}
              loading={state.loading}
              onMore={handleMore}
            />
          </>
        ) : (
          <>
            {following.error && !followingFailed && (
              <p role="alert" className="panel-footnote">
                {following.error}
              </p>
            )}
            {followingFailed && <UnavailableState subject="Following" />}
            {followedTotal > 0 && !followingFailed && (
              <>
                <div className="table-scroll desktop-traders following-traders">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Trader</th>
                        <th>
                          {metric === "realized" ? "Realized PnL" : "Net ETH"}
                        </th>
                        <th>ROI</th>
                        <th>W / L</th>
                        <th>Trades</th>
                        <th>Volume</th>
                        <th>Positions</th>
                        <th>Best sale</th>
                        <th>Last</th>
                        <th aria-label="Follow" />
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: followedReserved }, (_, index) =>
                        followedPending ? undefined : following.items[index],
                      ).map((w, index) => (
                        <DesktopTraderRow
                          key={index}
                          index={index}
                          w={w}
                          pending={followedPending}
                          metric={metric}
                          window={window}
                          now={now}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mobile-traders following-traders">
                  {Array.from({ length: followedReserved }, (_, index) =>
                    followedPending ? undefined : following.items[index],
                  ).map((w, index) => (
                    <MobileTraderCard
                      key={index}
                      index={index}
                      w={w}
                      pending={followedPending}
                      metric={metric}
                      window={window}
                    />
                  ))}
                </div>
                <ShowMore
                  shown={followedReserved}
                  total={followedTotal}
                  loading={followedPending}
                  onMore={handleFollowedMore}
                />
              </>
            )}
            {!followedTotal && (
              <div className="empty-state">
                <h3>You are not following anyone yet</h3>
                <p>
                  Follow a wallet from this leaderboard or a wallet profile to
                  see it here.
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
