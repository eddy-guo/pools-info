import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  contracts,
  instantDeployments,
  instantRegistryRevision,
  instantRegistryVerifiedAtBlock,
} from "@pools/chain";
import {
  ledgerTransferProvenance,
  type LedgerBatchRows,
  type LedgerEvent,
  type TransferProtocolRole,
} from "@pools/core";
import type { Client } from "./index";
import { assertLedgerWriter, ledgerStream } from "./ledger";

const migrationName = "attended/001_transfer_provenance.sql";
/** Classification v1 is evidence-backed and deliberately incomplete. A tx.to
 * different from the router is not evidence that the address is a wrapper. */
export const ledgerTransferProtocols: readonly TransferProtocolRole[] = [
  {
    address: contracts.manager,
    class: "protocol",
    evidence: `${instantRegistryRevision}:poolManager`,
    fromBlock: instantRegistryVerifiedAtBlock,
  },
  {
    address: contracts.router,
    class: "wrapper_or_router",
    evidence:
      "chain/events.ts:router;omitted-launch-proof:0x121c365bee9cd93759b732dd8be0de3be68c30a04193642ea081ebc8001dd43b",
    fromBlock: instantRegistryVerifiedAtBlock,
  },
  ...instantDeployments.flatMap((d): TransferProtocolRole[] => [
    {
      address: d.launcher,
      class: "launcher",
      evidence: `${instantRegistryRevision}:${d.strategy}:launcher`,
      fromBlock: d.deployedAtBlock,
    },
    {
      address: d.strategy,
      class: "protocol",
      evidence: `${instantRegistryRevision}:${d.strategy}:strategy`,
      fromBlock: d.deployedAtBlock,
    },
    {
      address: d.feeSplitter,
      class: "protocol",
      evidence: `${instantRegistryRevision}:${d.strategy}:feeSplitter`,
      fromBlock: d.deployedAtBlock,
    },
  ]),
];

/** Explicit attended activation. Caller holds the ledger writer lock and has
 * verified a restorable before-state archive; its SHA-256 is recorded with the
 * exact cursor. Never called by migrate(), the pass, or the tip service. */
export async function migrateLedgerTransferProvenance(
  db: Client,
  archiveSha256: string,
  archivedCursor: { block: string; hash: string } | null,
) {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256))
    throw Error("ledger_provenance_archive_required");
  const sql = await readFile(
    new URL(
      "../attended-migrations/001_transfer_provenance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const checksum = createHash("sha256").update(sql).digest("hex");
  await db.query("BEGIN");
  try {
    await assertLedgerWriter(db);
    await db.query("SELECT pg_advisory_xact_lock(4663,19001)");
    const prior = await db.query(
      "SELECT checksum FROM pools_schema_migrations WHERE name=$1",
      [migrationName],
    );
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum)
        throw Error("ledger_provenance_migration_changed");
      await db.query("COMMIT");
      return false;
    }
    const cursor = await db.query(
      "SELECT cursor_block::text,encode(cursor_hash,'hex') AS cursor_hash FROM agg_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
      [ledgerStream.key],
    );
    const current =
      cursor.rows[0]?.cursor_block == null
        ? null
        : {
            block: cursor.rows[0].cursor_block as string,
            hash: "0x" + cursor.rows[0].cursor_hash,
          };
    if (
      current?.block !== archivedCursor?.block ||
      current?.hash !== archivedCursor?.hash
    )
      throw Error("ledger_provenance_archive_cursor_changed");
    await db.query(sql);
    const comment = await db.query(
      "SELECT format('COMMENT ON TABLE agg_transfer_provenance IS %L', $1::text) AS sql",
      [
        JSON.stringify({
          archiveSha256,
          classificationVersion: 1,
          cursor: current,
        }),
      ],
    );
    await db.query(comment.rows[0].sql);
    await db.query(
      "INSERT INTO pools_schema_migrations(name,checksum) VALUES ($1,$2)",
      [migrationName, checksum],
    );
    await db.query("COMMIT");
    return true;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Inside applyLedgerBatch's transaction and writer lock. An older schema
 * continues its old write path until attended activation. Reorg deletion
 * cascades from agg_batches; no financial journal pre-image changes. */
export async function writeLedgerTransferProvenance(
  db: Client,
  batchEnd: number,
  rows: LedgerBatchRows,
  events: readonly LedgerEvent[],
  pools: ReadonlyMap<string, number>,
) {
  const ready = await db.query(
    "SELECT to_regclass('agg_transfer_provenance') IS NOT NULL AS enabled",
  );
  if (!ready.rows[0].enabled) return;
  const observed = ledgerTransferProvenance(
    rows,
    events,
    ledgerTransferProtocols,
  );
  const hex = (s: string) => s.slice(2);
  for (let i = 0; i < observed.length; i += 1000) {
    const records = observed.slice(i, i + 1000).map((t) => ({
      pool_ref: pools.get(t.poolId)!,
      tx_hash: hex(t.txHash),
      log_index: t.logIndex,
      block_number: t.block,
      block_hash: hex(t.blockHash),
      timestamp: t.timestamp,
      from_address: hex(t.from),
      to_address: hex(t.to),
      token_raw: t.value,
      context: t.context,
      from_class: t.fromRole.class,
      from_evidence: t.fromRole.evidence,
      to_class: t.toRole.class,
      to_evidence: t.toRole.evidence,
    }));
    await db.query(
      `INSERT INTO agg_transfer_provenance
      (chain_id,stream_key,batch_end,pool_ref,tx_hash,log_index,block_number,block_hash,timestamp,from_address,to_address,token_raw,context,classification_version,from_class,from_evidence,to_class,to_evidence)
      SELECT 4663,$2,$3,r.pool_ref,decode(r.tx_hash,'hex'),r.log_index,r.block_number,decode(r.block_hash,'hex'),r.timestamp,decode(r.from_address,'hex'),decode(r.to_address,'hex'),r.token_raw,r.context,1,r.from_class,r.from_evidence,r.to_class,r.to_evidence
      FROM jsonb_to_recordset($1::jsonb) AS r(pool_ref int,tx_hash text,log_index int,block_number bigint,block_hash text,timestamp bigint,from_address text,to_address text,token_raw numeric,context text,from_class text,from_evidence text,to_class text,to_evidence text)`,
      [JSON.stringify(records), ledgerStream.key, batchEnd],
    );
  }
  await db.query(
    "UPDATE agg_batches SET transfer_provenance_rows=$3 WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
    [ledgerStream.key, batchEnd, observed.length],
  );
}
