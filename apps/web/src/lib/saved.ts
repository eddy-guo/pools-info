import { parseSavedWatchlist } from "./watchlist";

/*
 * What this browser has saved for itself, read off the same localStorage
 * keys the stores own (`following.tsx`'s `useFollowing`, `state.tsx`'s
 * `useWatchlist`), for the header's You entry and the You page. Nothing here
 * is an account: the counts are this device's lists and nothing else.
 */

/** The follow list's key and the most wallets it holds (`useFollowing`). */
export const FOLLOWING_KEY = "poolsinfo.following.v1";
export const FOLLOWING_CAP = 200;
/** The watchlist's versioned key and the legacy one it still reads
    (`useWatchlist` in state.tsx). */
export const WATCHLIST_KEY = "poolsinfo.watchlist.v1";
export const LEGACY_WATCHLIST_KEY = "pools:watchlist";
/** The rows each You page section reserves and shows before Show more. */
export const YOU_PAGE_STEP = 25;

const walletAddress = /^0x[0-9a-f]{40}$/i;

/** The follow list a stored value names: valid addresses, lower-cased, in
    first-seen order without repeats, and never past the cap. Anything
    unreadable is an empty list, never an error. */
export function parseFollowing(raw: string | null): string[] {
  try {
    if (!raw || raw.length > 20000) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value
          .filter((a): a is string => typeof a === "string" && walletAddress.test(a))
          .map((a) => a.toLowerCase()),
      ),
    ].slice(0, FOLLOWING_CAP);
  } catch {
    return [];
  }
}

/** The stored watchlist text as `useWatchlist` reads it: the versioned key,
    else the legacy one, else nothing. */
export function savedWatchlistRaw(get: (key: string) => string | null) {
  return get(WATCHLIST_KEY) || get(LEGACY_WATCHLIST_KEY) || "";
}

/** Everything saved on this device that the You page lists: followed wallets
    and watched pools. The marked "my wallet" is an identity, not a saved
    item, so it never counts. */
export function savedCount(following: number, watchlist: number) {
  return following + watchlist;
}

/** The header badge's text: nothing at zero, the count to 99, then "99+",
    so the badge never needs more than three characters of box. */
export function savedBadge(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

/**
 * `/you/` is statically prerendered, so the served HTML cannot know this
 * browser's lists and paints as if nothing were saved; hydration then swaps
 * in the real lists. Everything under a list would move as it did, so this
 * runs before first paint, reads both keys the way the stores do, and sets
 * on `<html>` what `globals.css` needs to size each section's reserved rows
 * (`--you-following-rows`, `--you-watchlist-rows`, each capped at the rows
 * the section shows before Show more) and to show either the section's
 * empty state or its pending rows (`data-you-following`,
 * `data-you-watchlist`: "some" or "none"). It mirrors `parseFollowing` and
 * `parseSavedWatchlist` rather than importing them, because an inline
 * pre-paint script cannot import; `saved.test.ts` runs it against both.
 */
export const youPrepaintScript = `(function(){try{var d=document.documentElement;var g=function(k){try{return localStorage.getItem(k);}catch(e){return null;}};var f=[];try{var r=g(${JSON.stringify(FOLLOWING_KEY)});if(r===null)r="[]";if(r&&r.length<=20000){var v=JSON.parse(r);if(Array.isArray(v))for(var i=0;i<v.length;i++){var a=v[i];if(typeof a==="string"&&/^0x[0-9a-f]{40}$/i.test(a)){a=a.toLowerCase();if(f.indexOf(a)<0)f.push(a);}}}}catch(e){}f=f.slice(0,${FOLLOWING_CAP});var w=[];try{var s=g(${JSON.stringify(WATCHLIST_KEY)})||g(${JSON.stringify(LEGACY_WATCHLIST_KEY)})||"[]";var p=JSON.parse(s||"[]");if(Array.isArray(p))for(var j=0;j<p.length;j++){var b=p[j];if(typeof b==="string"&&/^0x[0-9a-f]{64}$/i.test(b.trim())){b=b.trim().toLowerCase();if(w.indexOf(b)<0)w.push(b);}}}catch(e){}d.style.setProperty("--you-following-rows",String(Math.min(f.length,${YOU_PAGE_STEP})));d.style.setProperty("--you-watchlist-rows",String(Math.min(w.length,${YOU_PAGE_STEP})));d.setAttribute("data-you-following",f.length?"some":"none");d.setAttribute("data-you-watchlist",w.length?"some":"none");}catch(e){}})();`;

/** The counts the pre-paint script would set for a storage, computed the
    stores' way; the test pins the script to this. */
export function savedCountsFromStorage(get: (key: string) => string | null) {
  return {
    following: parseFollowing(get(FOLLOWING_KEY) ?? "[]").length,
    watchlist: parseSavedWatchlist(savedWatchlistRaw(get)).length,
  };
}
