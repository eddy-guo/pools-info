# Indexed chain read API

This small Node service reads public chain evidence from the private Railway
Postgres database. It makes no RPC calls and writes no account/profile data.
Product endpoints aggregate the published, supported pool positions using the
same exact average-cost rules as the frontend. Indexer migrations, evidence
verification, holder reconstruction and publication remain separate.

Database-backed product routes refuse immediately while the database is warming
with `503`, `reason: "warming"` and `Retry-After: 5`; `/ready` remains independent
of warming. Startup/reconnect and five-minute reader warming are automatic in
the API and ledger tip service. See [Database reader warming](../../docs/DATABASE-WARMING.md)
for the scope, bounds, cancellation and residual eviction window.

## Running

From the repository root, install workspace dependencies, then:

```sh
DATABASE_URL=postgresql://localhost/pools pnpm --filter @pools/api start
```

Use a separate local development database, not the production database, for
tests. Set `TEST_DATABASE_URL` and run `pnpm --filter @pools/api test`; the
integration test creates and removes an isolated schema. Without that variable,
the database test skips and HTTP/parser tests still run. The service never runs
migrations itself.

For Railway, use the existing repository and region, root `/`, Dockerfile
`apps/api/Dockerfile`, default image start command, and health-check `/ready`.
Set `DATABASE_URL` through Railway's private Postgres reference; Railway supplies
`PORT`, otherwise it defaults to 3102. Keep the database private. This read
service can have a Railway HTTPS domain for the Next.js server to call. No new
RPC key is required. Prefer a dedicated database role with SELECT access only
to `indexed_pools`, `indexed_events`, `indexer_streams`, `indexer_batches`, and
`analytics_pool_snapshots`, the four `analytics_accounting_*` tables and the
four `recent_*` tables, plus schema USAGE, and SELECT, INSERT and UPDATE on
`token_images` only (the icon store below). Even when using the existing connection initially, all API
read transactions explicitly run READ ONLY; the icon store writes through its
own three-connection pool and touches no other table. Database roles are infrastructure
permissions and are unrelated to user accounts.

Deploy the indexer first so its pre-deploy migration applies
all migrations through `006_catalog_search.sql` before exposing the growing
event history. The catalog query names `indexed_pools.creator_fees` (migration
021, applied by the ledger tip loop at its start) on every route, so `/ready`
refuses until that column exists and a release ahead of the migration keeps
the previous release serving. Migration 005 adds normalized accounting rows; the writer
backfills existing publications without RPC. `/ready` checks read access and
rejects `analytics_projection_pending` until every publication has a matching
projection. Migration 006 adds indexed substring/fuzzy catalog search. The API
has no migration privileges or startup migration command.

No deployment is implied by these files. The website must be explicitly wired
to this service after deployment and data validation.

`MARKET_SOURCE` picks the store behind explore's market figures, the pool
page's `market`, the trader leaderboard and the wallet page, once at startup:
unset or `broad` serves the broad rollups, deep publications and the
accounting tables; `ledger` serves every pool the aggregate ledger covers from
`agg_pool_hours` and `agg_pool_state`, the leaderboard from
`agg_wallet_windows` and the wallet page from that row, `agg_positions` and
`agg_wallet_hours`, and additionally needs SELECT on `agg_streams`,
`agg_batches`, `agg_pool_hours`, `agg_pool_state`, `agg_live_trades`,
`agg_wallets`, `agg_positions`, `agg_wallet_hours`, `agg_wallet_windows`,
`agg_window_refreshes` and `pool_launch_sources`. What changes in the
responses (`aggregate_ledger` coverage and unit-basis sources, hourly candles,
`market.fdvWei`, one price per pool, the top-100 board, the wallet page's
empty `trades` and `curve`) is in `docs/LEDGER-MARKET-SERVING.md`.

## HTTP contract

Only GET and HEAD are supported. Unknown/duplicate query parameters are rejected.
Pool IDs are 32-byte `0x` hex values; wallet/token addresses are 20-byte hex
values. Addresses are normalized to lowercase. Exact amounts - wei values and
raw token quantities - remain decimal strings. Block heights and on-chain
timestamps are JSON numbers, as are `logIndex` and chain ID: they sit far below
2^53 and the website's response validators require numbers. The feed has the
existing `RecentSwaps` numeric block/timestamp contract, with safe-integer
validation for its boundaries. The `/v1/status` `poolStreams` and `indexedPools`
summaries are the exception: they stay raw `::text` aggregates under their SQL
column names.

Raw-event `/v1` responses have `generatedAt` and this `coverage`:

```json
{
  "chainId": 4663,
  "source": "indexed_chain_events",
  "scope": "verified_pools_launches_only",
  "completeness": "partial",
  "registryExhaustive": false,
  "chainHead": null,
  "pnlAvailable": false,
  "note": "Recorded block cutoffs are historical coverage, not proof of current-chain freshness. Transaction initiators are not proven trade beneficiaries. Token transfers can appear once per indexed pool for the same token."
}
```

Each pool/event has its own `coverage`: `startBlock`, `throughBlock`,
`throughBlockHash`, `indexedAt`, and `completeTokenLifetime:false`. Null cutoff
means collection has not completed a batch. A recent `indexedAt` describes a
database commit, not the age of the chain block. No endpoint claims every Pools
launch is indexed or that a wallet's history/cost basis is complete.

| Endpoint                                       | Response and parameters                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/health`                                      | `{ok:true}`; process liveness only, no database check.                                                                                                                                                                                     |
| `/ready`                                       | `{ready:true}` only after checking DB access to the read tables.                                                                                                                                                                           |
| `/v1/status`                                   | Up to 100 discovery streams with exact cutoffs, `discoveryTruncated`, and `poolStreams` summary: `streams`, `streams_started`, `earliest_cursor`, `latest_cursor`, `last_commit_at`. No live chain-head request.                           |
| `/v1/pools?q=&limit=&cursor=`                  | `{items,nextCursor,pagination}`. Literal case-insensitive name/symbol search; a complete token address performs exact token lookup. Includes only discovered membership records.                                                           |
| `/v1/pools/:poolId`                            | `{pool,latestRecordedSwap}`. Pool identity, token, name, symbol, launch evidence references, per-pool coverage, and latest recorded swap or null. Missing pool returns 404 `pool_not_indexed`, which does not prove nonexistence on-chain. |
| `/v1/trades?poolId=&limit=&cursor=`            | `{items,nextCursor,pagination}` of recorded swaps, globally or scoped to one pool. Includes unsupported swap records with their original payload/exclusion reason.                                                                         |
| `/v1/wallets/:address/activity?limit=&cursor=` | `{wallet,activityMeaning,items,nextCursor,pagination}` for a transaction initiator or token Transfer participant. Empty activity does not prove the wallet is inactive. Does not require sign-in.                                          |
| `/v1/feed?pools=id1,id2`                       | Bounded recent swap feed for 1-8 distinct indexed pool IDs, described below.                                                                                                                                                               |
| `/v1/pools/:poolId/image`                      | The pool's creator icon as a stored 128 px WebP, described under "Token icon store". No query parameters.                                                                                                                                  |

A pool item includes `poolId`, `token`, `name`, `symbol`, `coverage`, and `launch`:
`block`, `transactionHash`, `transactionInitiator`, `timestamp`, `sourceStream`,
`sourceBatchThroughBlock`. The launch transaction initiator is explicitly not
presented as a verified creator identity.

An event item includes `id` (stream + transaction hash + log index), `poolId`,
`token`, `transactionHash`, `logIndex`, `block`, `blockHash`, `timestamp`, `kind`,
`transactionInitiator`, `attribution:"transaction_initiator_only"`, `payload`,
and pool `coverage`. Payload is the saved collector output. Swaps contain
`decoded` exact integer amounts or null plus `unsupportedReason`; transfers
contain `from`, `to`, and `value`. Raw receipt/header evidence remains in the
database, not duplicated in each HTTP response. Transfer events may have records
under multiple pools for the same token; these are collection records, not
unique-trade counts. Never sum them as wallet PnL.

List limits default to 25 and cap at 100. Opaque cursors bind to the route and
filter and contain a descending keyset position. Pools sort by launch block
then pool ID. Events sort by block, log index, transaction hash, then stream.
Reorg cleanup or historical backfill can change pages across requests. Refresh
the first page to see new/backfilled records; pagination is eventually
consistent, not a frozen database export.

## Feed and live polling

The feed reads all requested streams in one repeatable-read transaction. Its
common upper cutoff is the minimum indexed cursor; its lower cutoff is the
maximum start block, further bounded to the latest 1,000 blocks of that
intersection. It returns 503 if any stream has no completed coverage or the
intervals do not overlap. It validates the cutoff block hash and timestamp
against the saved batch header, not the last swap timestamp. Missing boundary
evidence returns 503 instead of inventing freshness.

Response fields are `source:"indexed_chain_events"`, `fromBlock`, `toBlock`, `toTimestamp`, `toBlockHash`,
`indexedAt` (oldest selected checkpoint commit time), `poolCoverage`, `events`,
`truncated`, `omittedUnsupportedEvents`, `generatedAt`, and the common `coverage`
object. At most 50 events return, newest first, each containing `poolId`,
`txHash`, `logIndex`, numeric `block`/`timestamp`, exact-string `amount0`/`amount1`,
and `transactionSender`. Unsupported decoded events are counted explicitly as
omitted, never assigned fabricated amounts. `truncated` signals more than 50
recorded swaps in the range.

Polling this endpoint every 10-15 seconds is sufficient for the current pilot.
Its data may still be historical while the indexer backfills. Replace the feed
window on refresh, rather than append forever, so reorg removals and corrections
can propagate. Deduplicate using pool ID + transaction hash + log index. A
decreasing cutoff or changed cutoff hash must invalidate previous assumptions.

## Bounds and failure behavior

Four Postgres connections, 2-second connection timeout, 3-second statement
timeout, 16 concurrent database reads, 240 requests/minute per instance, and
five-second cache/request coalescing keep a public read service bounded. Cache
storage caps at 256 entries and 16 MiB; each response caps at 8 MiB. This
is an instance-wide pilot budget, not an account/IP tracking system. Search and
wallet reads still need the read indexes as history grows; timeouts return a
retryable 503. No HTTP response exposes credentials, SQL, or provider errors.

Errors use `{error:code}` with 400 for validation, 404 for missing routes/pools,
405 for mutations, 429 with `Retry-After` for rate limits, and 503 for busy,
unavailable data, or missing feed coverage. Responses use `Cache-Control:
no-store`; only the bounded in-process cache is shared. No permissive CORS is
enabled. Browsers should use Next.js's same-origin adapter.

## Published analytics and product endpoints

The background projector publishes one validated `ChainSnapshot` per pool into
`analytics_pool_snapshots`. Pools with no publication remain in Explore with
null analytics. An indexed publication references its source batch, so a rewind
cascades to that publication. A separately verified RPC capture records its own
cutoff/evidence rather than pretending the raw indexer is caught up. Publication
jobs have their own retry/success timestamps in `analytics_pool_jobs`.

| Endpoint                                                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/explore?window=24h&sort=volume&direction=desc&limit=25&offset=0`       | All discovered pools, including unprocessed pools. Filters and global metric ordering happen before pagination. `q` matches names, symbols, token/pool addresses and launch senders. `sort` is `volume`, `change`, `launch`, or `liquidity`. `view` is `all`, `gainers`, `new`, `crowd`, or `watchlist`; watchlist `ids` accepts up to 200 comma-separated pool IDs and filters the whole corpus. Crowd returns an explicit unsupported/empty state. Missing metrics always sort last. |
| `/v1/leaderboard?window=All&minTrades=10&metric=realized&limit=25&offset=0` | One normalized wallet per row, with realized/net/unrealized values, wins/losses, ROI, trade counts, supported/excluded position counts, last activity and rank. `metric` can be `realized` or `net`. The minimum trade gate uses supported trades across pools, not per-pool gates. Ranking happens before pagination. With `MARKET_SOURCE=ledger` the board is the top 100 per window from the ledger's windows and nothing beyond: `total` is at most 100, `nextOffset` is null once 100 rows are reachable, `offset` plus `limit` past 100 answers 400 `invalid_offset`, and `unrealizedWei` is null on every row (see "The trader leaderboard" in `docs/LEDGER-MARKET-SERVING.md`). |
| `/v1/creators?window=All&sort=launches&direction=desc&limit=25&offset=0`    | One launch transaction sender per row, a top-100-per-window-and-sort leaderboard over the whole discovered catalog, described under "Creators aggregate": `launches`, `measured`, `traded`, exact `volumeWei` and `medianVolumeWei`, `bestLaunch` and `boughtOwnLaunch`. `sort` is `launches` (every creator), `volume` or `median` (creators with a measured launch only). Grouping and ordering happen before pagination; no rank beyond 100 is served.                                |
| `/v1/wallets/:address?window=All`                                           | Public wallet summary, bounded latest 500 recorded executions, up to 500 positions and 500 observed launches, and a sampled cumulative supported realized-PnL curve. Default rank matches the same-window, minimum-10-trade realized leaderboard used for share cards. Unknown wallets return an empty coverage-aware profile. `/v1/wallet/:address` is also accepted. With `MARKET_SOURCE=ledger` the summary is the wallet's row on the ledger's board for that window (`rank` is 1 to 100 or null, `unrealizedWei` the sum of its positions' marks), the positions are the ledger's with the window's own figures per pool, and `trades` and `curve` are empty (see "The wallet page" in `docs/LEDGER-MARKET-SERVING.md`). |
| `/v1/pools/:poolId?window=24h`                                              | Existing raw response plus `analytics`, containing the saved one-pool snapshot, audit, holder ledger, price/volume/change/liquidity stats and coverage. Null analytics means the pool has no published result yet, not zero activity.                                                                                                                                                                                                                                                  |
| `/v1/search?q=pepe&group=Tokens`                                            | Existing typed `SearchResponse`, searching all stored catalog entries, published wallets/launch senders and transaction identities. Supports indexed substring and fuzzy text through PostgreSQL pg_trgm. Exact unknown addresses/hashes produce labelled lookup links. No ENS or RPC request is made by this service.                                                                                                                                                                 |

Windows support `1h`, `6h`, `24h`, `7d`, `30d`, and `All`. Their common endpoint
is `coverage.asOf`, the latest published chain timestamp, not the current clock.
Each pool and position exposes its own older cutoff when applicable. Overview
coverage reports `catalogPools`, `processedPools`, `asOf`, `oldestAsOf`,
`generatedAt`, `complete:false`, `registryExhaustive:false`, and
`pnlScope:"supported_pool_positions_only"`. These are asynchronously published
captures, not proof of identical complete windows for every pool.
Wallet summaries additionally expose their own `asOf`, `oldestAsOf`, and
`completeWindow` so a newer unrelated pool cannot make an older wallet capture
appear current. The All selector means all observed supported history, not
complete lifetime/whole-chain profit.

Only supported positions contribute to aggregate PnL. Unknown basis, unmatched
transfers, inconsistent balances or disagreement between stored and recomputed
accounting exclude that position, while its exclusion count remains visible.
Earlier purchases are retained when computing the cost of sales within a later
window. ROI uses summed disposed cost; wins/losses describe closed inventory
cycles. Missing price marks make aggregate unrealized PnL unavailable instead
of treating missing marks as zero. Gas and separate router fees remain outside
the existing swap-amount accounting policy. Holdings/volume and PnL are distinct
measures. A pool's holder count is only reported when its published holder ledger
is complete, with ledger cutoff/proof available in pool details.
Repeated identical log identities are deduplicated before trade gates, net
flows, volume, ROI and accounting; conflicting duplicates reject the capture.
Unsupported positions expose null folded position/cost values rather than
letting a consumer accidentally display an incomplete basis as valid.
The wallet position's existing open `flags` string array can also contain
`wrapper_counterparty` or `farm_counterparty` when a retained raw transfer leg
matches the append-only positive-evidence registry for that block. These are
advisory provenance labels only. They never make a position supported, change
basis or alter a financial figure, and unknown flags must be ignored safely.

The writer publishes normalized pool, position, trade and price rows atomically
with each validated snapshot. The API filters, aggregates, ranks and paginates
these rows in PostgreSQL. Global totals do not depend on a 500-snapshot or
10,000-catalog-entry materialization limit. Regression tests compare these SQL
results with the shared `@pools/core` rules, including carried basis, excluded
positions, stale windows and integer amounts above JavaScript's safe range.
Each pool detail loads only that pool's saved snapshot, capped at 32 MiB.

Wallet summary totals and rank cover all matching stored positions. Displayed
positions, launches and executions each cap at 500 and expose
`positionsTruncated`, `launchesTruncated` and `tradesTruncated`. Individual
position realization arrays are omitted (`positionRealizationsIncluded:false`).
The curve samples interior points when needed (`curveSampled:true`), while
preserving its exact terminal realized total. Search returns up to eight results
per group with full matching counts; catalog pages never load the full catalog
into application memory. Global sorting always precedes pagination. In-process
response caching can add up to five seconds before a correction is visible.

## Creators aggregate

`GET /v1/creators` groups the whole discovered catalog by the launch
transaction's sender (`attribution:"launch_transaction_initiator"`, never a
verified creator identity or beneficiary) and pages the groups in Postgres, so
the creators page no longer reassembles them from thousands of explore rows.
It shares explore's coverage checks and 503 codes (`catalog_identity_conflict`,
`analytics_projection_pending`, `market_identity_conflict`,
`market_evidence_invalid`) and its five-second in-process cache.

Parameters: `window` (`1h`, `6h`, `24h`, `7d`, `30d`, `All`; default `All`),
`sort` (`launches` default, `volume`, `median`), `direction` (`desc` default,
`asc`), `limit` (1-100, default 25) and `offset`. This is a top-100-per-window-
and-sort leaderboard: no rank beyond 100 is ever served, so `offset` is only
valid up to `100 - limit` (0, 25, 50 and 75 all work at the default `limit=25`;
100 does not) and a request past that bound is refused rather than answered
with an empty page. Anything else is 400 `invalid_parameter`; bad values
answer `invalid_window`, `invalid_sort`, `invalid_direction`, `invalid_limit`
or `invalid_offset`.

Each row is `address` (lowercase), `launches`, `measured`, `traded`,
`volumeWei`, `medianVolumeWei`, `bestLaunch` and `boughtOwnLaunch`. A launch is measured under the
rule that gives an explore row its `stats.volumeWei`: canonical broad rollups
when the broad cutoff covers the launch and no deep publication is newer, else
the deep publication; a covered launch with no trades in the window is measured
at volume 0; a launch with neither source, or whose broad summaries carry
unsupported swap signs, is unmeasured. So `measured` is the creator's share of
`/v1/explore?sort=volume` and `launches` its share of `sort=launch`, in any
window. `launches` counts every discovered launch by the sender; `measured`,
`traded` (measured launches with at least one observed trade in the window),
`volumeWei` (sum), `medianVolumeWei`, `bestLaunch` and `boughtOwnLaunch` come
from measured launches only, and an unmeasured launch counts in `launches` and
nowhere else. The response repeats this rule as `note` and lists those six
fields as `measuredFigures`. `volumeWei` and `medianVolumeWei` are exact integer wei
strings, null when `measured` is 0; the median of an even count is the floor of
the two middle values' mean, computed as SQL numeric, never a float percentile.
`bestLaunch` is the measured launch with the highest window volume (lowest pool
id on ties) as a `CatalogPool` plus its `volumeWei`, or null. `boughtOwnLaunch`
is sender-routed evidence: true when a measured launch's selected source holds
a buy whose transaction sender is the creator's address, anywhere in that
source's covered history (broad swaps at or below the served cutoff, or the
deep publication's trades), false when the measured launches show none, null
without a measured launch. It is not windowed, and a transaction sender is an
initiator, not a proven beneficiary. A creator-fee flag is not served here:
the catalog column that holds it (`indexed_pools.creator_fees`, migration 021,
which the pool route serves as `market.creatorFees` with a ledger market) is
not yet read by this route.

Under `MARKET_SOURCE=ledger` (`docs/LEDGER-MARKET-SERVING.md`, "The
creators aggregate") the rule follows explore's: a launch the aggregate
ledger covers is measured from its pool hours and state, so `measured` stays
the creator's share of `/v1/explore?sort=volume` under either source, and its
`boughtOwnLaunch` evidence is the ledger's attributed position (`buys > 0`
for the sender in that pool) rather than a transaction sender; `note` states
the rule in force. Every other launch, the response shape, the order and the
Launches column are unchanged.

`sort=launches` lists every creator (launch-first, like explore's launch order)
and breaks ties on `volumeWei DESC NULLS LAST`; `volume` and `median` list only
creators with a measured launch, excluded before `total` and paging, as explore
excludes null metrics under a metric sort. `direction` applies to the primary
key and every order ends on `address ASC`. The response carries `coverage`,
`broadMarketCutoff`, `window`, `sort`, `direction`, `items`, `total` and
`nextOffset` exactly as explore does: deep figures are dated to
`coverage.asOf`, broad figures to `broadMarketCutoff.asOf`, and a window moves
volumes without changing which launches are measured. `total` is the sort's
ranked population capped at 100 (rows beyond rank 100 never appear, in any
window or sort), and `nextOffset` is null once `offset + limit` reaches 100
even when the real population is larger.

When the aggregate ledger is selected and has folded, `coverage` is the same
ledger envelope used by the wallet and trader leaderboard routes: its cursor
time, its `agg_pool_state` count, and
`pnlScope=attributed_positions_all_pools`. `broadMarketCutoff` remains the
cutoff for the broad fallback source only, so it can still be null. Before the
ledger has folded, the legacy accounting coverage is unchanged.

The route is two ranked passes and an identity lookup. The ranking statement is
one pass over explore's whole-catalog rank (`rankedFlowCtes` in
`broad-explore.ts`, the same CTE that serves `sort=volume` and `sort=trades`)
grouped by sender with ordered-array aggregates for the median and the best
launch, then sorted and paged with `count(*) OVER ()`; it carries no `ownBuys`
column. A second statement runs that same rank restricted to the page's launch
senders, with `ownBuys` naming them, and answers
`bool_or(own) FILTER (WHERE volume IS NOT NULL)` per sender, so own-buy
evidence is derived for the creators the page serves and no others: deep
evidence rides that statement's own deep-trades scan, broad evidence is one
hash semi-join over `broad_swaps` for those senders, and a ledger-covered
launch is one `agg_positions` probe per launch of those senders. No order this
route offers reads the flag, so the page is the same page either way, and both
statements read one snapshot inside the reader's `REPEATABLE READ` transaction.
The page's best launches are then looked up by primary key. Like explore both
ranked statements run with `jit = off`, because the planner prices the rank's
per-launch coverage subplan far above `jit_optimize_above_cost` while each
executes in well under a second. On the production-shaped copy (62,393
launches, 25,718 senders, 1,364 deep publications, 1,853 broad summaries,
165,417 broad swaps; Postgres 18) the ranking statement is the shape measured
at 94-111 ms for every sort, first and last page, with a sub-millisecond
identity lookup; the whole-catalog own-buy join that took the same statement to
131-157 ms there is no longer part of it. The cold and warm cost of
the split under `MARKET_SOURCE=ledger` is recorded in
`docs/LEDGER-MARKET-SERVING.md` ("The creators aggregate"): 351-906 ms cold and
211-411 ms warm over every window and sort, the two statements 284 ms and
457 ms of a cold 842 ms. The 52k-launch serial scale phase
(`broad-explore.scale.test.ts`) bounds each variant at 2,000 ms and prints a
`52k creators serving` line.

## Token icon store

`GET` or `HEAD /v1/pools/:poolId/image` serves the catalog's creator image for
one pool as a 128 px WebP, encoded once and kept in the `token_images` table
(migration `015_token_images.sql`; `/ready` checks access to it). The first
view of a pool runs the shared `@pools/token-image` policy inside the request:
exact host allowlist, DNS answers checked against private-address block lists
and pinned, HTTPS only, 2 MiB and 4-megapixel caps, content-type and magic-byte
checks, Sharp decode and WebP re-encode. The bytes, their SHA-256 and the
catalog `image_url` they came from are then stored and every later view is a
primary-key read. A request is the only trigger: nothing prefetches, warms or
sweeps the 62k-pool catalog. A changed catalog `image_url` re-encodes on the
pool's next view. Any query string is rejected with 400 `invalid_parameter`.

Responses:

- `200` with `Content-Type: image/webp`, `Content-Length`, a strong `ETag`
  (the content hash), `nosniff`, a restrictive CSP and
  `Cache-Control: public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800`.
  `If-None-Match` matching the ETag returns `304` with the same validators.
- `404` JSON, cacheable for as long as the store itself will not retry:
  `{error:"pool_not_indexed"}` (300 s); `{error:"image_unavailable",reason}`
  with reason `no_source` or `source_rejected` (host or URL outside the policy,
  86400 s) or `dns_rejected`, `fetch_rejected`, `decode_rejected` (transient:
  300 s, doubling per consecutive failure of the same source up to 86400 s) or
  `timeout` (same doubling, capped far short of a day since a deadline expiry
  only proves this one fetch was slow, not that the source is broken). A
  stored `source_rejected` row is re-checked by the pure URL policy on each
  view, so widening the allowlist takes effect without a sweep. The website
  keeps its generated icon on any 404.
- `503 {error:"busy"}` with `Retry-After: 5` and `no-store` when the process's
  fetch slots and their waiting line are full, or when more than 64 image
  requests are in flight; `429` with `Retry-After` from the route's own
  1,200 requests/minute budget, separate from the JSON read budget.

Variables, all optional:

| Variable                               | Default | Meaning                                                                                                                |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_IMAGE_DEADLINE_MS`              | `10000` | Upstream budget per attempt (DNS, download, decode, encode) once a fetch slot is held. 500-10000.                      |
| `TOKEN_IMAGE_CONCURRENCY`              | `8`     | Concurrent upstream fetches per process; four times as many may wait in line. 1-32.                                    |
| `TOKEN_IMAGE_RETRY_SECONDS`            | `300`   | First negative lifetime after a transient failure. 5-86400.                                                            |
| `TOKEN_IMAGE_REJECTED_SECONDS`         | `86400` | Negative lifetime for policy rejections and the ceiling of the transient backoff. 60-2592000.                          |
| `TOKEN_IMAGE_REQUEST_CAP_MS`           | `12000` | Ceiling on one request's total time (queueing for a slot plus the fetch), regardless of the deadline above. 500-30000. |
| `TOKEN_IMAGE_TIMEOUT_REJECTED_SECONDS` | `3600`  | Backoff ceiling for a bare deadline expiry, shorter than `TOKEN_IMAGE_REJECTED_SECONDS`. 60-86400.                     |

The store is a `bytea` column rather than a volume or object store: it needs no
deployment change, survives rolling deploys, and the whole catalog is about
180 MB at roughly 3 KB per icon. A failed store write after a successful encode
still serves the image and logs `token_image_store_failed`; the next view
encodes again. Rows carry no batch linkage and are never joined into
accounting or evidence reads.

## Recent trade stream

`GET /v1/live-trades` returns the latest 50 saved swaps across verified Pools
markets. `?poolId=0x...` optionally restricts the same bounded window to one pool.
No other parameters or unbounded pagination are accepted. This requires migration
`004_recent_activity.sql` and SELECT access to its recent tables before the new
API version is deployed. `/ready` checks that access. The existing historical
`/v1/feed` and PnL captures keep their separate meaning.

The shared `LiveTradeFeedResponse` type in `@pools/core` defines the response:

- `source: "indexed_recent_chain_events"`, `generatedAt` (ISO), `poolId`,
  `replacement: true`, `events`, and `truncated`.
- Each event includes stable `id: "transactionHash:logIndex"`, pool/token identity,
  name/symbol, verified `launchTx`, transaction hash/log index, canonical block
  number/hash/time, `side`, exact positive `ethWei`/`tokenRaw` integer strings,
  and `transactionInitiator` with `attribution: "transaction_initiator_only"`.
  Raw token amounts are not formatted using assumed decimals.
- Coverage includes `state: "uninitialized" | "current" | "stale"`, saved
  `startBlock`, `throughBlock`, `throughHash`, `asOf` (Unix seconds), the worker's
  last observed `headBlock` and `checkedAt` (ISO), `lagBlocks`, discovery cutoff
  and lag, `knownPools`, and `staleAfterSeconds: 120`. Missing evidence is null.
  Current requires recent successful head checks and recent chain cutoff/header
  times for both discovery and swap streams. This allows the worker's deliberate
  confirmation delay; the precise lag is still visible. A stalled chain or
  stalled worker becomes stale even if the last trade was recent.

An uninitialized recent stream returns 200 with an empty replacement window and
explicit state. It never substitutes older historical events. A quiet but
caught-up pool also returns an empty window, with current header coverage.
Stale saved rows remain inspectable and explicitly labelled stale. These are
observations within the recent worker's saved range, not complete lifetime
history or new evidence for PnL. `registryExhaustive` and `pnlAvailable` are false.

Poll every 15 seconds while visible. Replace the entire prior event array on each
successful response, even when empty or the cutoff moves backward. Never merge
old rows across a rewind. This route has no response cache; concurrent identical
requests can still share one read. Each read obtains rows and checkpoints in one
repeatable-read transaction. Batch deletion cascades invalidated swaps, so the
next poll reflects the canonical replacement. Ordinary API request limits still
apply, and no RPC request runs on an API read.

The product/raw catalog combines `indexed_pools` and `recent_pools`. Matching
identities appear once; conflicting token/launch identities fail closed with
`catalog_identity_conflict`. A recently discovered pool immediately becomes
searchable and navigable with null analytics until a separate historical capture
is published. Raw historical coverage stays null for a recent-only launch.
Changes or rewinds in recent membership invalidate the product-model cache;
ordinary catalog response caching can still add up to five seconds of delay.

## Explorer wallet history (Blockscout)

`GET /v1/wallets/:address/history?kind=transactions|token-transfers&cursor=`
serves one page of a wallet's complete on-chain activity on demand from the
Blockscout PRO API (`https://api.blockscout.com/4663/api/v2`, the chain's
official explorer). This is display data only: it never joins accounting or
PnL tables, carries no evidence, and is not mixed into any verified figure. The
indexed `/v1/wallets/:address/activity` route keeps serving our own verified
activity unchanged. Blockscout returns 50 items per page, newest first, and
this service reads no database table on this route.

The response is the shared `WalletHistoryResponse` type in `@pools/core`:
`source:"blockscout"`, `chainId:4663`, `wallet` (lowercase), `kind`, `items`,
`nextCursor` (opaque, null at the end), `fetchedAt` (ISO), `stale`, and a fixed
`note`. A transaction item has `hash`, `block` (number, null while pending),
`timestamp` (Unix seconds, null while pending), `from`, `to` (null for contract
creation), `method` (decoded name, 4-byte selector, or null), `status`
(`ok`, `error`, or `pending`), `value` and `fee` (wei as decimal strings, fee
null while pending). A token transfer item has `transactionHash`, `logIndex`,
`block`, `timestamp`, `from`, `to`, `token` (`address`, `symbol`, `name`,
`decimals`, `type`, each nullable except the address), `value` (raw integer
string, null for ERC-721), `tokenId` (null for ERC-20), and `method`. Transfer
logs exist only in successful transactions, so they carry no status. Addresses
and hashes are lowercase. Cursors bind to the wallet and kind, wrap Blockscout's
own `next_page_params`, and are validated before they reach the explorer.

Configuration, read from the environment at startup:

| Variable                            | Default  | Meaning                                                                                                         |
| ----------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `BLOCKSCOUT_API_KEY`                | unset    | Free-tier PRO key, sent only as a Bearer header. Absent: the route answers 503 `not_configured`, all else runs. |
| `BLOCKSCOUT_DAILY_CREDIT_CAP`       | `30000`  | Credits this process may spend per UTC day (20 per transactions page, 30 per token-transfers page).             |
| `BLOCKSCOUT_FIRST_PAGE_TTL_SECONDS` | `30`     | Freshness of a wallet's first page, which changes as the wallet acts.                                           |
| `BLOCKSCOUT_PAGE_TTL_SECONDS`       | `600`    | Freshness of deeper pages, which are effectively immutable history.                                             |
| `BLOCKSCOUT_API_URL`                | PRO host | Base URL override for tests only; request input can never change it.                                            |

Budget and failure behaviour. Every upstream call passes a sliding-window
limiter (at most five starts in any second, the free tier's rate; a call that
would wait longer than two seconds fails instead of queueing) and a per-process
credit counter that resets at UTC midnight. The explorer's `x-credits-remaining`
header is a backstop: when the key itself is nearly out, calls pause for an
hour regardless of the local count. The counter is per process: during a
Railway rolling deploy the old and new instance each keep their own, so the
day's real spend can briefly count from zero again; the default cap of 30,000
keeps three process lifetimes in one day (two such deploys) inside the 100,000
daily allowance, and the header backstop covers anything beyond. Upstream
calls time out after 12 seconds (Blockscout PRO answers a wallet page in
2.0-4.6 s from Railway; the timeout leaves headroom above that observed range)
and bodies above 4 MiB are rejected. There is no retry. Pages are cached in process by wallet, kind, and cursor (2,000 entries,
32 MiB); a page past its TTL is still served with `stale:true` for up to a day
whenever the explorer or the budget cannot answer, otherwise the route returns
503 `{error:"wallet_history_unavailable", reason}` with `Retry-After`, where
`reason` is `not_configured`, `budget_exhausted` (seconds to UTC midnight),
`upstream_unavailable` (timeouts, 429, 5xx, or an unreadable page), or
`key_rejected` (401, 402, or 403 from the explorer). Ordinary request limits
and coalescing apply, the key never appears in any response or log line, and
the route makes no chain RPC call.

## ETH/USD spot price

`GET /v1/prices/eth-usd` serves one number for the frontend's unit toggle and
status strip: Coinbase's public, keyless spot price
(`https://api.coinbase.com/v2/prices/ETH-USD/spot`, `data.amount` parsed as a
decimal string). No API key, no chain call, no accounting join; this is market
context, not evidence. Any query string is rejected with 400
`invalid_parameter`.

The response is the shared `EthPriceResponse` type in `@pools/core`:
`usdPerEth` (number), `asOf` (ISO 8601 UTC of the Coinbase fetch, not of the
request), and `source:"coinbase"`. `200` responses carry
`Cache-Control: public, max-age=60, stale-while-revalidate=540`, so browsers
and the web proxy share the same 60 s fresh / 10-minute stale window as the
server's own cache below.

The service (`apps/api/src/eth-price.ts`) holds one in-process cache entry.
A request under 60 s old is served from cache with no network call. Past
60 s and under 10 minutes it still serves that cached value immediately and,
at most once per 60 s, kicks off a single background refresh (concurrent
stale reads share the one in-flight fetch rather than starting their own).
Only when nothing has ever been cached, or the cached value has passed 10
minutes, does a request wait on the network itself, bounded by a 5 s
deadline, and only then can it fail: `503 {error:"price_unavailable"}` with
`Retry-After: 30`, itself rate-limited so a sustained outage draws at most one
upstream attempt per minute. A malformed, non-finite, zero, or negative amount
is treated the same as an upstream failure. Ordinary request limits apply;
there is no separate budget for this route.
