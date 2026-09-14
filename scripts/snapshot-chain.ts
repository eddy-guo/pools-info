import { mkdir, rename, writeFile } from "node:fs/promises";
import { collectSnapshot, Rpc } from "@pools/chain";
async function main() {
  const { snapshot, evidence } = await collectSnapshot({
    span: Number(process.env.CHAIN_BLOCK_SPAN ?? 100000),
    poolLimit: Number(process.env.CHAIN_POOL_LIMIT ?? 8),
    onProgress: console.log,
    includeAccounting: process.env.CHAIN_INCLUDE_ACCOUNTING === "1",
    rpc: new Rpc(undefined, { timeoutMs: 180000, maxRequests: 10000 }),
  });
  await mkdir(".data/chain", { recursive: true });
  await writeFile(
    `.data/chain/${snapshot.toBlock}.json`,
    JSON.stringify(evidence),
  );
  await writeFile(
    "data/snapshots/chain.json.tmp",
    JSON.stringify(snapshot, null, 2) + "\n",
  );
  await rename("data/snapshots/chain.json.tmp", "data/snapshots/chain.json");
  console.log(
    JSON.stringify({
      pools: snapshot.markets.length,
      swaps: snapshot.trades.length,
      requests: snapshot.requests,
      seconds: Math.round(snapshot.durationMs / 1000),
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Snapshot failed");
  process.exitCode = 1;
});
