import { readFile } from "node:fs/promises";
import {
  acquireLedgerWriter,
  createClient,
  registerLedgerTransferCounterparties,
  releaseLedgerWriter,
} from "../packages/db/src/index";

async function main() {
  const path = process.argv[2];
  if (!path) throw Error("ledger_counterparty_manifest_required");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw Error("DATABASE_URL is required");

  const bytes = await readFile(path);
  const db = createClient(databaseUrl, {
    applicationName: "pools-ledger-counterparty-register",
  });
  await db.connect();
  let locked = false;
  try {
    locked = await acquireLedgerWriter(db);
    if (!locked) throw Error("ledger_counterparty_writer_busy");
    const result = await registerLedgerTransferCounterparties(db, bytes);
    process.stdout.write(
      JSON.stringify({ event: "registered", ...result }) + "\n",
    );
  } finally {
    if (locked) await releaseLedgerWriter(db);
    await db.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^ledger_counterparty_[a-z_]+$/.test(message)
      ? message
      : "ledger_counterparty_registration_failed",
  );
  process.exitCode = 1;
});
