"use client";

import { useId, type KeyboardEvent } from "react";

/**
 * The WAI-ARIA tabs pattern for a tablist over one panel: the panel is a
 * single element whose content follows the selected tab, so every tab
 * controls it and it is labelled by whichever tab is selected.
 *
 * Activation is manual. Left/Right (wrapping) and Home/End move focus along
 * the tabs, and Enter or Space selects the focused one through the button's
 * own click, because selecting a tab can start a read that costs something
 * (the wallet's Trades tab spends explorer credits), so arrowing past a tab
 * must not open it. Only the selected tab sits in the Tab sequence; the
 * others are reached with the arrow keys.
 */
export function useTabs<T extends string>(ids: readonly T[], selected: T) {
  const base = useId();
  const tabId = (id: T) => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const at = ids.indexOf(event.currentTarget.dataset.tab as T);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % ids.length
        : event.key === "ArrowLeft"
          ? (at - 1 + ids.length) % ids.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : null;
    if (next === null || at < 0) return;
    event.preventDefault();
    document.getElementById(tabId(ids[next]))?.focus();
  }
  return {
    tab: (id: T) => ({
      id: tabId(id),
      role: "tab" as const,
      type: "button" as const,
      "aria-selected": id === selected,
      "aria-controls": panelId,
      tabIndex: id === selected ? 0 : -1,
      "data-tab": id,
      onKeyDown,
    }),
    panel: {
      id: panelId,
      role: "tabpanel" as const,
      "aria-labelledby": tabId(selected),
    },
  };
}
