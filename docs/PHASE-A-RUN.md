# Phase A operating record

Read root `STATUS.md` first for the user's priorities and 08:34 UTC baseline.
The user explicitly approved historical discovery on September 15, 2026.

## Activation

- Railway project: `zestful-fulfillment`, `51279532-d7a4-491e-92db-e30997ed9223`.
- Production environment: `0464eb3f-148d-46a5-9b08-759576f682f1`.
- Indexer service: `d41596b3-6c74-4f96-a0fe-b6655c98ba95`.
- Configuration deployment: `e798bf66-5592-4068-a1f4-a66eacf90be2`.
- The new container acquired the main writer lock at **08:39:52 UTC**.
- `/ready` returned HTTP 200 at **08:41:25 UTC**.

Applied values:

```ini
INDEXER_LOG_RANGE_BLOCKS=1000
RECENT_LOG_RANGE_BLOCKS=1000
INDEXER_DISCOVERY_V2_ENABLED=1
RPC_MIN_INTERVAL_MS=250
RPC_MAX_BATCH_SIZE=10
```

Railway's reviewed deployment diff showed the two log ranges changing from
10000 to 1000, RPC batch size from 4 to 10, and v2 activation from unset to 1.
250ms was already configured and did not create a fifth diff entry. These
values were applied to Railway, not merely the local environment file.

`INDEXER_DISCOVERY_BATCH_BLOCKS` remains its default 10000. This is the atomic
commit range; the RPC client splits it into log requests of at most 1000 blocks.
A `discovered` line with `advanced:10000` therefore does not imply a 10000-block
RPC request. The recent worker separately logged a 1000-block committed batch.

## First verified progress

The public read API confirmed v2's persisted start is **22,754,669**. The new
deployment logs and subsequent API observation showed:

| UTC | v2 committed cursor | Evidence |
| --- | ---: | --- |
| 08:39:54 | 22,774,668 | `discovered`, 10000 blocks committed |
| 08:40:46 | 22,854,668 | `discovered`, 10000 blocks committed |
| 08:41:25 | 22,894,668 | `/v1/status` saved cursor |
| 08:46:19 | 23,264,668 | `/v1/status` saved cursor |

The first two observations measure **80,000 blocks / 52 seconds**, about
**1,538 blocks/sec**. This sparse early interval is not a full-run ETA. It
includes deep pool work between discovery batches; launch-heavy intervals also
need receipts, contract calls and metadata verification. The log-query CU
estimate is not a total for every method and worker.

V1 stayed at **62,923,934**, hash
`0x5d6729bc6b864fd7b271488dd056febd9bba5c71d1828c72d1c380ca8de2724f`,
with its saved timestamp still **07:26:44.328 UTC**. No local writer was started.

At 08:40:22 the recent worker committed 1000 blocks, observed 2034 swaps,
saved 490 registered swaps and reported 1544 unregistered swaps. Its reported
lag was 59,469 blocks, versus the user's 65,113-block 08:34 baseline. At 08:45:58 it reported lag of 45,797 blocks. Analytics
was publishing alongside it. No rate-limit failure appeared in this inspected
startup interval. Existing internal successful retries are not yet individually
observable, so this is not proof of zero 429 responses.

## Counts and provider use

The user's 08:34 baseline was **410 catalog pools**, **301 processed pools**
and **315 qualifying traders**. Catalog totals combine historical and recent
observations; they must not be called an exact `indexed_pools` table count.
The current public status reports pool streams, not a table count. Exact table
and factory-image counts are being added to the existing operational status
read. The local database URL is private and cannot resolve off Railway; do not
change database networking just to obtain these statistics.

The authenticated Alchemy Usage dashboard was refreshed during startup. It
showed **2,188,684 CU used this month**, **No usage cap**, and a displayed peak
of **588 / 10,000 CU/s**. Use this fresh total for subsequent deltas rather than
assuming the earlier 23.7M-remaining figure describes the upgraded plan's
current counter. The total includes all three workers and dashboard reporting
may lag. No billing settings were changed.

## Monitoring and abort

The thread heartbeat `phase-a-discovery-progress` is active every 30 minutes.
Report exact indexed count, factory-image count, v2 cursor and interval speed,
all-worker 429 evidence, recent lag and source identity conflicts. Refresh
Alchemy usage partway through and compare its delta with actual work rather
than treating only `eth_getLogs` as the entire workload.

On sustained throttling, runaway retries, material unexpected consumption or
identity conflicts, set `INDEXER_DISCOVERY_V2_ENABLED=0` on this Railway service
and deploy. Preserve all cursors and evidence. Report the problem immediately;
do not substitute unrelated work. The worker's internal retry observability
and terminal rate-limit stop behavior need an operational guard, tracked in the
current implementation work.

When v2 reaches the confirmed chain cutoff, record the final count and fraction
carrying factory `image_url`. Compare with 52,404 measured FeeSplitter positions
without assuming the counts must be identical. Then proceed to Phase B's
global atomic swap persistence. No LBP/CCA decoder expansion or evidence
pruning is authorized.

## Paused product work

Trade-card UI, font, metadata and browser-test work was safely saved in
`stash@{0}`, named `Paused verified trade-card UI for Phase A activation`. Its stable commit
identity is `f56d87fb7c83fcdf0bffbd1c16458ed7f3adee2f`.
Use `git stash apply` with the resolved stash identity when deliberately
resuming it; verify before dropping the stash. No unfinished product files
were pushed during the focus change.
