# Indexed chain read API

This small Node service reads public chain evidence from the private Railway
Postgres database. It makes no RPC calls and writes no account/profile data.
Product endpoints aggregate the published, supported pool positions using the
same exact average-cost rules as the frontend. Indexer migrations, evidence
verification, holder reconstruction and publication remain separate.

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
`analytics_pool_snapshots`,
plus schema USAGE. Even when using the existing connection initially, all API
transactions explicitly run READ ONLY. Database roles are infrastructure
permissions and are unrelated to user accounts.

Deploy the indexer first so its pre-deploy migration applies
`002_read_indexes.sql` and `003_analytics.sql` before exposing the growing event history. The API has
no migration privileges or startup migration command.

No deployment is implied by these files. The website must be explicitly wired
to this service after deployment and data validation.

## HTTP contract

Only GET and HEAD are supported. Unknown/duplicate query parameters are rejected.
Pool IDs are 32-byte `0x` hex values; wallet/token addresses are 20-byte hex
values. Addresses are normalized to lowercase. Amounts, block heights, and
on-chain timestamps remain decimal strings in ordinary endpoints; `logIndex`
and chain ID are numbers. The feed has the existing `RecentSwaps` numeric
block/timestamp contract, with safe-integer validation for its boundaries.

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
| `/v1/leaderboard?window=All&minTrades=10&metric=realized&limit=25&offset=0` | One normalized wallet per row, with realized/net/unrealized values, wins/losses, ROI, trade counts, supported/excluded position counts, last activity and rank. `metric` can be `realized` or `net`. The minimum trade gate uses supported trades across pools, not per-pool gates. Ranking happens before pagination.                                                                                                                                                                 |
| `/v1/wallets/:address?window=All`                                           | Public wallet summary, all available positions, bounded latest 500 recorded executions, cumulative supported realized-PnL curve and observed launches. Default rank matches the same-window, minimum-10-trade realized leaderboard used for share cards. Unknown wallets return an empty coverage-aware profile. `/v1/wallet/:address` is also accepted.                                                                                                                               |
| `/v1/pools/:poolId?window=24h`                                              | Existing raw response plus `analytics`, containing the saved one-pool snapshot, audit, holder ledger, price/volume/change/liquidity stats and coverage. Null analytics means the pool has no published result yet, not zero activity.                                                                                                                                                                                                                                                  |
| `/v1/search?q=pepe&group=Tokens`                                            | Existing typed `SearchResponse`, searching all stored catalog entries, published wallets/launch senders and transaction identities. Supports fuzzy text through the shared provider. Exact unknown addresses/hashes produce labelled lookup links. No ENS or RPC request is made by this service.                                                                                                                                                                                      |

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

The shared pure functions in `@pools/core` provide the same fallback and hosted
calculations. The API loads and caches a complete product read model for 15
seconds, grouping audits by wallet and memoizing window calculations. Global
sorting never happens on an already-paginated page. This bounded pilot supports
10,000 catalog pools, 500 published captures, and 32 MiB of snapshot/holder JSON.
Exceeding those limits returns `analytics_materialization_limit` (503), not a
silently truncated leaderboard. Larger corpora should publish relational
position/stat summaries before increasing the limits. In-process response
caching can add up to another five seconds before a corrected publication is
visible.
