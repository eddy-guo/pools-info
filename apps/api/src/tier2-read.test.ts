import assert from "node:assert/strict";
import test from "node:test";
import type { AnalyticsCoverage } from "@pools/core";
import { readTier2 } from "./tier2-read";

// The ledger stream must arrive grouped by book, then initiator, in byte
// order. The reader verifies that order itself so an unexpected plan can
// never blend two ledgers of one initiator into a wrong position.
const poolA = "0x" + "1".repeat(64),
  poolB = "0x" + "2".repeat(64),
  walletA = "0x" + "a".repeat(40),
  walletB = "0x" + "b".repeat(40),
  hash = "0x" + "3".repeat(64);
const book = (poolId: string) => ({
  pool_id: poolId,
  start_block: "100",
  through_block: "200",
  asof: "600000",
  through_hash: hash,
  token: "0x" + "4".repeat(40),
  symbol: "S",
  launch_tx: hash,
  launch_block: "100",
  launched_at: "1000",
  unsupported_history: false,
});
const swap = (poolId: string, wallet: string, logIndex: number) => ({
  pool_id: poolId,
  tx_hash: "0x" + logIndex.toString(16).padStart(64, "0"),
  log_index: logIndex,
  block_number: "150",
  block_hash: hash,
  timestamp: "2000",
  wallet,
  side: "buy",
  eth_wei: "10",
  token_raw: "5",
  amount0: "-10",
  amount1: "5",
  valid: true,
  conflict: false,
});
async function fold(rows: ReturnType<typeof swap>[]) {
  const pending = [...rows];
  const query = async (sql: string) => {
    if (sql.includes("AS metadata FROM books"))
      return {
        rows: [
          {
            pools: 2,
            asof: "600000",
            cutoff_conflict: false,
            source_invalid: false,
            metadata: [book(poolA), book(poolB)],
          },
        ],
      };
    if (sql.startsWith("FETCH")) return { rows: pending.splice(0, 2048) };
    if (sql.startsWith("DECLARE") || sql.startsWith("CLOSE"))
      return { rows: [] };
    throw Error("Unexpected statement " + sql.slice(0, 40));
  };
  return readTier2(query, { asOf: 0 } as AnalyticsCoverage, "7d");
}

test("tier2 fold accepts the byte-ordered book stream and rejects any other sequence", async () => {
  const result = await fold([
    swap(poolA, walletA, 1),
    swap(poolA, walletA, 2),
    swap(poolA, walletB, 3),
    swap(poolB, walletA, 4),
  ]);
  assert.equal(result.pools, 2);
  assert.equal(result.summaries.get(walletA)?.tier2PositionCount, 2);
  assert.equal(result.summaries.get(walletA)?.tradeCount, 3);
  assert.equal(result.summaries.get(walletB)?.tier2PositionCount, 1);
  for (const rows of [
    // An initiator returning within its book.
    [swap(poolA, walletA, 1), swap(poolA, walletB, 2), swap(poolA, walletA, 3)],
    // A book returning after another book.
    [swap(poolA, walletA, 1), swap(poolB, walletA, 2), swap(poolA, walletB, 3)],
    // Descending initiators, which byte order never produces.
    [swap(poolA, walletB, 1), swap(poolA, walletA, 2)],
    // Descending books.
    [swap(poolB, walletA, 1), swap(poolA, walletA, 2)],
  ])
    await assert.rejects(fold(rows), { message: "Unordered initiator books" });
});
