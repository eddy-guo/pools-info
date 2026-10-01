import { visualTheme, windows, type LiveWindow } from "@pools/core";

/**
 * The PnL card's customize options. The wallet page's modal and the card route
 * share this module so the previewed image and the shared image are the same
 * request: every toggle becomes a query parameter, never a client-side render.
 */
export const cardPresets = {
  lime: { label: "Lime", color: visualTheme.accent },
  mint: { label: "Mint", color: "#4de1c1" },
  green: { label: "Green", color: "#3bf07a" },
  amber: { label: "Amber", color: "#ffb84d" },
  mono: { label: "Mono", color: visualTheme.text },
} as const;
export type CardPreset = keyof typeof cardPresets;
export const defaultCardPreset: CardPreset = "lime";

/**
 * `liquid` is the card shipped first (PR 56) and stays the default so every
 * existing card URL keeps rendering the same PNG; `export` is the captain's
 * own export's layout (wordmark, chip, identity, the realized amount as the
 * headline, a fixed trio, profile URL), added beside it, for the portfolio
 * and the position card alike. `notional` says whether the design honours
 * the notional option: the export layout's headline is already the realized
 * amount and its fixed trio has no slot for another amount, so the option is
 * offered disabled there rather than rendering the same image either way.
 */
export const cardDesigns = {
  liquid: { label: "Liquid", notional: true },
  export: { label: "Export", notional: false },
} as const;
export type CardDesign = keyof typeof cardDesigns;
export const defaultCardDesign: CardDesign = "liquid";
/** The unit every amount on the card is drawn in: the site's ETH/USD toggle. */
export type CardUnit = "ETH" | "USD";

export interface CardOptions {
  window: LiveWindow;
  preset: CardPreset;
  design: CardDesign;
  /** Hides the address, its identicon and the rank. */
  anonymous: boolean;
  /**
   * Shows the amounts behind the percentages: on the portfolio card the
   * realized amount and the traded volume, on a position card the realized
   * amount, the units held and ETH in and out. Off by default on the
   * portfolio card, on by default on a position card (whose first links all
   * showed them), and always false on a design that does not honour it.
   */
  notional: boolean;
  unit: CardUnit;
  /**
   * The ETH/USD rate the page beside the card was showing, so the card in USD
   * prints the page's own figures. The route draws with it only when it has
   * served that very rate itself moments ago (`cardUsdPerEth`); anything
   * else, a stale or hand-written rate included, is read again or falls back
   * to ETH. Null outside USD.
   */
  usdPerEth: number | null;
}
export const defaultCardOptions: CardOptions = {
  window: "All",
  preset: defaultCardPreset,
  design: defaultCardDesign,
  anonymous: false,
  notional: false,
  unit: "ETH",
  usdPerEth: null,
};
/** The card's scope: a position card names its pool and the pool's launch. */
export interface CardPoolScope {
  pool: string;
  launch: string;
}

/**
 * Unknown or missing values fall back to the defaults, so a stale link still
 * renders. A `pool` names a position card, whose notional default is on.
 */
export function parseCardOptions(params: URLSearchParams): CardOptions {
  const window = params.get("window"),
    preset = params.get("theme"),
    requested = params.get("design"),
    design =
      requested && Object.hasOwn(cardDesigns, requested)
        ? (requested as CardDesign)
        : defaultCardOptions.design,
    unit: CardUnit = params.get("unit") === "usd" ? "USD" : "ETH",
    rate = Number(params.get("rate") ?? NaN);
  return {
    window:
      window && Object.hasOwn(windows, window)
        ? (window as LiveWindow)
        : defaultCardOptions.window,
    preset:
      preset && Object.hasOwn(cardPresets, preset)
        ? (preset as CardPreset)
        : defaultCardOptions.preset,
    design,
    anonymous: params.get("anon") === "1",
    notional:
      cardDesigns[design].notional &&
      (params.has("pool")
        ? params.get("notional") !== "0"
        : params.get("notional") === "1"),
    unit,
    usdPerEth:
      unit === "USD" && Number.isFinite(rate) && rate > 0 ? rate : null,
  };
}

/**
 * The card's query, defaults omitted so the plain window link stays the
 * canonical one. A `scope` names a position card, which is one history in
 * one pool rather than a window, so it carries no window: a parameter the
 * image ignores would render one image under two URLs.
 */
export function cardQuery(
  options: CardOptions,
  scope?: CardPoolScope,
): URLSearchParams {
  const params = new URLSearchParams();
  if (scope) {
    params.set("pool", scope.pool);
    params.set("launch", scope.launch);
  } else params.set("window", options.window);
  if (options.preset !== defaultCardPreset) params.set("theme", options.preset);
  if (options.anonymous) params.set("anon", "1");
  if (cardDesigns[options.design].notional) {
    if (scope && !options.notional) params.set("notional", "0");
    if (!scope && options.notional) params.set("notional", "1");
  }
  if (options.design !== defaultCardDesign)
    params.set("design", options.design);
  if (options.unit === "USD") {
    params.set("unit", "usd");
    if (options.usdPerEth !== null)
      params.set("rate", String(options.usdPerEth));
  }
  return params;
}

export function cardUrl(
  address: string,
  options: CardOptions,
  scope?: CardPoolScope,
): string {
  return `/cards/${address.toLowerCase()}.png?${cardQuery(options, scope)}`;
}

/** The pill beside the token: the window the return covers, never a side. */
export function cardWindowLabel(window: LiveWindow): string {
  return window.toUpperCase();
}
