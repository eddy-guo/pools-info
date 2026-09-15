export const MAX_SHARED_POOLS = 50;
export const MAX_WATCHLIST_QUERY_POOLS = 200;
export const MAX_WATCHLIST_URL_LENGTH = 4096;
const poolId = /^0x[0-9a-f]{64}$/i;

export function normalizePoolIds(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        typeof value === "string" && poolId.test(value.trim())
          ? [value.trim().toLowerCase()]
          : [],
      ),
    ),
  ];
}

export function parseSavedWatchlist(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? normalizePoolIds(parsed) : [];
  } catch {
    return [];
  }
}

export type SharedWatchlist = { ids: string[]; error: string | null };
export function parseSharedWatchlist(
  params: URLSearchParams,
): SharedWatchlist | null {
  if (!params.has("watchlist")) return null;
  const values = params.getAll("watchlist");
  const raw = values[0];
  if (values.length !== 1)
    return {
      ids: [],
      error: "This link contains more than one watchlist. Ask for a new link.",
    };
  if (!raw.trim()) return { ids: [], error: "This shared watchlist is empty." };
  if (
    raw.length > MAX_SHARED_POOLS * 67 ||
    raw.split(",").length > MAX_SHARED_POOLS
  )
    return {
      ids: [],
      error: `Shared links support up to ${MAX_SHARED_POOLS} pools. Ask for a smaller list.`,
    };
  if (raw.split(",").some((id) => !poolId.test(id.trim())))
    return {
      ids: [],
      error:
        "This shared watchlist contains an invalid pool ID. Ask for a new link.",
    };
  return { ids: normalizePoolIds(raw.split(",")), error: null };
}

export function watchlistShareUrl(
  href: string,
  ids: readonly string[],
): string {
  const normalized = normalizePoolIds(ids);
  if (!normalized.length) throw Error("Star at least one pool before sharing.");
  if (normalized.length > MAX_SHARED_POOLS)
    throw Error(`Shared links support up to ${MAX_SHARED_POOLS} pools.`);
  const current = new URL(href);
  const shared = new URL("/", current.origin);
  for (const key of ["window", "sort", "dir", "q"])
    if (current.searchParams.has(key))
      shared.searchParams.set(key, current.searchParams.get(key)!);
  shared.searchParams.set("view", "watchlist");
  shared.searchParams.set("watchlist", normalized.join(","));
  if (shared.href.length > MAX_WATCHLIST_URL_LENGTH)
    throw Error(
      "This link is too long. Shorten the filter or share fewer pools.",
    );
  return shared.href;
}
