"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

/**
 * A growable list reserves its rows from first paint, and an answer shorter
 * than that reservation releases the rows it will never fill. The
 * list's own rows above the cut do not move, but everything under the list
 * (its Show more foot, a rail stacked below it, the site footer) moves up,
 * usually from below the fold into view, and Chrome scores that as a layout
 * shift even though the reader never saw those nodes anywhere else.
 *
 * So a resize remounts them: each node under a list keys itself on
 * `useBelowListKey()`, and a list whose reserved row count changes bumps that
 * key in a layout effect, which React flushes in the same frame as the
 * resize. The nodes under the list are then new nodes at their new place,
 * which Chrome never scores, the same remount-not-resize trick the
 * browser-local stores use for their hydration swap. A resize that comes
 * with a new `shown` (Show more, or a tab resetting the URL's limit) does not
 * bump it: that is the reader's own input, which Chrome already leaves
 * unscored, and a remount would take focus off the Show more button the
 * reader just pressed.
 */
let releases = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The key the nodes under a growable list remount on. */
export function useBelowListKey() {
  return useSyncExternalStore(
    subscribe,
    () => releases,
    () => 0,
  );
}

/** Reports a list's reserved row count for its `shown` rows; a change the
    reader's own `shown` did not make remounts the nodes under the list. */
export function useListRelease(rows: number, shown: number) {
  const previous = useRef({ rows, shown });
  useLayoutEffect(() => {
    const last = previous.current;
    if (rows !== last.rows && shown === last.shown) {
      releases += 1;
      for (const listener of listeners) listener();
    }
    previous.current = { rows, shown };
  }, [rows, shown]);
}
