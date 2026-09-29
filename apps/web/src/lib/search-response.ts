import type { SearchEntry, SearchResponse } from "@pools/core";

export type TraderRank = {
  rank: number;
  window: "7d";
  metric: "realized";
  asOf: number;
};

export type RankedSearchEntry = SearchEntry & { traderRank?: TraderRank };
export type RankedSearchResponse = Omit<SearchResponse, "entries"> & {
  entries: RankedSearchEntry[];
};

function validTraderRank(value: unknown): value is TraderRank {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rank = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(rank.rank) &&
    (rank.rank as number) > 0 &&
    rank.window === "7d" &&
    rank.metric === "realized" &&
    Number.isSafeInteger(rank.asOf) &&
    (rank.asOf as number) > 0
  );
}

/** Keep a valid search answer usable when an optional rank is malformed. */
export function sanitizeSearchRanks(
  response: RankedSearchResponse,
): RankedSearchResponse {
  return {
    ...response,
    entries: response.entries.map((entry) => {
      const { traderRank, ...rest } = entry;
      return entry.group === "Wallets" && validTraderRank(traderRank)
        ? { ...rest, traderRank }
        : rest;
    }),
  };
}
