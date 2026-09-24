/**
 * The ranked trader leaderboard's row arithmetic, shared by the component
 * that renders the list and by the pre-paint script that reserves its height.
 */

/** The leaderboard never requests past its top 100, whatever the API allows. */
export const RANKED_CAP = 100;
/** The podium always holds ranks 1-3; the flat list starts past them when the
    podium shows, and shows every rank (including 1-3, coloured) when it does
    not - a window with fewer than three wallets, or the Following tab. The
    flat list therefore runs this many rows behind the "shown" count the URL
    and the pagination line track. */
export const PODIUM_SIZE = 3;
/** The rows the list shows before the first "Show more". */
export const RANKED_DEFAULT_SHOWN = 25;

/** The "shown" count a `limit` search parameter names, or the default. */
export function rankedShown(limit: string | null | undefined): number {
  const raw = Number(limit);
  return Number.isInteger(raw) && raw > 0 && raw <= RANKED_CAP
    ? raw
    : RANKED_DEFAULT_SHOWN;
}

/**
 * `/traders/` is statically prerendered, so the served HTML cannot know the
 * URL's `limit` and always paints the default 25-row shell; hydration then
 * corrects the count. A browser that restores a deep scroll position onto
 * that short shell has the pagination foot and the site footer on screen, and
 * the correction pushes both off it - a real layout shift with no user input
 * behind it, and the reader's place in the list lost with it.
 *
 * This runs before first paint, where `location.search` is readable and the
 * served row area can still be sized for the list the URL actually names. It
 * mirrors `rankedShown` above rather than importing it, because an inline
 * pre-paint script cannot import; the numbers it closes over are the ones
 * above, and `globals.css` reads `--ranked-rows` for the list's min-height.
 */
export const rankedRowsScript = `(function(){try{var n=Number(new URLSearchParams(location.search).get("limit"));var s=Number.isInteger(n)&&n>0&&n<=${RANKED_CAP}?n:${RANKED_DEFAULT_SHOWN};document.documentElement.style.setProperty("--ranked-rows",String(Math.max(0,s-${PODIUM_SIZE})));}catch(e){}})();`;
