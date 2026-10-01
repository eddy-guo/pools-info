"use client";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1)
    timer = setInterval(() => {
      for (const notify of listeners) notify();
    }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
const seconds = () => Math.floor(Date.now() / 1000);
const unknown = () => null;

/**
 * The browser's clock in whole seconds, shared by every relative "ago"
 * stamp: one interval ticks once a second while anything subscribes, and
 * the server (and a hydrating page, until React swaps in the client
 * snapshot) reads null, so no server-rendered markup ever carries a clock
 * reading the client would then contradict. Nothing here is a data cut: a
 * stamp still needs the read's own timestamp to say anything.
 */
export function useNowSeconds(): number | null {
  return useSyncExternalStore(subscribe, seconds, unknown);
}
