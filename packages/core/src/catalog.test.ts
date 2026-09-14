import test from "node:test";
import assert from "node:assert/strict";
import { mergeCatalog, type ChainCatalog, type CatalogPool } from "./catalog";
const pool = (id: string, launchBlock: number): CatalogPool => ({
  id,
  launchBlock,
  token: "0x1",
  name: id,
  symbol: id,
  launchTx: "0x2",
  launchSender: "0x3",
  launchedAt: 1,
});
const base: ChainCatalog = {
  schemaVersion: 1,
  chainId: 4663,
  generatedAt: "2026-09-14",
  toBlock: 100,
  blockHash: "0x1",
  ranges: [{ fromBlock: 1, toBlock: 100 }],
  pools: [pool("old", 10), pool("changed", 90)],
};
test("catalog replay replaces overlap instead of retaining disappeared launches", () => {
  const merged = mergeCatalog(base, {
    ...base,
    fromBlock: 80,
    toBlock: 200,
    pools: [pool("new", 190)],
  });
  assert.deepEqual(
    merged.pools.map((p) => p.id),
    ["new", "old"],
  );
  assert.deepEqual(merged.ranges, [{ fromBlock: 1, toBlock: 200 }]);
});
test("catalog keeps scan gaps explicit and rejects a backwards checkpoint", () => {
  const merged = mergeCatalog(base, {
    ...base,
    fromBlock: 150,
    toBlock: 200,
    pools: [],
  });
  assert.equal(merged.ranges.length, 2);
  assert.throws(
    () => mergeCatalog(base, { ...base, fromBlock: 1, toBlock: 99 }),
    /backwards/,
  );
});
