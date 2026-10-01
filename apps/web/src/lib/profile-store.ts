"use client";
import type { CardDesign } from "./card-options";
import { useCardDesign } from "@/components/card-design";
import { useFollowing } from "@/components/following-store";
import { useMyWallet } from "@/components/my-wallet";
import type { FollowToggle, WatchToggle } from "@/components/saved-toast";
import { useWatchlist } from "@/components/state";

/**
 * The one hook everything personal reads through: the You page's sections,
 * the header's entry and its counts, every follow button and every star.
 * Today there is one mode, `local`: the four browser-local stores under
 * their own localStorage keys (`poolsinfo.watchlist.v1`,
 * `poolsinfo.following.v1`, `poolsinfo.my-wallet.v1`,
 * `poolsinfo.card-design.v1`), with no account behind them. A signed-in
 * mode would answer the same shape from an account and keep these keys as
 * its local cache, so the surfaces that read this never change with it.
 */
export interface ProfileStore {
  mode: "local";
  /** The wallet this browser marked as its own, lower-cased, or "". */
  address: string;
  /** Watched pool ids, in the order they were starred. */
  watch: string[];
  /** Followed wallet addresses, lower-cased, in the order they were followed. */
  follow: string[];
  /** Star or unstar a pool, and say which happened. */
  toggleWatch: (poolId: string) => WatchToggle;
  /** Follow or unfollow a wallet, and say which happened; a refusal (the
      cap, unwritable storage) also lands in `followError`. */
  toggleFollow: (address: string) => FollowToggle;
  followError: string;
  /** False on the server and where storage cannot be read at all, so a
      control that writes here can wait or say so. */
  available: boolean;
  cardDefaults: { design: CardDesign };
}

export function useProfileStore(): ProfileStore {
  const { address } = useMyWallet();
  const { ids, toggle: toggleWatch } = useWatchlist();
  const { addresses, toggle: toggleFollow, error, available } = useFollowing();
  const { design } = useCardDesign();
  return {
    mode: "local",
    address,
    watch: ids,
    follow: addresses,
    toggleWatch,
    toggleFollow,
    followError: error,
    available,
    cardDefaults: { design },
  };
}
