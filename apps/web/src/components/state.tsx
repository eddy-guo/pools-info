"use client";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import type { Manifest } from "@pools/core";

const ManifestContext = createContext<Manifest | null>(null);
export function DataProvider({
  manifest,
  children,
}: {
  manifest: Manifest;
  children: React.ReactNode;
}) {
  return <ManifestContext value={manifest}>{children}</ManifestContext>;
}
export function useManifest() {
  const value = useContext(ManifestContext);
  if (!value) throw new Error("Missing data provider");
  return value;
}
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
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage may be unavailable in private browsers. */
  }
  window.dispatchEvent(new Event("pools-preferences"));
}
export function useCurrency() {
  const value = useSyncExternalStore(
    subscribePrefs,
    () => readLocal("pools:currency"),
    () => "ETH",
  );
  return {
    currency: value === "USD" ? ("USD" as const) : ("ETH" as const),
    setCurrency: (currency: "ETH" | "USD") =>
      writeLocal("pools:currency", currency),
  };
}
export function useWatchlist() {
  const value = useSyncExternalStore(
    subscribePrefs,
    () => readLocal("pools:watchlist"),
    empty,
  );
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (Array.isArray(parsed))
      ids = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    /* Ignore a malformed device preference. */
  }
  return {
    ids,
    toggle: (id: string) =>
      writeLocal(
        "pools:watchlist",
        JSON.stringify(
          ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id],
        ),
      ),
  };
}
