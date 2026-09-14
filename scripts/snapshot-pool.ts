import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { collectSnapshot, Rpc } from "@pools/chain";
type Snapshot = Awaited<ReturnType<typeof collectSnapshot>>["snapshot"];
async function main() {
  const catalog = JSON.parse(await readFile("data/catalog/chain.json", "utf8"));
  const id = process.argv[2]?.toLowerCase();
  const pool = catalog.pools.find(
    (p: { id: string; token: string }) =>
      p.id.toLowerCase() === id || p.token.toLowerCase() === id,
  );
  if (!pool)
    throw Error("Pass a pool ID or token address from the verified catalog");
  let existing: { schemaVersion: 1; snapshots: Record<string, Snapshot> } = {
    schemaVersion: 1,
    snapshots: {},
  };
  try {
    existing = JSON.parse(await readFile("data/pools/index.json", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const includeAccounting = process.env.POOL_INCLUDE_ACCOUNTING === "1";
  if (existing.snapshots[pool.id]?.markets[0]?.accounting && !includeAccounting)
    throw Error(
      "This capture includes an audit. Use POOL_INCLUDE_ACCOUNTING=1 to preserve audited wallet data when replacing it.",
    );
  const { snapshot, evidence } = await collectSnapshot({
    target: { poolId: pool.id, launchTx: pool.launchTx },
    poolLimit: 1,
    includeAccounting,
    rpc: new Rpc(undefined, {
      timeoutMs: 300000,
      maxRequests: 25000,
      minIntervalMs: 300,
    }),
    onProgress: console.log,
  });
  existing.snapshots[pool.id] = snapshot;
  const content = JSON.stringify(existing, null, 2) + "\n";
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw Error(
      "Partition captured pool data before exceeding the 8MB bundle budget",
    );
  await mkdir("data/pools", { recursive: true });
  await mkdir(".data/pools", { recursive: true });
  await writeFile(
    `.data/pools/${pool.id}-${snapshot.toBlock}.json`,
    JSON.stringify(evidence),
  );
  await writeFile("data/pools/index.json.tmp", content);
  await rename("data/pools/index.json.tmp", "data/pools/index.json");
  console.log(
    JSON.stringify({
      pool: pool.symbol,
      swaps: snapshot.trades.length,
      wallets: snapshot.markets[0].accounting?.wallets.length,
      requests: snapshot.requests,
      seconds: snapshot.durationMs / 1000,
      bytes: Buffer.byteLength(content),
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Pool capture failed");
  process.exitCode = 1;
});
