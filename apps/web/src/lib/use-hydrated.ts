"use client";
import { useSyncExternalStore } from "react";

const noHydrationUpdates = () => () => {};
/**
 * False on the server and through the hydration render, true from the first
 * client render after it. A page whose content lives in this browser (the
 * You page's lists, the chart's controls) paints what the server could see
 * until then, and swaps to the real thing in the same synchronous re-render
 * that the browser-local stores themselves trigger.
 */
export function useHydrated() {
  return useSyncExternalStore(
    noHydrationUpdates,
    () => true,
    () => false,
  );
}
