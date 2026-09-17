import { visualTheme, windows, type LiveWindow } from "@pools/core";

/**
 * The PnL card's customize options. The wallet page's modal and the card route
 * share this module so the previewed image and the shared image are the same
 * request: every toggle becomes a query parameter, never a client-side render.
 */
export const cardPresets = {
  pink: { label: "Pink", color: visualTheme.accent },
  mint: { label: "Mint", color: "#4de1c1" },
  green: { label: "Green", color: "#3bf07a" },
  amber: { label: "Amber", color: "#ffb84d" },
  mono: { label: "Mono", color: visualTheme.text },
} as const;
export type CardPreset = keyof typeof cardPresets;
export const defaultCardPreset: CardPreset = "pink";

export interface CardOptions {
  window: LiveWindow;
  preset: CardPreset;
  /** Hides the address, its identicon and the rank. */
  anonymous: boolean;
  /** Shows the realized amount beside the percentage and the traded volume. */
  notional: boolean;
}
export const defaultCardOptions: CardOptions = {
  window: "All",
  preset: defaultCardPreset,
  anonymous: false,
  notional: false,
};

/** Unknown or missing values fall back to the defaults, so a stale link still renders. */
export function parseCardOptions(params: URLSearchParams): CardOptions {
  const window = params.get("window"),
    preset = params.get("theme");
  return {
    window:
      window && Object.hasOwn(windows, window)
        ? (window as LiveWindow)
        : defaultCardOptions.window,
    preset:
      preset && Object.hasOwn(cardPresets, preset)
        ? (preset as CardPreset)
        : defaultCardOptions.preset,
    anonymous: params.get("anon") === "1",
    notional: params.get("notional") === "1",
  };
}

/** The card's query, defaults omitted so the plain window link stays the canonical one. */
export function cardQuery(
  options: CardOptions,
  scope?: { pool: string; launch: string },
): URLSearchParams {
  const params = new URLSearchParams();
  if (scope) {
    params.set("pool", scope.pool);
    params.set("launch", scope.launch);
  }
  params.set("window", options.window);
  if (options.preset !== defaultCardPreset) params.set("theme", options.preset);
  if (options.anonymous) params.set("anon", "1");
  if (options.notional) params.set("notional", "1");
  return params;
}

export function cardUrl(
  address: string,
  options: CardOptions,
  scope?: { pool: string; launch: string },
): string {
  return `/cards/${address.toLowerCase()}.png?${cardQuery(options, scope)}`;
}

/** The pill beside the token: the window the return covers, never a side. */
export function cardWindowLabel(window: LiveWindow): string {
  return window.toUpperCase();
}
