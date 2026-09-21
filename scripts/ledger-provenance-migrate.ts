// Attended only. Deliberately does not load .env.local or run normal migrations.
// docs/TRANSFER-PROVENANCE.md owns the archive/restore and authorization gates.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  acquireLedgerWriter,
  createClient,
  migrateLedgerTransferProvenance,
} from "../packages/db/src/index";

async function main() {
  const manifestPath = process.argv[2];
  if (process.argv.length !== 3 || !manifestPath || !isAbsolute(manifestPath))
    throw Error("ledger_provenance_manifest_required");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    typeof manifest.archive !== "string" ||
    !isAbsolute(manifest.archive) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    manifest.restoreVerified !== true ||
    typeof manifest.cursor?.block !== "string" ||
    !/^[0-9]+$/.test(manifest.cursor.block) ||
    typeof manifest.cursor?.hash !== "string" ||
    !/^0x[a-f0-9]{64}$/.test(manifest.cursor.hash)
  )
    throw Error("ledger_provenance_manifest_invalid");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(manifest.archive))
    hash.update(bytes);
  if (hash.digest("hex") !== manifest.sha256)
    throw Error("ledger_provenance_archive_hash_mismatch");
  const db = createClient(undefined, {
    statementTimeoutMs: 60000,
    applicationName: "pools-attended-transfer-provenance",
  });
  await db.connect();
  try {
    if (!(await acquireLedgerWriter(db)))
      throw Error("ledger_provenance_writer_busy");
    const applied = await migrateLedgerTransferProvenance(
      db,
      manifest.sha256,
      manifest.cursor,
    );
    console.log(
      JSON.stringify({
        event: "ledger_transfer_provenance_migration",
        applied,
        archiveSha256: manifest.sha256,
        cursor: manifest.cursor,
      }),
    );
  } finally {
    await db.end(); // Releases only this connection's lock.
  }
}
main().catch((error: unknown) => {
  // Connection strings and raw driver errors must never reach the console.
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^ledger_provenance_[a-z_]+$/.test(message)
      ? message
      : "ledger_provenance_migration_failed",
  );
  process.exitCode = 1;
});
