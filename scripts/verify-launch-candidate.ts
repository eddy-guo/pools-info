import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { Rpc, verifyLaunchCandidate, type LaunchCandidate } from "@pools/chain";

// Explicit one-candidate command: bounded provider work, no database writes.
async function main() {
  const id = process.argv[2]?.toLowerCase();
  if (!id || !/^0x[\da-f]{64}$/.test(id) || process.argv.length !== 3)
    throw Error("usage");
  const source = JSON.parse(
    await readFile(
      "data/registry/pools-launch-candidates-2026-09-15.json",
      "utf8",
    ),
  ) as {
    chainId: number;
    candidates: Omit<LaunchCandidate, "chainId">[];
  };
  if (source.chainId !== 4663 || !Array.isArray(source.candidates))
    throw Error("invalid_source");
  const hint = source.candidates.find((p) => p.poolId === id);
  if (!hint || !process.env.ROBINHOOD_RPC_URL) throw Error("configuration");
  const rpc = new Rpc(process.env.ROBINHOOD_RPC_URL, {
    timeoutMs: 120000,
    maxRequests: 100,
    minIntervalMs: 1000,
    maxBatchSize: 1,
    logRangeBlocks: 10,
  });
  const proof = await verifyLaunchCandidate({ ...hint, chainId: 4663 }, rpc);
  const directory = ".data/bootstrap";
  await mkdir(directory, { recursive: true });
  const file = `${directory}/${id}.json`;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(proof, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, file);
  console.log(
    JSON.stringify(
      {
        verified: true,
        pool: proof.pool.id,
        token: proof.pool.token,
        launchBlock: proof.pool.launchBlock,
        launchTx: proof.pool.launchTx,
        requests: rpc.requests,
        evidenceFile: file,
        importedIntoDatabase: false,
      },
      null,
      2,
    ),
  );
}
main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : "";
  console.error(
    message === "usage"
      ? "Usage: node --env-file-if-exists=.env.local --import tsx scripts/verify-launch-candidate.ts <pool-id>"
      : "Candidate verification failed. Check the candidate, RPC configuration or provider availability. No database changes made.",
  );
  process.exitCode = 1;
});
