"use client";

import { useSyncExternalStore } from "react";

/**
 * The one wallet this browser calls its own: an address the user marks from
 * through the header, saved like the follow list and the watchlist, with no
 * connection and no signature. The header menu, leaderboard's "you" row and
 * wallet page's portfolio framing read it; nothing else does.
 */
const key = "poolsinfo.my-wallet.v1";
const changed = "poolsinfo-my-wallet-changed";
/** The same 0x check the header's set-wallet dialog validates against. */
export const isWalletAddress = (address: string) =>
  /^0x[0-9a-f]{40}$/i.test(address);
function read() {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return null;
  }
}
function parse(raw: string | null) {
  return raw && isWalletAddress(raw) ? raw.toLowerCase() : "";
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
      if (next && isWalletAddress(next))
        localStorage.setItem(key, next.toLowerCase());
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
