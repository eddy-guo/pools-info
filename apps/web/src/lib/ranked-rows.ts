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

/** The Following tab's own cap and default page: `following.tsx` keeps at
    most this many addresses, and `flimit` grows the list in these steps. */
export const FOLLOWED_CAP = 200;
const FOLLOWED_DEFAULT_SHOWN = 25;

/**
 * `/traders/` is statically prerendered, so the served HTML cannot know the
 * URL's `limit` and always paints the default 25-row shell; hydration then
 * corrects the count. A browser that restores a deep scroll position onto
 * that short shell has the pagination foot and the site footer on screen, and
 * the correction pushes both off it - a real layout shift with no user input
 * behind it, and the reader's place in the list lost with it.
 *
 * The served shell cannot know `view=following` either: it paints the ranked
 * board, and hydration then swaps in the browser-local Following list, which
 * with nothing followed is a short empty state (the footer moved up into view,
 * 0.04 at 1440 and 0.05 at 1024). So for that view the script also marks the
 * root `data-ranked-view="following"` (and `data-following-empty` with nothing
 * followed) and sets `--following-rows` to the rows the list will reserve,
 * `min(flimit or 25, followed)`, reading the store the
 * way `parse` in `following.tsx` does; `ProductTraders` serves both views'
 * shells and `globals.css` shows the one this mark names until hydration.
 *
 * This runs before first paint, where `location.search` and localStorage are
 * readable and the served row area can still be sized for the list the URL
 * actually names. It mirrors `rankedShown` above and the Following reads in
 * `ProductTraders` rather than importing them, because an inline pre-paint
 * script cannot import; the numbers it closes over are the ones above, and
 * `globals.css` reads `--ranked-rows` and `--following-rows` for the lists'
 * min-heights.
 */
export const rankedRowsScript = `(function(){try{var q=new URLSearchParams(location.search),d=document.documentElement;var n=Number(q.get("limit"));var s=Number.isInteger(n)&&n>0&&n<=${RANKED_CAP}?n:${RANKED_DEFAULT_SHOWN};d.style.setProperty("--ranked-rows",String(Math.max(0,s-${PODIUM_SIZE})));if(q.get("view")!=="following")return;var c=0;try{var r=localStorage.getItem("poolsinfo.following.v1")||"[]";var a=r.length>20000?[]:JSON.parse(r);if(Array.isArray(a)){var u={};for(var i=0;i<a.length;i++)if(typeof a[i]==="string"&&/^0x[0-9a-f]{40}$/i.test(a[i]))u[a[i].toLowerCase()]=1;c=Math.min(Object.keys(u).length,${FOLLOWED_CAP});}}catch(e){}var f=Number(q.get("flimit"));var fs=Number.isInteger(f)&&f>0&&f<=${FOLLOWED_CAP}?f:${FOLLOWED_DEFAULT_SHOWN};d.setAttribute("data-ranked-view","following");if(!c)d.setAttribute("data-following-empty","");d.style.setProperty("--following-rows",String(Math.min(fs,c)));}catch(e){}})();`;
