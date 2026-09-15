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

## Remaining import work

This change does not import candidates, create a new discovery stream, reset
`discovery:v1`, or establish full historical coverage. `ensureDiscovery` and the
worker still schedule only the original continuous discovery stream.

The candidate importer must revalidate chain evidence, insert a distinct bounded
source stream and its exact verified batch transactionally, and reconcile that
source against canonical hashes thereafter. Do not advance a broad cursor across
gaps between candidate windows. The existing pool workers can then backfill the
new pool's events from its launch block; launch discovery alone supplies no PnL.

Future exhaustive discovery must have an explicit registry revision and saved
range. It can use this overlap reconciliation without resetting existing pools.
The normal writer lock remains required for writers; this migration does not add
parallel write scheduling or eliminate that coordination requirement.
