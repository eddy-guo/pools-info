import {
  readFile,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  instantRegistryRevision,
  instantRegistrySourceRevision,
  type LaunchCandidate,
} from "@pools/chain";

const directory = ".data/bootstrap";
const lock = `${directory}/batch.lock`;

// Resume evidence collection only. Saved snapshots still require canonical
// revalidation before database import; skipping them is not a freshness claim.
async function saved(candidate: LaunchCandidate) {
  try {
    const proof = JSON.parse(
      await readFile(`${directory}/${candidate.poolId}.json`, "utf8"),
    );
    return (
      proof.schemaVersion === 1 &&
      proof.kind === "verified_instant_candidate" &&
      proof.registryRevision === instantRegistryRevision &&
      proof.registrySourceRevision === instantRegistrySourceRevision &&
      proof.candidate?.chainId === 4663 &&
      proof.candidate?.launchpadId === candidate.launchpadId &&
      proof.pool?.id?.toLowerCase() === candidate.poolId &&
      proof.pool?.token?.toLowerCase() === candidate.token.toLowerCase() &&
      proof.pool?.launchSender?.toLowerCase() ===
        candidate.creator.toLowerCase() &&
      proof.pool?.launchedAt === Date.parse(candidate.createdAt) / 1000 &&
      Array.isArray(proof.evidence?.logs) &&
      proof.evidence.logs.length > 0 &&
      Array.isArray(proof.evidence?.receipts) &&
      proof.evidence.receipts.length > 0 &&
      Array.isArray(proof.evidence?.headers) &&
      proof.evidence.headers.length > 0
    );
  } catch (e) {
    if (
      e instanceof SyntaxError ||
      (e as NodeJS.ErrnoException).code === "ENOENT"
    )
      return false;
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const plan = args[0] === "--plan";
  const limit = Number(args[1]);
  if (
    args.length !== 2 ||
    !["--plan", "--limit"].includes(args[0]) ||
    !/^[1-5]$/.test(args[1])
  )
    throw Error("usage");
  const source = JSON.parse(
    await readFile(
      "data/registry/pools-launch-candidates-2026-09-15.json",
      "utf8",
    ),
  ) as { chainId: number; candidates: Omit<LaunchCandidate, "chainId">[] };
  if (source.chainId !== 4663 || !Array.isArray(source.candidates))
    throw Error("Invalid candidate source");
  const candidates: LaunchCandidate[] = [];
  const seen = new Set<string>();
  for (const hint of source.candidates) {
    if (hint.launchpadId !== "uniswap-bonding-curve") continue;
    if (!/^0x[\da-f]{64}$/.test(hint.poolId) || seen.has(hint.poolId))
      throw Error("Invalid or duplicate candidate ID");
    seen.add(hint.poolId);
    candidates.push({ ...hint, chainId: 4663 });
  }
  await mkdir(directory, { recursive: true });
  let owned = false;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (!plan) {
      if (!process.env.ROBINHOOD_RPC_URL)
        throw Error("RPC configuration missing");
      try {
        const handle = await open(lock, "wx", 0o600);
        owned = true;
        try {
          await handle.writeFile(String(process.pid));
        } finally {
          await handle.close();
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw Error(
            "Batch lock exists; check its PID before removing a stale lock",
          );
        throw e;
      }
    }
    const selected: LaunchCandidate[] = [];
    let skipped = 0;
    for (const candidate of candidates) {
      if (controller.signal.aborted) throw Error("Batch interrupted");
      if (await saved(candidate)) skipped++;
      else if (selected.length < limit) selected.push(candidate);
    }
    console.log(
      JSON.stringify({
        plan,
        savedSnapshots: skipped,
        selected: selected.map((c) => c.poolId),
        importedIntoDatabase: false,
      }),
    );
    if (plan) return;
    for (const candidate of selected) {
      if (controller.signal.aborted) throw Error("Batch interrupted");
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/verify-launch-candidate.ts",
            candidate.poolId,
          ],
          {
            stdio: "inherit",
            signal: controller.signal,
          },
        );
        // Wait for child exit before releasing the batch lock on interruption.
        child.once("error", (e) => {
          if (e.name !== "AbortError") reject(e);
        });
        child.once("close", resolve);
      });
      if (controller.signal.aborted) throw Error("Batch interrupted");
      if (exitCode !== 0) {
        const file = `${directory}/${candidate.poolId}.failed.json`;
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({
            poolId: candidate.poolId,
            failedAt: new Date().toISOString(),
            exitCode,
            reason: "verification_failed",
            retryableByRerunning: true,
          }) + "\n",
          { mode: 0o600 },
        );
        await rename(temporary, file);
        throw Error(
          "Verification failed; batch stopped to limit provider usage",
        );
      }
      await unlink(`${directory}/${candidate.poolId}.failed.json`).catch(
        (e) => {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        },
      );
    }
  } finally {
    try {
      if (owned) await unlink(lock);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}
main().catch((e: unknown) => {
  // Never surface arbitrary filesystem/provider errors or environment values.
  const message = e instanceof Error ? e.message : "";
  const safe = [
    "RPC configuration missing",
    "Batch interrupted",
    "Batch lock exists; check its PID before removing a stale lock",
    "Verification failed; batch stopped to limit provider usage",
  ];
  console.error(
    message === "usage"
      ? "Usage: node --env-file-if-exists=.env.local --import tsx scripts/verify-launch-candidates.ts --plan <1-5> | --limit <1-5>"
      : safe.includes(message)
        ? message
        : "Candidate batch failed; no database changes made.",
  );
  process.exitCode = 1;
});
