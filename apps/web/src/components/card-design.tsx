"use client";
import { useSyncExternalStore } from "react";
import {
  cardDesigns,
  defaultCardOptions,
  type CardDesign,
} from "@/lib/card-options";

/**
 * The PnL card design toggle's own choice, independent of the wallet or
 * window and shared with every open card modal the way the follow list is:
 * read through `useSyncExternalStore` so a value that differs from the
 * server's default never shows as a hydration mismatch. The key is one of
 * this browser's four profile keys (`docs/FOLLOWING-AND-WATCHLISTS.md`).
 */
const key = "poolsinfo.card-design.v1";
const changed = "poolsinfo-card-design-changed";
function read(): CardDesign {
  try {
    const saved = localStorage.getItem(key);
    return saved && Object.hasOwn(cardDesigns, saved)
      ? (saved as CardDesign)
      : defaultCardOptions.design;
  } catch {
    return defaultCardOptions.design;
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
const serverSnapshot = () => defaultCardOptions.design;
export function useCardDesign() {
  const design = useSyncExternalStore(subscribe, read, serverSnapshot);
  function setDesign(next: CardDesign) {
    try {
      localStorage.setItem(key, next);
      window.dispatchEvent(new Event(changed));
    } catch {
      // Best effort: the toggle just won't persist in this browser.
    }
  }
  return { design, setDesign };
}
