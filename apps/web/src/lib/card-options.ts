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
 * own export's layout (wordmark, window chip, monogram, realized PnL in ETH,
 * ROI / Record / Best trade, profile URL), added beside it. `notional` says
 * whether the design honours the notional option: the export layout's
 * headline is already the realized amount and its fixed trio has no slot for
 * the traded volume, so the option is offered disabled there rather than
 * rendering the same image either way.
 */
export const cardDesigns = {
  liquid: { label: "Liquid", notional: true },
  export: { label: "Export", notional: false },
} as const;
export type CardDesign = keyof typeof cardDesigns;
export const defaultCardDesign: CardDesign = "liquid";

export interface CardOptions {
  window: LiveWindow;
  preset: CardPreset;
  design: CardDesign;
  /** Hides the address, its identicon and the rank. */
  anonymous: boolean;
  /**
   * Shows the realized amount beside the percentage and the traded volume.
   * Always false on a design that does not honour it.
   */
  notional: boolean;
}
export const defaultCardOptions: CardOptions = {
  window: "All",
  preset: defaultCardPreset,
  design: defaultCardDesign,
  anonymous: false,
  notional: false,
};

/** Unknown or missing values fall back to the defaults, so a stale link still renders. */
export function parseCardOptions(params: URLSearchParams): CardOptions {
  const window = params.get("window"),
    preset = params.get("theme"),
    requested = params.get("design"),
    design =
      requested && Object.hasOwn(cardDesigns, requested)
        ? (requested as CardDesign)
        : defaultCardOptions.design;
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
    notional: cardDesigns[design].notional && params.get("notional") === "1",
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
  if (options.notional && cardDesigns[options.design].notional)
    params.set("notional", "1");
  if (options.design !== defaultCardDesign)
    params.set("design", options.design);
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
