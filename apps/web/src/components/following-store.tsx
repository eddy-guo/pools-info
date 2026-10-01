"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { FOLLOWING_CAP, FOLLOWING_KEY, parseFollowing } from "@/lib/saved";
import type { FollowToggle } from "./saved-toast";

/*
 * The follow list this browser keeps: up to 200 wallet addresses under one
 * localStorage key, read through `useSyncExternalStore` with a null server
 * snapshot so the server paints the unset state and hydration swaps in the
 * saved list. Buttons and pages read it through `useProfileStore`
 * (lib/profile-store.ts), never here.
 */
const key = FOLLOWING_KEY;
const changed = "poolsinfo-following-changed";
const valid = (address: string) => /^0x[0-9a-f]{40}$/i.test(address);
function read() {
  try {
    return localStorage.getItem(key) ?? "[]";
  } catch {
    return null;
  }
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
const serverSnapshot = () => null;
/** The list is read through `parseFollowing` (lib/saved.ts), which the You
    page's pre-paint script mirrors; keep the two together. */
export function useFollowing() {
  const raw = useSyncExternalStore(subscribe, read, serverSnapshot);
  const addresses = useMemo(() => parseFollowing(raw), [raw]);
  const [error, setError] = useState("");
  /** Follows or unfollows, and says which; a refusal is also kept in
      `error` for the button that shows it inline. */
  function toggle(address: string): FollowToggle {
    if (!valid(address)) return "failed";
    const id = address.toLowerCase();
    const current = parseFollowing(read());
    const adding = !current.includes(id);
    if (adding && current.length >= FOLLOWING_CAP) {
      setError(
        `You can follow up to ${FOLLOWING_CAP} wallets in this browser.`,
      );
      return "capped";
    }
    const next = adding ? [...current, id] : current.filter((a) => a !== id);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setError("");
      window.dispatchEvent(new Event(changed));
      return adding ? "followed" : "unfollowed";
    } catch {
      setError("Could not save follows in this browser.");
      return "failed";
    }
  }
  return { addresses, toggle, error, available: raw !== null };
}
