# Launch source reconciliation

Migration `007_launch_sources.sql` lets an indexed pool have several verified
launch observations. Each observation points to its exact discovery stream and
batch. The migration backfills existing pools and records first sources with an
insert trigger, including inserts from an old worker draining during deployment.
It locks the stream, batch and pool tables while performing the migration so the
initial backfill cannot miss an in-flight write.

`commitBatch` accepts another observation only when token, launch block,
transaction, creator and timestamp agree exactly. It preserves the existing pool
stream, trade cursor, metadata and derived accounting. A conflict rolls back the
whole batch and its cursor. Names and symbols are retained from the original
observation because they are descriptive metadata, not immutable launch identity.

On source-batch deletion or rewind, a database trigger chooses a remaining source
for the existing `source_stream`/`source_batch` read columns. If no source remains,
it removes the pool stream and pool, cascading through events and derived
snapshots/positions. The old unconditional pool-stream deletion in `rewind` is
removed so a still-supported launch keeps its history.

Validation uses real isolated Postgres schemas starting from migrations 001-006:
upgrade backfill, exact overlap/replay, five identity conflicts with atomic rollback,
rewind in either source order, exact position/event/cursor preservation, final-source
cleanup and rediscovery. All 33 database checks passed locally. Existing analytics
tests also exercise direct launch inserts after migration.

## Deployment verification

Implementation `a14e4cc` passed full CI34924987243. Railway deployment
`5712e18d-ff29-4ca0-8a2f-0b2f704d5cd7` became active, with migration success and
writer acquisition confirmed in production logs on 2026-09-15 at 03:33-03:34 UTC.
All five serving endpoints returned HTTP 200 afterward. No candidate import was
performed, and this rollout does not resolve the existing live-feed lag.

## Atomic candidate commit

`candidateStreamKey(registryRevision, poolId)` names a distinct finite source.
`commitCandidateBatch(db, registryRevision, batch)` atomically creates that source
and commits one verified pool with its evidence. It accepts at most 32 blocks, an
exactly matching retry, and another registry revision observing the same launch.
It rejects changed saved bounds, conflicting replays, or conflicting launch identity.
A failure rolls back the new stream too. It never advances `discovery:v1`.

Callers must hold the normal writer lock and freshly verify chain evidence. Given
`proof = await verifyLaunchCandidate(candidate, rpc)`, the batch shape is:

```ts
await commitCandidateBatch(db, proof.registryRevision, {
  from: proof.fromBlock,
  to: proof.toBlock,
  hash: proof.catalog.blockHash,
  evidence: proof.evidence,
  pools: [proof.pool],
});
```

This is a persistence boundary, not a chain verifier. Stored JSON alone is not
sufficient authorization to publish. The worker must check/reconcile saved source
hashes and invalidate stale observations; canonical checks belong in that caller.
Candidate sources are finite: do not pass them to the continuous `runBatch` loop,
which would otherwise extend discovery beyond the verified candidate window.

All 34 local Postgres checks passed, including candidate creation, source rollback
on conflict, bounded retry, duplicate-source history preservation, unchanged broad
discovery cursor and source reattachment after rewind.

## Remaining import work

This change does not import candidates, create a new discovery stream, reset
`discovery:v1`, or establish full historical coverage. `ensureDiscovery` and the
worker still schedule only the original continuous discovery stream.

The candidate worker must revalidate chain evidence, call the atomic commit entry
point above, and reconcile that source against canonical hashes thereafter. Do not advance a broad cursor across
gaps between candidate windows. The existing pool workers can then backfill the
new pool's events from its launch block; launch discovery alone supplies no PnL.

Future exhaustive discovery must have an explicit registry revision and saved
range. It can use this overlap reconciliation without resetting existing pools.
The normal writer lock remains required for writers; this migration does not add
parallel write scheduling or eliminate that coordination requirement.
