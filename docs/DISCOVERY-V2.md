# Versioned Instant discovery

Discovery is disabled by default. After the user confirms the full historical
sweep, set `INDEXER_DISCOVERY_V2_ENABLED=1` on the indexer service to activate it.
The flag accepts only `0` or `1`; unset means `0`. While disabled the worker logs
`discovery_v2_disabled` once, does not create or update v2, and does not fall back
to v1. Existing deep pool indexing, recent swaps, launch discovery inside the
recent worker's range, and analytics continue. The separate historical launch
sweep is paused until activation; deploying the code alone does not begin it.

When enabled, the persistent worker schedules `discovery:v2` from block `22754669`. Its start,
registry revision `robinhood-instant-v2` and SDK source revision
`2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f` are stored with its cursor. Restarting
resumes that cursor. A different saved or compiled registry identity stops the
worker and requires another versioned stream.

The worker leaves `discovery:v1` unchanged, including its original start, cursor,
timestamps, batches and launch observations. It no longer schedules v1 for new
work. Overlapping v2 launches use the existing `pool_launch_sources` identity
checks; they retain a previously discovered pool's events, trade cursor and PnL
positions. Metadata belongs to its exact verified launch observation. Rewinding
the last observation that supplies an image also removes that image from the pool.

`INDEXER_DISCOVERY_BATCH_BLOCKS` controls logical discovery ranges independently
of deep pool ranges. It defaults to `10000` and accepts `1..10000`. The RPC query
range remains controlled by `INDEXER_LOG_RANGE_BLOCKS`; change that only after
the provider range probe passes. The scan combines all 12 verified Instant
strategies with the factory metadata emitter in the same range. A factory-only
token is not a verified Pools launch; CCA is not decoded as Instant.

Only a collector request-budget error, more than 250 launches, or more than
10,000 discovery logs halves the attempted range. It retries from the saved
cursor with fresh chain evidence. Five successful full batches using at most
100 RPC calls permit the range to double again, up to the configured maximum.
The hint is process-local. Coverage is always the committed database cursor,
never the size hint. Invalid receipts, changed boundaries and provider errors
are not converted into successful empty ranges.

Every cycle still allocates work to the existing deep pool scheduler. When v2
advances and is behind the confirmed head, a successful cycle starts the next
one immediately instead of adding the idle 15-second poll delay. All RPC work
keeps configured pacing and the normal writer lock. At the confirmed head the
worker polls normally.

The `discovered` log records the stream, registry, exact range, pool count,
`poolsWithImages`, HTTP requests and RPC calls. The image count reports a decoded
URL claim, not image-fetch validation or a guarantee that an image is reachable.
Measure total coverage and lag after the historical scan catches up. The 52,404
FeeSplitter balance is a comparison target, not proof all those launches are
Instant or that this registry covers CCA.

Validation: `apps/indexer/src/discovery-worker.test.ts` runs the real collector
against controlled valid RPC logs/receipts and an isolated Postgres schema. It
checks default-off activation with no discovery RPC or state changes, separate
v1/v2 state, pinned identity, restart, 10,000-block ranges,
metadata persistence, overlap, preserved positions/events, checkpoint walk-back,
source cleanup, budget retry and rejection without cursor advancement. The
complete `pnpm test:db` command includes it.
