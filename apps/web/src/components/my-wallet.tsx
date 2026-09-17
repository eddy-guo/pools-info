"use client";

import { useSyncExternalStore } from "react";
import { UserRound, UserRoundCheck } from "lucide-react";

/**
 * The one wallet this browser calls its own: an address the user marks from
 * its page, saved like the follow list and the watchlist, with no connection
 * and no signature. The leaderboard's "you" row and the wallet page's
 * portfolio framing read it; nothing else does.
 */
const key = "poolsinfo.my-wallet.v1";
const changed = "poolsinfo-my-wallet-changed";
const valid = (address: string) => /^0x[0-9a-f]{40}$/i.test(address);
function read() {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return null;
  }
}
function parse(raw: string | null) {
  return raw && valid(raw) ? raw.toLowerCase() : "";
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) notify();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(changed, notify);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(changed, notify);
  };
}
/* The server cannot know the browser's wallet, so it renders the unset state
   and hydration swaps in the saved one. */
const serverSnapshot = () => null;
export function useMyWallet() {
  const raw = useSyncExternalStore(subscribe, read, serverSnapshot);
  const address = parse(raw);
  function set(next: string) {
    try {
      if (next && valid(next)) localStorage.setItem(key, next.toLowerCase());
      else localStorage.removeItem(key);
      window.dispatchEvent(new Event(changed));
    } catch {
      /* Storage may be unavailable in private browsers. */
    }
  }
  return {
    address,
    isMine: (candidate: string) =>
      address !== "" && candidate.toLowerCase() === address,
    set,
    available: raw !== null,
  };
}

/**
 * The wallet page's action: mark this address as the browser's own, or unmark
 * it. The label is the same in both states (the icon and the pressed style
 * carry the state) so the stored state, arriving at hydration, moves none of
 * the actions beside it.
 */
export function MyWalletButton({ address }: { address: string }) {
  const { isMine, set, available } = useMyWallet();
  const mine = isMine(address);
  return (
    <button
      type="button"
      className="button secondary my-wallet-button"
      aria-pressed={mine}
      disabled={!available}
      title="Saved only in this browser"
      onClick={() => set(mine ? "" : address)}
    >
      {mine ? <UserRoundCheck size={16} /> : <UserRound size={16} />}
      This is my wallet
    </button>
  );
}
