# Evidence retention before the broad swap sweep

Status: proposal, not an active retention policy. No timer, deletion, archive
service, new database migration or production storage change is authorized by
this document. Implement the broad sweep with retained evidence first. Compact
only after the replacement read/replay/rebuild path is tested and deployed.

## What the current code stores

`packages/db/src/index.ts` saves a complete batch's evidence in
`indexer_batches.evidence` and a SHA-256 digest of `JSON.stringify(batch)` in
`content_hash`. For pool batches, `indexed_events.payload` also contains each
decoded event and its raw log; identity, block and timestamp are additionally
stored in dedicated columns. `collectPoolEventGroup` shares RPC fetches but
returns evidence per pool, so a receipt involving multiple pools can appear in
several batches. The same transaction can be retained by the recent collector.

`recent_swaps` demonstrates a smaller serving representation: normalized swap
amounts, direction, event identity and block provenance instead of a per-swap
JSON payload. However, `recent_batches.evidence` still retains receipt/log/header
evidence. Normalizing rows alone does not eliminate that evidence cost.

`loadIndexedAnalytics` in `apps/indexer/src/analytics.ts` currently loads the
launch observation and all contiguous deep-pool batch evidence from Postgres.
It validates receipts and token Transfer logs before constructing holder balances
and cost basis. Its current guard is at most 1,000 batches and 32 MiB per pool
input. A large pool can hit this limit independently of total database storage.
Deleting evidence or silently truncating those inputs would break rebuilds and
must not be used to bypass the guard.

The read API still reads `indexed_events.payload` for event detail. Removing it
also requires a tested normalized-row adapter or archive lookup. Current foreign
keys use batch rows for event, launch-source and analytics provenance; deleting
old batch rows can cascade into valid product data.

## Recommended storage boundary

Keep these records in Postgres indefinitely while their observations are part
of canonical coverage:

- Stream identity, start, registry/source revision, durable cursor and hash.
- Every committed batch's range, cutoff block hash, content hash, serialization
  version and evidence location/integrity manifest. Keep small batch manifests
  even after moving large evidence bytes elsewhere.
- Launch identities and all `pool_launch_sources`, including source-specific
  metadata. A rollback must select a remaining valid observation or remove the
  unsupported pool, as it does today.
- Normalized swap/Transfer identities required by the applicable tier, exact
  amounts, timestamps and block hashes, plus their source/batch associations.
- Current serving projections, verified deep positions, exclusion flags and
  replaceable derived metrics. Derived projections are not an evidence backup.

For broad swaps, store exact decoded amounts and price inputs once per canonical
event identity `(chain_id, transaction_hash, log_index)`, with its block hash and
range provenance. Preserve signed `amount0/amount1`, `sqrtPriceX96`, liquidity,
tick and fee needed to reconstruct prices/candles, as well as ETH/token amounts.
Use integer numeric columns with `scale()=0` checks or validated decimal strings;
never JavaScript floats in the money path.

Broad data provides observed activity, not verified wallet inventory. Its
product rows must carry `supported: false` and a specific flag such as
`missing_transfer_history`; attributed wallet, basis, realized PnL and holder
balances remain unavailable. The transaction initiator remains a separate field,
never the PnL beneficiary. This can reuse existing exclusion semantics, but
`recent_swaps` itself has no `supported` column and the current accounting tables
depend on deep snapshots and positions. Do not insert invented position rows to
satisfy those foreign keys. A broad projection/adapter must preserve that
separation and must not overwrite deep verified accounting when it exists.

The broad cursor and every pool's records for its chosen range must commit in
one transaction using the group persistence boundary. A sequence of independent
`commitBatch` calls followed by a cursor update is not equivalent. If a bounded
group cannot fit, shrink the uncommitted range; never advance over omitted pools.
Raw batch evidence should be shared by reference where multiple pool views use
the same receipt, rather than copied into every pool's JSON.

## Optional immutable archive

After normalized reads are working, a compressed immutable batch archive can
hold cold receipt/log/header bytes. This is an option requiring a separately
configured durable object store or an equivalently backed-up archive; local
container disk is insufficient. No new provider is selected here.

For new writes, capture the exact serialized batch bytes before hashing. Use a
versioned serialization contract, deterministic ordering, fixed codec and a
content-addressed object key. The Postgres manifest records at least chain,
stream/range, cutoff block hash, schema/serializer/codec versions, uncompressed
length, compressed length, uncompressed SHA-256, object SHA-256 and immutable
object key. Shared receipts must include their block hash as well as transaction
hash, so a receipt from a replaced fork cannot satisfy the manifest.

Uploading and committing cannot be a distributed SQL transaction. Upload first,
verify with an independent read/decompression/hash check, then atomically commit
the complete group, manifest references and cursor in Postgres. Failed SQL can
leave an unreferenced object; it must not leave a cursor referring to absent
evidence. Keep such objects until a separately tested reachability cleanup is
approved. Never overwrite objects at an existing content-addressed key.

Keep the current `content_hash` semantics for legacy batches. Postgres JSONB does
not preserve original object-key order or exact original serialization. An
archive of `evidence::text` therefore cannot be claimed to reproduce the existing
`JSON.stringify(batch)` digest. Record an archive-specific digest separately.
Legacy compaction must reconstruct the original batch under its known writer
version and prove the stored digest, or retain that legacy evidence in Postgres.
Do not rewrite old digests merely to make the comparison pass.

## Replay, reorgs and rebuilds

Replay remains content-sensitive: same stream/range and same batch hash is a
no-op; changed evidence under the same identity is rejected. Loading archived
evidence verifies the manifest, bounds, size limits, codec and both digests before
decoding. Missing or corrupt archives fail closed and leave the last dated
publication available. They must never become an empty successful batch.

Reorg reconciliation continues to read canonical headers and walk saved
checkpoints backward. The current reader examines at most 256 checkpoints, then
can rewind to the start if none match; retention must not reinterpret that
fallback as permission to discard older manifests. Preserve all manifests so a
rebuild can reconstruct the complete prefix. Rewinding removes canonical row
associations and invalidates projections in the same transaction. Archived
objects may remain physically present but are no longer canonical sources.

Deep PnL rebuilds still need launch verification, the complete token Transfer
prefix and swap attribution evidence. Archive-backed loading must reproduce the
same `AnalyticsInput` and exclusions before replacing the Postgres loader.
Separately, an incremental accounting checkpoint may eventually solve the
1,000-batch/32-MiB guard, but only if it stores exact inventory/basis state and
survives tested reorgs and from-birth reconstruction. Never reset basis at a
display window boundary or use archive compaction as a synthetic opening buy.

## Measure before choosing a retention window

No storage count or compression ratio has been assumed. The 52,404 launch target
is not a transaction count; a few active pools can dominate evidence bytes.
Measure the deployed database's table, TOAST and index sizes and bounded samples
of sparse/dense ranges, multi-pool transactions and each tier. For example:

```sql
SELECT relname, n_live_tup AS estimated_rows,
       pg_table_size(relid) AS table_and_toast_bytes,
       pg_indexes_size(relid) AS index_bytes,
       pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables
WHERE relname IN ('indexed_events', 'indexer_batches', 'recent_swaps',
                  'recent_batches', 'analytics_pool_snapshots');
```

These row counts are estimates. Use bounded, representative samples for logical
JSON size and physical `pg_column_size`; do not run an unbounded full JSON
serialization scan on the live database. Measure archive compression on the
same exact sample bytes and record duplicate receipt occurrences versus distinct
`(transaction_hash, block_hash)` receipts.

Estimate:

```text
Postgres bytes = baseline relations
  + swap count * measured normalized swap bytes including indexes
  + deep Transfer count * measured normalized Transfer bytes including indexes
  + batch count * measured manifest bytes including indexes
  + measured hot evidence and serving projection bytes
  + measured operational allowance for WAL, vacuum and backups

Archive bytes = unique uncompressed evidence bytes * measured compressed ratio
```

Do not double-count TOAST already included in `pg_table_size`. Compute low/high
estimates from measured sparse/dense samples rather than multiplying one token's
activity by 52,404. Choose any hot-evidence window only after reorg/rebuild latency
and storage measurements justify it. A time threshold alone is not eligibility
for deletion.

## Staged implementation and verification

1. Ship broad normalized serving rows while retaining current evidence. Verify
   event identity, signs, prices, activity totals and explicit unsupported PnL.
2. Add a versioned manifest/serializer and archive writer behind a disabled flag.
   Keep dual storage; verify every archive by independent read-back.
3. Add bounded archive reads. Rebuild representative deep pools and broad ranges
   into isolated schemas, comparing exact rows, supported/excluded positions,
   PnL, holders, candles and source coverage with the original SQL-only rebuild.
4. Test crashes between upload/SQL commit, exact/conflicting replay, missing and
   corrupt objects, decompression limits, duplicate cross-pool receipts, source
   removal and reorgs across hot/cold boundaries and beyond 256 checkpoints.
5. Migrate API reads away from raw per-event payload dependence. Exercise pool,
   wallet, transactions, leaderboard and live-feed endpoints against both stores.
6. Only after those checks pass, propose an explicit bounded compaction operation
   with rollback/recovery evidence. Keep canonical manifests and normalized rows;
   no broad TTL deletes and no changes to immutable applied migration files.

Until that work is complete, retain raw evidence and surface storage pressure as
an operational limit. The immediate Phase A deployment performs no pruning.
