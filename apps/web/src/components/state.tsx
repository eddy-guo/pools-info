"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
/**
 * A text control that shows every keystroke while the URL - and the request it
 * drives - follows only once typing settles. `flush` commits at once, so a
 * deliberate Enter or blur never waits out the delay.
 */
export function useDebouncedInput(
  value: string,
  commit: (next: string) => void,
  delay = 200,
) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The URL moved on its own - a history step, a reset, a fresh link - so follow it.
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  // That move, and unmounting, supersede a keystroke still waiting to be written.
  useEffect(() => () => clearTimeout(timer.current), [seen]);
  return {
    value: draft,
    set(next: string) {
      setDraft(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        commit(next);
      }, delay);
    },
    flush() {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      commit(draft);
    },
  };
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
