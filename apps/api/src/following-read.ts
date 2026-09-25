import type { WalletHistoryTrade, WalletHistoryUnavailable } from "@pools/core";
import { parseFollowingWallets } from "@pools/core";
import { RequestError } from "./request";
import type { TokenRegistry } from "./token-registry";
import type { TradesSnapshot, WalletHistory } from "./wallet-history";

/** One followed wallet's trade as the explorer lists it: the wallet's ERC-20
 * leg against the PoolManager in a token of the verified registry. It carries
 * no ETH amount and no price; those are not in the explorer's transfer. */
export interface FollowingTrade {
  /** `txHash:logIndex`, unique in a response. */
  id: string;
  wallet: string;
  /** The registry's pool for the token; null when the registry holds more
   * than one pool for it. */
  poolId: string | null;
  token: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  txHash: string;
  logIndex: number;
  block: number;
  /** Unix seconds; null when the explorer has not attached a block time. */
  timestamp: number | null;
  side: "buy" | "sell";
  /** Raw token amount as an exact decimal string; scale by `decimals`. */
  tokenRaw: string;
  method: string | null;
}
/** What the answer holds for one requested wallet. `read`: its first explorer
 * page as of `fetchedAt`. `stale`: the last refresh failed for `reason` and
 * the page from `fetchedAt` is served. `pending`: not read yet, since one
 * answer reads a bounded number of wallets; a later poll reads it.
 * `unavailable`: the read failed for `reason` and nothing was ever read. */
export interface FollowingWalletCoverage {
  wallet: string;
  status: "read" | "stale" | "pending" | "unavailable";
  fetchedAt: string | null;
  reason: WalletHistoryUnavailable["reason"] | null;
  /** The explorer holds older transfers than the page read. */
  olderTrades: boolean;
  /** Where the page read ends when `olderTrades`: this wallet's trades at or
   * below this block may be missing from the items, while other wallets'
   * trades there are listed. Null when the page reaches the wallet's first
   * transfer, or when nothing was read. */
  horizonBlock: number | null;
}
export interface FollowingTradesResponse {
  source: "blockscout";
  scope: "explorer_registry_trades";
  items: FollowingTrade[];
  /** More trades exist than the items: the merge was cut at `limit`, or a
   * wallet's explorer page ends before its first transfer. */
  hasMore: boolean;
  notice: string;
  note: "Explorer history for display only; not accounting or PnL evidence.";
  coverage: {
    requestedWallets: number;
    /** Distinct tokens among the items. */
    returnedTokens: number;
    wallets: FollowingWalletCoverage[];
    generatedAt: string;
    complete: false;
    registryExhaustive: false;
  };
}

/** A followed wallet's newest trading activity in the ledger, unix seconds;
 * null for the whole answer when the deployment serves no ledger. */
export type WalletActivity = (
  wallets: readonly string[],
) => Promise<ReadonlyMap<string, number> | null>;

export interface Following {
  read(
    wallets: readonly string[],
    limit: number,
  ): Promise<FollowingTradesResponse>;
}

export const followingPolicy = Object.freeze({
  /** Explorer reads one answer may start. The limiter starts 5 a second, so
   * the last starts after 1 s and, at 2.0-4.6 s a page from Railway, the
   * answer lands inside the website proxy's 8 s abort. */
  maxReadsPerAnswer: 8,
  /** A wallet whose ledger activity is newer than its newest listed trade
   * and than the activity its page was read under is read again once its
   * page is this old. */
  activityRefreshMs: 120000,
  /** Activity the ledger already showed when the page was read, but the page
   * does not list (the explorer indexes behind the ledger, or the activity
   * is not a PoolManager leg of the wallet): read again this often while
   * that activity is younger than `explorerLagSeconds`. */
  lagRetryMs: 300000,
  explorerLagSeconds: 900,
  /** Without a ledger signal a page is read again once this old. */
  unsignalledRefreshMs: 600000,
  /** Every page is read again once this old, whatever the ledger says. */
  maxAgeMs: 21600000,
  /** Following never spends the last fifth of the day's explorer credits,
   * which stay for the wallet page's own reads. */
  reserveShare: 0.2,
});

/** The block where a wallet's page ends, null when nothing follows it. */
function horizon(snapshot: TradesSnapshot): number | null {
  if (!snapshot.next) return null;
  const block = Number(snapshot.next.block_number);
  if (Number.isSafeInteger(block)) return block;
  // An unreadable position: nothing below the page's newest trade is known.
  return snapshot.items[0]?.block ?? Number.MAX_SAFE_INTEGER;
}
function newerFirst(a: WalletHistoryTrade, b: WalletHistoryTrade) {
  return (
    b.block - a.block ||
    b.logIndex - a.logIndex ||
    (a.transactionHash < b.transactionHash ? -1 : 1)
  );
}

/** Following is the explorer's per-swap trade list of each followed wallet
 * (the wallet history route's `kind=trades`, registry filter included): the
 * first explorer page of each, merged newest first. A wallet whose page ends
 * early (a launcher's page of transfers can span hours) keeps its own
 * horizon rather than cutting every other wallet's trades at it. A page is read again only when the ledger shows the
 * wallet trading since it was read, or when it ages out, so a feed polled
 * every 30 seconds spends credits in proportion to what its wallets do. */
export function createFollowing({
  history,
  registry,
  activity,
  now = Date.now,
  policy = followingPolicy,
}: {
  history: WalletHistory;
  registry: TokenRegistry | null;
  activity: WalletActivity;
  now?: () => number;
  policy?: typeof followingPolicy;
}): Following {
  function answer(
    items: FollowingTrade[],
    hasMore: boolean,
    wallets: FollowingWalletCoverage[],
  ): FollowingTradesResponse {
    return {
      source: "blockscout",
      scope: "explorer_registry_trades",
      items,
      hasMore,
      notice:
        "Each followed wallet's newest explorer trades in verified-registry tokens. No ETH amounts or prices; wallets not read yet are listed in coverage.",
      note: "Explorer history for display only; not accounting or PnL evidence.",
      coverage: {
        requestedWallets: wallets.length,
        returnedTokens: new Set(items.map((item) => item.token)).size,
        wallets,
        generatedAt: new Date(now()).toISOString(),
        complete: false,
        registryExhaustive: false,
      },
    };
  }
  /** The ledger's activity mark each wallet's page was read under. */
  const marks = new Map<string, number | null>();
  function due(
    snapshot: TradesSnapshot | null,
    wallet: string,
    ledger: ReadonlyMap<string, number> | null,
  ): boolean {
    if (!snapshot) return true;
    const age = now() - snapshot.fetchedAt;
    if (age >= policy.maxAgeMs) return true;
    if (!ledger) return age >= policy.unsignalledRefreshMs;
    const last = ledger.get(wallet);
    const listed = Math.max(
      -1,
      ...snapshot.items.map((t) => t.timestamp ?? -1),
    );
    if (last === undefined || last <= listed) return false;
    const mark = marks.get(wallet);
    if (mark === undefined || mark === null || last > mark)
      return age >= policy.activityRefreshMs;
    return (
      age >= policy.lagRetryMs &&
      last >= Math.floor(now() / 1000) - policy.explorerLagSeconds
    );
  }
  return {
    async read(requested, limit) {
      const wallets = parseFollowingWallets(requested.join(","));
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new RequestError(400, "invalid_limit");
      if (!registry)
        throw new RequestError(503, "wallet_history_unavailable", {
          reason: "not_configured",
          retryAfter: 3600,
        });
      if (!wallets.length) return answer([], false, []);
      // Loads the registry before any credit is spent, and re-checks cached
      // pages against the set a full reload may have shrunk.
      const registered = await registry.current();
      let ledger: ReadonlyMap<string, number> | null = null;
      try {
        ledger = await activity(wallets);
      } catch {
        process.stderr.write('{"event":"following_activity_failed"}\n');
      }
      const cached = new Map(wallets.map((w) => [w, history.peekTrades(w)]));
      // Never-read wallets first, then the most recently active in the ledger.
      const refresh = wallets
        .filter((w) => due(cached.get(w) ?? null, w, ledger))
        .sort(
          (a, b) =>
            Number(!!cached.get(a)) - Number(!!cached.get(b)) ||
            (ledger?.get(b) ?? -1) - (ledger?.get(a) ?? -1) ||
            (a < b ? -1 : 1),
        )
        .slice(0, policy.maxReadsPerAnswer);
      const failures = new Map<string, RequestError>();
      await Promise.all(
        refresh.map(async (wallet) => {
          const mark = ledger?.get(wallet) ?? null;
          try {
            const snapshot = await history.refreshTrades(wallet, {
              reserveShare: policy.reserveShare,
            });
            cached.set(wallet, snapshot);
            if (!snapshot.stale) {
              marks.delete(wallet);
              marks.set(wallet, mark);
              if (marks.size > 10000) marks.delete(marks.keys().next().value!);
            }
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            failures.set(wallet, error);
          }
        }),
      );
      const coverage: FollowingWalletCoverage[] = [];
      const trades: { wallet: string; trade: WalletHistoryTrade }[] = [];
      for (const wallet of wallets) {
        const snapshot = cached.get(wallet);
        const failed = failures.get(wallet);
        if (!snapshot) {
          coverage.push({
            wallet,
            status: failed ? "unavailable" : "pending",
            fetchedAt: null,
            reason: failed
              ? ((failed.reason as FollowingWalletCoverage["reason"]) ??
                "upstream_unavailable")
              : null,
            olderTrades: false,
            horizonBlock: null,
          });
          continue;
        }
        coverage.push({
          wallet,
          status: snapshot.stale ? "stale" : "read",
          fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
          reason: snapshot.reason,
          olderTrades: snapshot.next !== null,
          horizonBlock: horizon(snapshot),
        });
        for (const trade of snapshot.items)
          if (registered.has(trade.token.address))
            trades.push({ wallet, trade });
      }
      // Every wallet failed and none was ever read: the answer is the outage.
      const unavailable = coverage.filter((c) => c.status === "unavailable");
      if (unavailable.length === wallets.length)
        throw failures.get(wallets[0])!;
      trades.sort((a, b) => newerFirst(a.trade, b.trade));
      return answer(
        trades.slice(0, limit).map(({ wallet, trade }) => ({
          id: `${trade.transactionHash}:${trade.logIndex}`,
          wallet,
          poolId: registry.poolOf(trade.token.address),
          token: trade.token.address,
          symbol: trade.token.symbol,
          name: trade.token.name,
          decimals: trade.token.decimals,
          txHash: trade.transactionHash,
          logIndex: trade.logIndex,
          block: trade.block,
          timestamp: trade.timestamp,
          side: trade.side,
          tokenRaw: trade.tokenRaw,
          method: trade.method,
        })),
        trades.length > limit || coverage.some((c) => c.olderTrades),
        coverage,
      );
    },
  };
}
