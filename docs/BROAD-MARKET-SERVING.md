# Pool detail market serving

The existing `/v1/pools/:poolId` response adds `market: ObservedMarket`; the
existing web proxy and pool page consume it. The broad-only page uses the
existing pool layout and candle component. Deep published accounting continues
to use its existing snapshot, holders and supported positions. Broad history
does not manufacture a ChainMarket, wallet, holder balance or beneficiary.
The live-trades route remains recent-only.

Market coverage has its own start block, canonical cutoff block/hash/asOf,
indexedAt, window start and price baseline. Accounting is explicitly unavailable
on this observed contract. Catalog discovery, recent observation time and quiet
unprocessed pools never imply a processed market or zero trades. Only a surviving
canonical historical stream can establish the market cutoff. Recent copies can
corroborate historical identities but cannot advance that cutoff.

SQL combines deep saved swaps, normalized broad swaps and eligible recent copies
by transaction hash/log index. Conflicting pool/token, block/hash/time, signed
amounts or price state reject the read. Cross-pool copies are checked through
canonical identity indexes. Deep legacy payloads with exact signed amounts can
derive side and ETH volume without rounding. Unknown/unsupported signs remain
observed trades; affected window volume and current price are unavailable.

ETH amounts and price math remain exact decimal strings and PostgreSQL numeric
integers. The latest surviving canonical units observation at or before the market
cutoff declares the chart's token display scale. Its own dated block/hash/asOf
and source stay separate from the market coverage cutoff. This is display normalization, not evidence
that decimals were independently observed at every swap. Conflicting surviving
dated decimals suppress normalization. Missing all eligible units never defaults to 18. A quiet token retains its
chart when an unrelated or empty global batch advances coverage; the earlier
unit basis is never relabeled as observed at that newer cutoff. Token scales above the supported 36-decimal price
range remain unavailable. Current supply is never used for historical FDV.

The adapter returns only summary totals, the latest 50 identities and the
latest 1,000 minute OHLC buckets. Stats are never computed from a fetched
prefix. Baselines precede the selected window and are not filtered out with
window trades. Candles carry the previous proven price state as their opening
value; unsupported-price buckets are omitted. Output truncation is explicit.
A cut on the canonical broad stream is served from the rollups ("Pool page
from the rollups" below); a deep-selected cut, or a broad cut with a
projection gap below it, aggregates the complete canonical per-pool history in
SQL per request. The 21,001-trade Postgres-to-HTTP fixture proves full exact
totals with bounded observations and candles on that raw path.

This is a pool-detail adapter, not the global screener architecture. Global
serving needs a rebuildable canonical per-pool/time-bucket rollup, cutoff and
unit-basis versioning, summary indexes for sorting/pagination, and atomic suffix
invalidation on discovery/broad/deep rewind. Deep saved swap price fields should
also be normalized into indexed scalar columns before global aggregation, rather
than scanning retained JSON evidence. No global screener request scans raw broad
swaps in this increment. The pool page's broad-selected cut reads those same
rebuildable buckets; the reader keeps its 3-second SQL budget rather than
returning incomplete summary totals on timeout.

Prerequisites: broad persistence 010, worker integration 649b985 and canonical
token units dc603f8/migration011. Verification uses only isolated local
Postgres schemas and mocked website API responses. No production flag is enabled.

## Canonical market rollups for explore

Migration 012 adds rebuildable, batch-owned `broad_market_summaries` and
`broad_market_buckets`. Each per-pool batch summary stores exact observed trade
count, unsupported count and integer ETH volume. One-second buckets retain
exact time boundaries, count/volume, raw first/last sqrt-price state with
block/hash/transaction/log provenance and independent price eligibility, and
(migration 018) the lowest and highest sqrt price over the second's swaps. This
allows unsupported raw states to survive without becoming normalized prices.
Raw evidence, `broad_swaps` and deep publications are retained unchanged.

New broad commits project all pools inside the existing group transaction before
the canonical cursor advances. A failed bucket write rolls back evidence,
normalized inputs, projections and cursor. Batch ownership cascades through
broad rewind and discovery dependency rewind, including empty ranges. Deep and
recent contradictory copies are checked at write/rebuild time and persisted in
small indexed conflict associations. Deep/recent rewind removes those
associations atomically; reads fail closed on surviving identity conflicts.
Deep/recent copies never add to broad totals or move historical coverage.

Existing historical batches are not assumed to have projections. Completion
markers in `broad_market_batches` form the durable derived progress boundary.
Explore uses only the contiguous completed canonical prefix before the first
missing marker, even when a newer suffix has already been projected. Rebuild
with the normal writer stopped/lock available, using the explicitly selected
database and one bounded invocation at a time:

```sh
DATABASE_URL=<isolated-or-approved-database> pnpm exec tsx scripts/rebuild-broad-market.ts 10
```

The command has no implicit env-file loading, migrations, RPC, deletion or loop.
It rebuilds at most 10 retained batches in one transaction and reports `rebuilt`
and `remaining`. Invoke again until `remaining=0`. The limit must be 1-100; dense
batches can justify a smaller limit. Deleting only derived completion markers
cascades to their summaries/buckets and permits a tested full reconstruction.
Never delete canonical evidence or reset the broad cursor to force a rebuild.

The existing `/v1/explore` response and screener now consume those projections.
A pool uses canonical broad market data when its launch is covered by the pinned
v2 registry and the derived cutoff is at least its valid deep publication's
cutoff. During backfill, a newer deep market publication stays selected. Sources
are selected per pool and never summed. `marketCoverage` identifies the selected
source, actual block/hash/asOf, window start, raw last price observation, price
baseline and separately dated unit basis. Global `coverage` still describes
deep analytics; `processed`, `market`, `asOf`, `throughBlock`, `generatedAt`,
`sourceKind`, holders and liquidity remain deep data. Selected market dates live
in `marketCoverage`, so a newer broad cutoff cannot relabel an older deep market.
Broad market activity cannot create holder balances, TVL, beneficiaries or PnL.
The screener avoids using a deep sparkline as a broad trend when broad metrics
are selected. Direct pool pages retain the existing richer chart read path.

Complete batch summaries serve whole batches inside the selected time window;
indexed buckets serve only intersecting edges. Latest/baseline state uses indexed
pool bucket lookups. No global request scans raw swaps or retained JSON.
Every explore page computes the full per-pool metrics (dated units, latest
and baseline price states) for the page being served only, never for the
whole catalog: those per-pool lookups cost seconds at catalog scale on a small
host. Launch order selects the page's identities with a narrow catalog sort;
trade count and volume rank on the cheap flow columns and then bind the page's
identities; change, liquidity and the gainers view rank the deep-publication
set. Binding identities rather than paging a `LIMIT/OFFSET` CTE keeps the
planner's page estimate at the page size on the last pages of the catalog,
where an `OFFSET` estimate collapses to one row. Rank keys mirror the served
expressions and every path builds the same per-pool metric rows. The explore read sets
`jit = off` for its transaction: per-row lateral lookups inflate these
statements' cost estimates far past `jit_optimize_above_cost` while they
execute in well under a second, so a JIT-capable host would spend seconds
compiling them.
Price normalization follows the pool adapter's dated display-unit rule: latest
surviving eligible broad units or dated deep units, conflict detection across
surviving observations, no default decimals, supported scale at most 36. Unit
observations retain their own date after quiet global cutoff advancement.
Window price change uses the latest proven pre-window price state, never a
bounded returned trade prefix. Unsupported signs suppress affected volume and
normalized last price while preserving observed trade counts.

Launch order is the default and keeps the entire catalog in the All view and
searchable, including unprocessed or not-yet-covered launches. Sorting by
volume, trade count, change or liquidity follows the launch-first rule: only
pools whose selected source proves that metric participate, so the total and
every page exclude null values before `LIMIT`. Trade count and volume rank
every launch on the summary flow columns under the coverage predicate (or deep
flow) before the page's full metrics run; change and liquidity rank the pools
with a deep publication, the only pools whose change or liquidity is served. A
catalog-wide price or change order waits for a per-pool latest-state rollup
and `sort=price` answers `invalid_sort`. Sorted metrics use eligible
exact values, `NULLS LAST` in both directions and `pool_id ASC` for ties. Total
counts precede page limits. There is no default volume floor; zero activity is
shown only for a pool whose complete canonical covered prefix proves no trades
in that window. Uncovered metrics stay null. Each dated window is historical
coverage, not a current-chain claim or full-catalog completeness.

Local verification uses random schemas on `TEST_DATABASE_URL` and no RPC.
`pnpm test:db` covers atomic commit/replay/rewind, partial rebuild interruption,
a projected suffix behind a missing prefix, complete reconstruction, 21,001
exact trades, missing/conflicting/late units, unsupported signs, broad/deep/recent
overlap and conflicts, newer deep source selection, quiet cutoff advancement
and deterministic full-catalog pagination. `pnpm test:e2e:market` additionally
starts a canonical fixture API and uses the production web proxy and real
explore page on desktop/mobile. It needs an isolated `TEST_DATABASE_URL` and
free local ports 3117/43119, separate from the regular captured-data browser
suite. Unrelated live browser requests are blocked, rather than supplied with
fake live market payloads. No production flag or workload is enabled. The 52k-pool serving check (`apps/api/src/broad-explore.scale.test.ts`) runs as the serial second phase of `pnpm test:db`, after the concurrent files, so its first-read bound measures the query on an idle database.

## Pool page from the rollups

`GET /v1/pools/:poolId` selects the newest surviving cut for the pool: its
deep pool stream or the canonical broad stream (at the same height the broad
cut, after the identity check). When the selected cut is the broad stream,
every broad batch through the cutoff has its projection marker and the cut's
start is not below the stream's own start (a deep stream that reaches further
back extends it), `readObservedMarket` serves the market from the rollups in
one statement bounded by the pool's summaries and one-second buckets rather
than its swaps:

- Trades and volume are the whole batch summaries inside the window plus the
  edge batches' intersecting buckets, the explore read's sum; volume is
  unavailable when any swap in the window is unsupported.
- The latest and baseline price states are the newest bucket at or before the
  cutoff and the newest before the window, by timestamp, block, log index and
  transaction, as the explore read reads them.
- Candles fold the buckets by minute with hashable aggregates (count of
  unsupported swaps, volume, lowest and highest sqrt price, first and last
  second), so the fold's memory is the pool's minutes and it never sorts the
  pool's buckets; migration 018 records extended statistics on the minute
  expression so the planner hashes. A minute is a candle when every swap in it
  is supported. Because the display price is monotonic in the sqrt price, the
  minute's high and low are the prices of the lowest and highest sqrt among its
  swaps and the previous swap's state; migration 018 adds `min_sqrt` and
  `max_sqrt` per bucket for exactly this, since blocks on this chain share
  timestamps and a second often holds several swaps whose extremes sit between
  its first and last. Only the 1,000 served candles probe the pool price index
  for their opening, closing and previous states (the previous non-empty
  minute's last bucket); an open is that previous state or, after an
  unsupported swap, the minute's own first.
- Observations are the newest fifty broad rows by block and log index.
- Identity conflicts are the write-time caches `broad_market_conflicts` and
  `broad_market_recent_conflicts` touching the pool on either side of the
  identity (the broad row or the deep/recent copy names it); the projection
  validated provenance per row when it wrote the bucket, so there is no per-row
  re-validation.

Every other case aggregates the raw copies per request, exactly as before:
a deep-selected cut (the pool stream's cursor is past the broad cursor), a
projection gap below the cutoff during a historical rebuild, an extended
start, or buckets without migration 018's extremes. That path is linear in
the pool's swaps; at 82k swaps it took 6 to 8 s against the 3 s budget, which
is the 503 the rollup path removed. A hot pool whose deep stream later
overtakes the broad cursor returns to it.

The read checks for the extremes per request because the read API deploys on
its own while migrations run from the indexer service's pre-deploy command
(`apps/indexer/railway.json`). While that service is down with its source
disconnected (`docs/PHASE-A-RUN.md`), a merge deploys the API but not the
migration, and the busiest pages stay on the raw path until migration 018 is
applied by hand: a one-off service built the way the rollup rebuild below was,
running `migrate` from `packages/db` on the production database (about 2.4 s;
it rewrites the 53,020 bucket rows once, about 80 MB of table and WAL growth
against the volume headroom recorded below).

The two paths must answer byte-for-byte the same JSON, and
`apps/api/src/observed-market-rollups.integration.test.ts` deep-compares them
per window on a fixture with a minute spanning two batches, a second holding
four swaps with the extremes in the middle, an unsupported swap, an open on the
minute's own state, and the cached deep and recent conflicts on both sides of
an identity. `apps/api/src/observed-market-rollups.scale.test.ts`, the third
serial phase of `pnpm test:db`, seeds 80,000 swaps for one pool, one per
second (a bucket per swap, five times production's busiest pool's bucket
count), projects them, prints the statement's plan summary and bounds each
served window at 1,000 ms, asserting the fold neither sorts externally nor
touches temp buffers. On the production-shaped copy the busiest pool's
statement runs in about 15 ms (shared hit 4,679, read 6,469, no temp, hash
aggregate 353 kB in one batch) and its page answers in about 100 ms per
window.

## Production rebuild record (2026-09-16)

The one-time rebuild of the historical broad batches ran against production
Postgres 18.6 at 09:49:48-09:49:54 UTC, with the indexer stopped and the writer
lock free. It ran on a temporary Railway service, `rollup-rebuild`, built from
main `c1781de` with `apps/indexer/Dockerfile` by `railway up` of a `git archive`
(no GitHub source, no pre-deploy migration, restart policy never), with only
`DATABASE_URL=${{Postgres.DATABASE_URL}}` and no chain keys. The service was
deleted at 09:51:53. The indexer image has no `scripts/`, so the job imported
`acquireWriter` and `rebuildBroadMarket` from `packages/db` and repeated the
documented invocation (`limit=10`) on one writer-locked connection until
`remaining=0`. Between invocations, a guard stopped the run if actual or
projected database plus WAL growth passed 480 MB, the most the 5 GB volume
allowed while keeping 1 GB free.

A read-only preflight ran first. Migrations were applied through 015, and no
indexer connection was open. The stream held 147 broad batches (73 with swaps,
the largest 5,303) and 165,417 swaps through block 23,794,671, which projected
53,020 buckets and 1,853 summaries. It found 17,448 deep copies, all
consistent, and no recent copies. There were no invalid discovery dependencies,
accounting cutoff mismatches, incomplete batches or provenance violations, and
the cursor hash matched. Check these before any rebuild: a conflict or mismatch
at or below the served cutoff makes every `/v1/explore` request answer 503.

| Measure                                      | Before             | After                                    |
| -------------------------------------------- | ------------------ | ---------------------------------------- |
| `broad_market_batches` / buckets / summaries | 0 / 0 / 0          | 147 / 53,020 / 1,853 (conflicts 0 and 0) |
| Rollup tables with indexes                   | 0.1 MB             | 78.3 MB (buckets 77.2, summaries 1.0)    |
| All databases / WAL                          | 3,361.6 / 100.7 MB | 3,439.8 / 117.4 MB (+95.0 MB in total)   |
| `broadMarketCutoff`                          | null               | block 23,794,671, `rebuildPending` false |
| Explore total, `sort=launch` (All and 7d)    | 62,464             | 62,464                                   |
| Explore total, `sort=volume` (All and 7d)    | 1,364              | 1,406                                    |
| Explore total, `sort=trades` (All and 7d)    | 1,364              | 1,412                                    |
| First volume and trades page source          | `deep_publication` | `canonical_broad`                        |

The rebuild took 6 s over 15 invocations; the slowest took 901 ms. The volume
read 3,465.9 of 5,000 MB used before the run, and Railway's reading had not
refreshed by 09:52, so about 1.44 GB stays free. Metric totals rose only by the
launches the broad history covers: its cursor is block 23,794,671, while
discovery:v2 has reached 64,403,385.

Public API timings, 50 rows per page, measured from outside Railway (an `/health`
round trip took 0.11 s): before, 0.21-0.62 s per page. After, every combination
of sort (launch, volume, trades), window (All, 7d) and offset (first page and
last full page) took 0.14-0.58 s, including 36 requests that bypassed the API's
5-second cache. The first read of `sort=launch&window=All&offset=62400` after
the rebuild took 2.12 s, which is the latency risk to watch; four later reads
of it took 0.26-0.32 s. `scripts/check-indexed-health.mjs` reported no issues
and a matching consistency check. It exited 2 only because the recent feed is
`stale` with the indexer stopped. The website's `/`, `/traders/`, `/creators/`,
a broad pool page and the API's `/health` answered 200.
