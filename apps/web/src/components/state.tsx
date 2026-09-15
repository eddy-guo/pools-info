"use client";
import { useCallback, useSyncExternalStore } from "react";
import { normalizePoolIds, parseSavedWatchlist } from "@/lib/watchlist";
const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
};
const getSearch = () => window.location.search;
const empty = () => "";
export function useQuery() {
  const raw = useSyncExternalStore(subscribe, getSearch, empty);
  const params = new URLSearchParams(raw);
  const set = useCallback((updates: Record<string, string | null>) => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(updates)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return { params, set };
}
const subscribePrefs = (callback: () => void) => {
  window.addEventListener("storage", callback);
  window.addEventListener("pools-preferences", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("pools-preferences", callback);
  };
};
function readLocal(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeLocal(key: string, value: string) {
  let saved = false;
  try {
    localStorage.setItem(key, value);
    saved = true;
  } catch {
    /* Storage may be unavailable in private browsers. */
  }
  window.dispatchEvent(new Event("pools-preferences"));
  return saved;
}
const savedWatchlist = () =>
  readLocal("poolsinfo.watchlist.v1") || readLocal("pools:watchlist");
export function useWatchlist() {
  const value = useSyncExternalStore(
    subscribePrefs,
    // Retain existing stars when adopting the design system's versioned key.
    savedWatchlist,
    empty,
  );
  const ids = parseSavedWatchlist(value);
  return {
    ids,
    toggle: (id: string) => {
      const normalized = normalizePoolIds([id])[0];
      if (!normalized) return false;
      // Read at the interaction boundary so another tab's latest stars survive.
      const current = parseSavedWatchlist(savedWatchlist());
      return writeLocal(
        "poolsinfo.watchlist.v1",
        JSON.stringify(
          current.includes(normalized)
            ? current.filter((v) => v !== normalized)
            : [...current, normalized],
        ),
      );
    },
    add: (incoming: readonly string[]) =>
      writeLocal(
        "poolsinfo.watchlist.v1",
        JSON.stringify(
          normalizePoolIds([
            ...parseSavedWatchlist(savedWatchlist()),
            ...incoming,
          ]),
        ),
      ),
  };
}
