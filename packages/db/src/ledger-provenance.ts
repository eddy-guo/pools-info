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

const provenanceMigrations = [
  {
    name: "attended/001_transfer_provenance.sql",
    file: "../attended-migrations/001_transfer_provenance.sql",
  },
  {
    name: "attended/002_transfer_counterparty_registry.sql",
    file: "../attended-migrations/002_transfer_counterparty_registry.sql",
  },
] as const;
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

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const evidenceKinds = new Set([
  "protocol_registry",
  "verified_contract_source",
  "signed_protocol_statement",
]);
export interface LedgerCounterpartyEvidence {
  address: string;
  class: "wrapper" | "farm";
  label: string;
  validFromBlock: number;
  validThroughBlock: number | null;
  evidence: {
    kind:
      | "protocol_registry"
      | "verified_contract_source"
      | "signed_protocol_statement";
    authority: string;
    source: string;
    sha256: string;
  };
}
export interface LedgerCounterpartyManifest {
  version: 1;
  chainId: 4663;
  entries: LedgerCounterpartyEvidence[];
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("ledger_counterparty_manifest_invalid");
  return value as Record<string, unknown>;
};
const bounded = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value);

/** Parse the exact operator-supplied evidence manifest. The manifest names an
 * authority and a content hash for every source. It never derives a class from
 * transfer direction, activity, metadata or an address label. */
export function parseLedgerCounterpartyManifest(
  bytes: string | Uint8Array,
): LedgerCounterpartyManifest & { sha256: string } {
  const raw = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw Error("ledger_counterparty_manifest_invalid");
  }
  const manifest = record(decoded);
  if (
    !exactKeys(manifest, ["version", "chainId", "entries"]) ||
    manifest.version !== 1 ||
    manifest.chainId !== 4663 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.length > 1000
  )
    throw Error("ledger_counterparty_manifest_invalid");
  const reserved = new Set(ledgerTransferProtocols.map((r) => r.address));
  const seen = new Set<string>();
  const entries = manifest.entries.map((item): LedgerCounterpartyEvidence => {
    const entry = record(item),
      evidence = record(entry.evidence);
    const address =
      typeof entry.address === "string" ? entry.address.toLowerCase() : "";
    if (
      !exactKeys(entry, [
        "address",
        "class",
        "label",
        "validFromBlock",
        "validThroughBlock",
        "evidence",
      ]) ||
      !exactKeys(evidence, ["kind", "authority", "source", "sha256"]) ||
      !addressPattern.test(address) ||
      address === "0x" + "0".repeat(40) ||
      reserved.has(address) ||
      seen.has(address) ||
      (entry.class !== "wrapper" && entry.class !== "farm") ||
      !bounded(entry.label, 200) ||
      !Number.isSafeInteger(entry.validFromBlock) ||
      Number(entry.validFromBlock) < 0 ||
      !(
        entry.validThroughBlock === null ||
        (Number.isSafeInteger(entry.validThroughBlock) &&
          Number(entry.validThroughBlock) >= Number(entry.validFromBlock))
      ) ||
      typeof evidence.kind !== "string" ||
      !evidenceKinds.has(evidence.kind) ||
      !bounded(evidence.authority, 200) ||
      !bounded(evidence.source, 2000) ||
      typeof evidence.sha256 !== "string" ||
      !shaPattern.test(evidence.sha256)
    )
      throw Error("ledger_counterparty_manifest_invalid");
    seen.add(address);
    return {
      address,
      class: entry.class,
      label: entry.label as string,
      validFromBlock: Number(entry.validFromBlock),
      validThroughBlock:
        entry.validThroughBlock === null
          ? null
          : Number(entry.validThroughBlock),
      evidence: {
        kind: evidence.kind as LedgerCounterpartyEvidence["evidence"]["kind"],
        authority: evidence.authority as string,
        source: evidence.source as string,
        sha256: evidence.sha256,
      },
    };
  });
  return {
    version: 1,
    chainId: 4663,
    entries,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

/** Append an attended positive-evidence manifest while holding the ledger
 * writer lock. Existing assertions are immutable: an exact replay is a no-op
 * and any different assertion for a known address is refused. */
export async function registerLedgerTransferCounterparties(
  db: Client,
  bytes: string | Uint8Array,
) {
  const manifest = parseLedgerCounterpartyManifest(bytes);
  await db.query("BEGIN");
  try {
    await assertLedgerWriter(db);
    const ready = await db.query(
      "SELECT to_regclass('agg_transfer_counterparty_registry') IS NOT NULL AS enabled",
    );
    if (!ready.rows[0].enabled)
      throw Error("ledger_counterparty_registry_not_active");
    await db.query(
      "LOCK TABLE agg_transfer_counterparty_registry IN SHARE ROW EXCLUSIVE MODE",
    );
    const addresses = manifest.entries.map((e) => e.address.slice(2));
    const prior = await db.query(
      `SELECT encode(address,'hex') AS address,class,label,valid_from_block::text,valid_through_block::text,
        evidence_kind,evidence_authority,evidence_source,evidence_sha256,manifest_sha256
       FROM agg_transfer_counterparty_registry
       WHERE chain_id=4663 AND address=ANY(ARRAY(SELECT decode(a,'hex') FROM unnest($1::text[]) a))`,
      [addresses],
    );
    const expected = new Map(
      manifest.entries.map((entry) => [
        entry.address.slice(2),
        {
          address: entry.address.slice(2),
          class: entry.class,
          label: entry.label,
          valid_from_block: String(entry.validFromBlock),
          valid_through_block:
            entry.validThroughBlock === null
              ? null
              : String(entry.validThroughBlock),
          evidence_kind: entry.evidence.kind,
          evidence_authority: entry.evidence.authority,
          evidence_source: entry.evidence.source,
          evidence_sha256: entry.evidence.sha256,
          manifest_sha256: manifest.sha256,
        },
      ]),
    );
    for (const row of prior.rows) {
      const match = expected.get(row.address);
      if (!match || JSON.stringify(row) !== JSON.stringify(match))
        throw Error("ledger_counterparty_registry_conflict");
      expected.delete(row.address);
    }
    const fresh = manifest.entries.filter((e) =>
      expected.has(e.address.slice(2)),
    );
    if (fresh.length)
      await db.query(
        `INSERT INTO agg_transfer_counterparty_registry
          (chain_id,address,class,label,valid_from_block,valid_through_block,evidence_kind,evidence_authority,evidence_source,evidence_sha256,manifest_sha256)
         SELECT 4663,decode(r.address,'hex'),r.class,r.label,r.valid_from_block,r.valid_through_block,
           r.evidence_kind,r.evidence_authority,r.evidence_source,r.evidence_sha256,$2
         FROM jsonb_to_recordset($1::jsonb) AS r(address text,class text,label text,valid_from_block bigint,
           valid_through_block bigint,evidence_kind text,evidence_authority text,evidence_source text,evidence_sha256 text)`,
        [
          JSON.stringify(
            fresh.map((entry) => ({
              address: entry.address.slice(2),
              class: entry.class,
              label: entry.label,
              valid_from_block: entry.validFromBlock,
              valid_through_block: entry.validThroughBlock,
              evidence_kind: entry.evidence.kind,
              evidence_authority: entry.evidence.authority,
              evidence_source: entry.evidence.source,
              evidence_sha256: entry.evidence.sha256,
            })),
          ),
          manifest.sha256,
        ],
      );
    await db.query("COMMIT");
    return { inserted: fresh.length, manifestSha256: manifest.sha256 };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function transferProtocols(
  db: Client,
  registryEnabled: boolean,
): Promise<readonly TransferProtocolRole[]> {
  if (!registryEnabled) return ledgerTransferProtocols;
  const rows = (
    await db.query(
      `SELECT '0x'||encode(address,'hex') AS address,class,valid_from_block::text,valid_through_block::text,
        evidence_kind,evidence_authority,evidence_source,evidence_sha256,manifest_sha256
       FROM agg_transfer_counterparty_registry WHERE chain_id=4663 ORDER BY address`,
    )
  ).rows;
  return [
    ...ledgerTransferProtocols,
    ...rows.map((row): TransferProtocolRole => ({
      address: row.address,
      class: row.class,
      fromBlock: Number(row.valid_from_block),
      throughBlock:
        row.valid_through_block === null
          ? null
          : Number(row.valid_through_block),
      evidence: `counterparty-registry:v1:${row.evidence_kind}:${row.manifest_sha256}:${row.evidence_sha256}`,
    })),
  ];
}

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
  const migrations = await Promise.all(
    provenanceMigrations.map(async ({ name, file }) => {
      const sql = await readFile(new URL(file, import.meta.url), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  await db.query("BEGIN");
  try {
    await assertLedgerWriter(db);
    await db.query("SELECT pg_advisory_xact_lock(4663,19001)");
    const priorRows = await db.query(
      "SELECT name,checksum FROM pools_schema_migrations WHERE name=ANY($1::text[])",
      [migrations.map(({ name }) => name)],
    );
    const prior = new Map(
      priorRows.rows.map((row) => [row.name as string, row.checksum as string]),
    );
    for (const migration of migrations) {
      const checksum = prior.get(migration.name);
      if (checksum !== undefined && checksum !== migration.checksum)
        throw Error("ledger_provenance_migration_changed");
    }
    const pending = migrations.filter(({ name }) => !prior.has(name));
    if (!pending.length) {
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
    for (const migration of pending) {
      await db.query(migration.sql);
      if (migration.name === provenanceMigrations[0].name) {
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
      }
      await db.query(
        "INSERT INTO pools_schema_migrations(name,checksum) VALUES ($1,$2)",
        [migration.name, migration.checksum],
      );
    }
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
    `SELECT to_regclass('agg_transfer_provenance') IS NOT NULL AS enabled,
      to_regclass('agg_transfer_counterparty_registry') IS NOT NULL AS registry_enabled`,
  );
  if (!ready.rows[0].enabled) return;
  const registryEnabled = ready.rows[0].registry_enabled;
  const observed = ledgerTransferProvenance(
    rows,
    events,
    await transferProtocols(db, registryEnabled),
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
      SELECT 4663,$2,$3,r.pool_ref,decode(r.tx_hash,'hex'),r.log_index,r.block_number,decode(r.block_hash,'hex'),r.timestamp,decode(r.from_address,'hex'),decode(r.to_address,'hex'),r.token_raw,r.context,$4,r.from_class,r.from_evidence,r.to_class,r.to_evidence
      FROM jsonb_to_recordset($1::jsonb) AS r(pool_ref int,tx_hash text,log_index int,block_number bigint,block_hash text,timestamp bigint,from_address text,to_address text,token_raw numeric,context text,from_class text,from_evidence text,to_class text,to_evidence text)`,
      [
        JSON.stringify(records),
        ledgerStream.key,
        batchEnd,
        registryEnabled ? 2 : 1,
      ],
    );
  }
  await db.query(
    "UPDATE agg_batches SET transfer_provenance_rows=$3 WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2",
    [ledgerStream.key, batchEnd, observed.length],
  );
}
