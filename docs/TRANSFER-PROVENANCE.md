# Transfer counterparties at the ledger fold

The code can merge before activation. **No production migration, archive,
backfill, collector run or deployment operation is performed by this change.**
Activation requires a later exact instruction, an attended window and a verified
production before-state archive. The stopped legacy indexer stays stopped.

## What is recorded

`ledgerTransferProvenance` in `packages/core/src/ledger-provenance.ts` annotates
the validated batch after the existing attribution plan. For each token and
transaction that has a residual inflow/outflow or an unattributed swap, it keeps
every observed Transfer leg, including pass-through, self and zero-value legs.
Fully explained swap transactions and transfer-only transactions with no net
position effect add no rows. The source batch's existing SHA-256 still covers
the exact original transfer addresses and amounts; its serializer is unchanged.

`agg_transfer_provenance` stores one row per `(chain_id, tx_hash, log_index)`:
pool, block/hash/time, from/to addresses, integer-exact **gross** token amount,
context, classification version and each endpoint's class/evidence. These are
observations, never an assertion that a particular gross leg supplied a net
residual. For example, a buy of 100 followed by incoming 30 and outgoing 10
leaves a 20-token inflow. Recording only the first source or labelling its
gross 100 as the residual would invent provenance. The complete graph avoids
that ambiguity. It does not establish beneficial ownership, an allocation,
a farm, tax treatment or a missing cost basis by itself.

Classification v1 in `packages/db/src/ledger-provenance.ts` uses only local,
recorded protocol evidence. Classification v2 adds the positive-evidence
counterparty registry described below:

| Class               | Evidence and meaning                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `mint_burn`         | ERC-20 zero-address endpoint, distinct from the token contract                                           |
| `token_contract`    | Endpoint equals the registered token that emitted the log                                                |
| `launcher`          | Launcher contract in the verified Instant deployment registry                                            |
| `wrapper_or_router` | The existing chain router binding; no arbitrary `tx.to` is promoted to a wrapper                         |
| `wrapper`           | An address explicitly registered from authoritative wrapper evidence                                     |
| `farm`              | An address explicitly registered from authoritative farm evidence                                        |
| `protocol`          | Verified PoolManager, Instant strategy or fee splitter                                                   |
| `unregistered`      | Address outside the evidence registries; may be a wallet, wrapper or farm. No financial class is guessed |

Registry roles cite `robinhood-instant-v2` and the strategy whose recorded
getters establish the address (`docs/DEPLOYMENT-REGISTRY.md` and
`data/registry/robinhood-instant-v2.json`), and begin no earlier than that
deployment. The manager/router bindings begin at the registry verification
block 63,243,824; earlier unknowns remain unknown. The router binding is the
one already used by the ledger, `contracts.router` in `packages/chain/src/events.ts`,
also present in the retained launch receipts under `data/registry/`. There is
no new chain or explorer lookup. Every row retains its raw `from_address` and
`to_address`; stored classes record the evidence available when the batch was
written, while the wallet read can match those raw addresses against later
positive registrations without rewriting financial history.

## Wrapper and farm evidence registry

`agg_transfer_counterparty_registry` is created by attended migration 002 after
attended migration 001 has retained raw provenance. It is empty at creation. No
wrapper or farm is seeded by this repository because it contains no
authoritative evidence for one. Absence is deterministic: the endpoint stays
`unregistered` and no API attribution flag appears.

Each registry row stores the exact address, `wrapper` or `farm`, a block-validity
range, label, evidence kind, authority, source locator, SHA-256 of the cited
source, and SHA-256 of the operator manifest. Accepted evidence kinds are an
authoritative protocol registry, verified contract source, or a signed protocol
statement. Transfer direction, sender or beneficiary identity, activity shape,
address labels, token metadata, and other behavioral heuristics are not accepted.
The table rejects updates and deletes. An exact manifest replay is a no-op and a
different assertion for an existing address is refused.

Registration is a separate attended production write and is not authorized by
merging this code. After independently archiving and verifying the cited source,
prepare a JSON manifest with this shape:

```json
{
  "version": 1,
  "chainId": 4663,
  "entries": [
    {
      "address": "0x0000000000000000000000000000000000000001",
      "class": "wrapper",
      "label": "Protocol wrapper",
      "validFromBlock": 123,
      "validThroughBlock": null,
      "evidence": {
        "kind": "protocol_registry",
        "authority": "Protocol name",
        "source": "https://protocol.example/registry.json",
        "sha256": "<64 lowercase hex characters>"
      }
    }
  ]
}
```

With the production connection supplied securely in `DATABASE_URL`, and only
after a separate exact approval and after the ledger writer has released its
lock, run:

```sh
pnpm ledger:counterparties:register /absolute/path/manifest.json
```

The command loads no `.env.local`, takes the ledger writer lock, validates and
hashes the manifest, inserts only new evidence, and prints the inserted count
and manifest hash. It performs no collection, replay, backfill, cursor change,
or financial update. One manifest should contain only new addresses; later
evidence for an already registered address requires a new reviewed model rather
than an overwrite.

## Write and compatibility boundary

The financial event plan, supported/excluded rules, basis, cross-window sums,
realized identity and public API response shapes are **unchanged**. The existing
wallet-position `flags` array may additionally contain `wrapper_counterparty`
or `farm_counterparty`; consumers already treat it as an open string list and
need no new response field. The local ingestion regression runs the same fake
HyperSync range through discovery,
collection, fold and database read both with and without activation and compares
the entire ledger. The pre-change regression retained an exact large inflow
and its exclusion but could not read its source address.

The writer tests table presence inside its existing locked transaction. Before
activation it continues the current write path. After activation, records and
`agg_batches.transfer_provenance_rows` commit atomically with positions, journal
and cursor. The count is NULL for unrecorded history or a batch from an old
binary, zero for a checked batch without selected legs. Replaying an old batch
does not backfill it. A schema migration cannot recover historical addresses
from aggregate positions; the hash alone cannot reconstruct dropped bytes.

Rows reference their batch with `ON DELETE CASCADE`, so walk-back removes only
the replaced branch's observations and replay writes the replacement. They are
append-only and need no financial journal pre-image rewrite. Exact replay is a
no-op; changing a source address still conflicts with the original content hash.
No cursor is reset, including `discovery:v1`.

This adds retained rows for unexplained transactions, not all swap transfers.
There is no TTL, silent row cap, new service or object store. Storage grows with
those observations and their three secondary indexes. Before production
activation, measure representative local retained ranges and available capacity;
record selected transfer rows per day and `pg_total_relation_size` per row,
including dense multi-leg transactions. Bound forecast growth against the
available storage and operational horizon, with WAL/backup margin. The tip's
existing capacity exit is not a disk-space monitor; this change adds no monitor.
If capacity is insufficient, return the measured decision to firstmate; do not
silently discard provenance, purchase storage or run a production sample scan.

## Attended archive and migration runbook

Do not execute these steps against production under the implementation task.
The exact later instruction must authorize the archive, the tip service's
attended pause/resume and the migration separately from the guarded code merge.

1. Record the reviewed commit and confirm the schema is through the ordinary
   migrations. Rehearse on a disposable copy of the current local backup using
   PostgreSQL 18, plus the integration suite on PostgreSQL 17. Never use the
   captain checkout's `DATABASE_URL` as a test database.
2. In the authorized window, let the **ledger tip** finish a batch and relinquish
   its writer locks. Keep it paused through the archive, restore verification
   and migration. Record its exact cursor block/hash, schema migration list,
   batch counts/hashes, table sizes, all financial table counts and exact
   comparison digests. Record every window's top 100 with rank and wei figures.
   The legacy indexer is not part of this operation.
3. Make a PostgreSQL 18 custom-format `pg_dump` of **all LedgerPostgres data and
   schema**, including `agg_journal`, batches, streams, windows, catalog and
   migration records, into a new immutable, timestamped before-state archive.
   Keep it outside daily rotating backups. Do not overwrite the existing
   rollback archive. Use the established secure connection procedure, with no
   credentials in commands, output or committed files. No infrastructure or
   billing changes are implied by this step.
4. Record dump size and SHA-256; require `pg_restore --list` to succeed. Restore
   to a new, dedicated local PostgreSQL 18 database and compare the recorded
   cursor, financial counts/digests and top-100 rows. A listable but un-restored
   dump is not sufficient. Store the restore log and verification results with
   the archive. Rehearse the additive migration on that restored copy, checking
   that every existing ledger/journal row and all read responses remain equal.
5. Create an archive manifest outside the repo, using the **restored archive's**
   cursor, not a newly sampled cursor to bypass the guard:

   ```json
   {
     "archive": "/absolute/path/ledger-before-transfer-provenance.dump",
     "sha256": "<64 lowercase hex characters>",
     "restoreVerified": true,
     "cursor": {
       "block": "<decimal block>",
       "hash": "0x<64 lowercase hex characters>"
     }
   }
   ```

6. With the production connection supplied securely in the environment and the
   new code available, run exactly once after the later approval:

   ```sh
   node --import tsx scripts/ledger-provenance-migrate.ts /absolute/path/archive-manifest.json
   ```

   This script loads no `.env.local`, verifies the archive bytes against the
   manifest, requires the writer lock and refuses a changed cursor. It does not
   run collection or ordinary migrations. The library also takes the migration
   lock, executes each pending attended migration in order from
   `packages/db/attended-migrations/001_transfer_provenance.sql` through
   `002_transfer_counterparty_registry.sql`, and records each immutable
   checksum transactionally. Migration 001 annotates the raw table with its
   archive digest and activation cursor. These files deliberately live outside
   the automatic migration directory. The manifest's restore attestation
   remains the attending operator's responsibility, not a claim inferred from
   a hash. A database that already records the immutable 001 checksum applies
   only 002; 001 is neither rerun nor rewritten.

7. Check the schema, table comment and both migration checksums, unchanged
   financial snapshots/read responses, zero provenance rows and NULL historical
   coverage counts. Only then resume the already-authorized ledger tip on the
   new code. Check its next committed batch's count against actual provenance
   rows, exact endpoint evidence, unchanged API contract, writer health and
   storage growth.

An SQL failure rolls back the whole activation. If verification fails before
tip resume, keep it paused and report to firstmate. Code rollback to the prior
writer is additive-schema compatible; retain the new table and archive and
record the resulting NULL-count coverage gap. It does not undo financial data.
Do not drop provenance or restore a production dump without separate exact
authorization. A later full restore is a rewind to the archived cursor and loses
later batches; it is not an automatic rollback command.

## Regression entry points

`packages/core/src/ledger-provenance.test.ts` pins classification, positive-only
block ranges, ambiguous and multi-leg routing. `packages/db/src/ledger.test.ts`
pins attended-only activation, archive cursor guard, unchanged
financial/journal snapshots, atomic failure, idempotence, conflicting evidence
and walk-back/replay. The ingestion regression is in
`apps/indexer/src/ledger-pass.test.ts`. Run the full project suite as specified
in `AGENTS.md` before shipping.
