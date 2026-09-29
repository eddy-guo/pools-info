import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSearchRanks,
  type RankedSearchResponse,
} from "./search-response";

const address = "0x1212121212121212121212121212121212121212";
const entry = {
  id: `wallet:${address}`,
  group: "Wallets" as const,
  title: "Wallet",
  context: "Saved wallet",
  address,
  terms: [address],
  href: `/wallet/${address}/`,
};
const response = {
  entries: [entry],
  total: 1,
  kind: "address" as const,
  coverage: { scope: "indexed" as const, pools: 1, fromBlock: 1, toBlock: 100 },
};

test("search keeps a valid optional trader rank", () => {
  const rank = { rank: 12, window: "7d", metric: "realized", asOf: 1790000000 };
  const result = sanitizeSearchRanks({
    ...response,
    entries: [{ ...entry, traderRank: rank }],
  } as RankedSearchResponse);
  assert.deepEqual(result.entries[0].traderRank, rank);
});

test("search accepts an entry without trader rank", () => {
  const result = sanitizeSearchRanks(response);
  assert.deepEqual(result.entries, [entry]);
});

test("search drops malformed or non-wallet ranks without dropping entries", () => {
  const malformed = [
    { rank: 0, window: "7d", metric: "realized", asOf: 1790000000 },
    { rank: 1.5, window: "7d", metric: "realized", asOf: 1790000000 },
    { rank: 12, window: "30d", metric: "realized", asOf: 1790000000 },
    { rank: 12, window: "7d", metric: "volume", asOf: 1790000000 },
    { rank: 12, window: "7d", metric: "realized", asOf: "now" },
    null,
  ];
  for (const rank of malformed) {
    const result = sanitizeSearchRanks({
      ...response,
      entries: [{ ...entry, traderRank: rank }],
    } as RankedSearchResponse);
    assert.deepEqual(result.entries, [entry]);
    assert.equal(result.total, 1);
  }
  const result = sanitizeSearchRanks({
    ...response,
    entries: [
      {
        ...entry,
        group: "Creators",
        traderRank: {
          rank: 12,
          window: "7d",
          metric: "realized",
          asOf: 1790000000,
        },
      },
    ],
  } as RankedSearchResponse);
  assert.equal(result.entries[0].traderRank, undefined);
});
