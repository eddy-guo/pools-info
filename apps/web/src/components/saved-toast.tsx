"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  CircleAlert,
  Star,
  UserRoundCheck,
  UserRoundMinus,
  X,
} from "lucide-react";
import { shortAddress } from "@pools/core";

/*
 * The one-line confirmation under a star or a follow, wherever it happened:
 * what changed, a View link to the You page section that now lists it, or
 * Undo where something was removed. One note at a time (a newer one
 * replaces the older), fixed over the page so it never enters layout,
 * announced through a polite live region that is always mounted. It stays
 * four seconds, longer while hovered or focused; Escape dismisses it; the
 * link is focusable but focus is never moved to it. `ToastProvider` mounts
 * the region once, in the root layout; `useToast` (or `showToast`) raises a
 * note from anywhere, and `confirmWatch`/`confirmFollow` are the two notes
 * every star and follow button share.
 */

export type ToastIcon = "star" | "star-off" | "follow" | "unfollow" | "warn";
export interface ToastInput {
  text: string;
  icon?: ToastIcon;
  href?: string;
  hrefLabel?: string;
  undo?: () => void;
}
type Toast = ToastInput & { id: number };

/** How long a note stays without a pointer or focus on it. */
export const TOAST_MS = 4000;

let current: Toast | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const read = () => current;
const serverSnapshot = () => null;

export function showToast(input: ToastInput) {
  current = { id: ++sequence, ...input };
  emit();
}
export function dismissToast() {
  if (current === null) return;
  current = null;
  emit();
}
export function useToast() {
  return { show: showToast, dismiss: dismissToast };
}

export type WatchToggle = "watched" | "unwatched" | "failed";
export type FollowToggle = "followed" | "unfollowed" | "capped" | "failed";
const failed = { icon: "warn", text: "Could not save in this browser" } as const;

/** What a star says once it has been toggled: where the pool went, or Undo. */
export function confirmWatch(result: WatchToggle, undo: () => void) {
  if (result === "watched")
    showToast({
      icon: "star",
      text: "Added to your watchlist",
      href: "/you/#watchlist",
      hrefLabel: "View",
    });
  else if (result === "unwatched")
    showToast({ icon: "star-off", text: "Removed from your watchlist", undo });
  else showToast(failed);
}
/** What a follow button says once it has been toggled. */
export function confirmFollow(
  result: FollowToggle,
  address: string,
  undo: () => void,
) {
  const who = shortAddress(address);
  if (result === "followed")
    showToast({
      icon: "follow",
      text: `Following ${who}`,
      href: "/you/#following",
      hrefLabel: "View",
    });
  else if (result === "unfollowed")
    showToast({ icon: "unfollow", text: `Unfollowed ${who}`, undo });
  else if (result === "capped")
    showToast({
      icon: "warn",
      text: "You can follow up to 200 wallets in this browser",
    });
  else showToast(failed);
}

function Icon({ icon }: { icon: ToastIcon }) {
  switch (icon) {
    case "star":
      return <Star size={16} fill="currentColor" />;
    case "star-off":
      return <Star size={16} />;
    case "follow":
      return <UserRoundCheck size={16} />;
    case "unfollow":
      return <UserRoundMinus size={16} />;
    case "warn":
      return <CircleAlert size={16} />;
  }
}

function ToastRegion() {
  const toast = useSyncExternalStore(subscribe, read, serverSnapshot);
  const timer = useRef<number | undefined>(undefined);
  const pause = useCallback(() => window.clearTimeout(timer.current), []);
  const arm = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(dismissToast, TOAST_MS);
  }, []);
  useEffect(() => {
    if (!toast) return;
    arm();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissToast();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      pause();
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [toast, arm, pause]);
  return (
    <div className="saved-toast-region" role="status" aria-live="polite">
      {toast && (
        <div
          className="saved-toast"
          key={toast.id}
          data-icon={toast.icon ?? "warn"}
          onPointerEnter={pause}
          onPointerLeave={arm}
          onFocus={pause}
          onBlur={arm}
        >
          <span className="saved-toast-icon" aria-hidden="true">
            <Icon icon={toast.icon ?? "warn"} />
          </span>
          <span className="saved-toast-text">{toast.text}</span>
          {toast.href && (
            <Link
              className="saved-toast-link"
              href={toast.href}
              onClick={dismissToast}
            >
              {toast.hrefLabel ?? "View"}
            </Link>
          )}
          {toast.undo && (
            <button
              type="button"
              className="saved-toast-link"
              onClick={() => {
                toast.undo?.();
                dismissToast();
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            className="icon-button saved-toast-close"
            aria-label="Dismiss"
            onClick={dismissToast}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Mounted once, in the root layout, so every page shares the one region. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <ToastRegion />
    </>
  );
}
