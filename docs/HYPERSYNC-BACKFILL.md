# HyperSync swap-history backfill

The complete registered-swap history (tier 2 for every pool) comes from Envio
HyperSync on its free tier, into the schema, accounting and evidence policy
that already exist. Nothing here resumes the indexer, changes Railway, or
touches Alchemy. The backfill is a manual, bounded command that is off unless
two variables are set, and it has not been run against production: that waits
for the captain's word.

Sources read on 2026-09-16: the HyperSync query model and limits
(<https://docs.envio.dev/docs/HyperSync/hypersync-query>,
<https://docs.envio.dev/docs/HyperSync/hypersync-usage>), API tokens
(<https://docs.envio.dev/docs/HyperSync/api-tokens>, required since
3 November 2025), the network list
(<https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks>, chain
4663 at `https://4663.hypersync.xyz`), the curl examples for the JSON endpoint,
and the client list (<https://docs.envio.dev/docs/HyperSync/hypersync-clients>).

## Design note

### Transport

`packages/chain/src/hypersync.ts` is a plain HTTP client for the documented
JSON endpoint (`POST /query`, `GET /height`) with `Authorization: Bearer
<ENVIO_API_TOKEN>`. The official TypeScript client was not adopted: it is a
native (napi) binary per platform, which the pnpm lockfile discipline, the
`allowBuilds` list and the indexer's Debian image would all have to grow for,
while the JSON endpoint is documented, small and testable with a fake `fetch`
like the existing `Rpc` class. Every request is paced (`minIntervalMs`, one
per second by default), bounded (per-run request budget, 30-second request
timeout, 32 MiB streamed body cap, 20,000 rows per table per response),
retried at most four times with exponential backoff (HTTP 429 honours
`Retry-After`; 5xx and network errors back off; 401/403/413 and other 4xx fail
immediately), and never busy-loops.

Two selections are built: PoolManager `Swap` logs with an optional list of
pool ids in `topics[1]` (chunked at 10,000 ids per selection, two selections
per query, so a larger registry spans several queries), and ERC-20 `Transfer`
logs by token-address list for tier-3 evidence. Each row is validated against
the recorded encodings before anything else looks at it. Query results page by
`next_block`; a page is never split, so every batch ends on a complete block.

### Mapping onto the existing tables and streams

HyperSync rows land in the existing tier-2 stream `swaps:broad:v1` and its
tables (`indexer_batches`, `broad_batches`, `broad_registry_members`,
`broad_swaps`), through the existing `commitPoolGroup({ mode: "broad" })`
transaction. The backfill is the data source the broad worker was designed
around (Phase B), with HyperSync replacing Alchemy. There is no new stream key
and no migration, for three reasons that the schema settles:

- `broad_swaps` is keyed on `(chain_id, tx_hash, log_index)`, so two streams
  cannot both hold the same history; a second key would need a schema change
  and would leave every reader (observed market, tier-2 read, explore rollups)
  choosing between two sources.
- `indexer_streams` allows exactly one `broad` stream (`broad_stream_key`
  check in migration 010).
- The stream already carries the cursor, the content-hashed batches, the
  discovery:v2 registry pin and the reorg rules the captain asked to keep.

Every batch pins the nearest discovery:v2 checkpoint at or above its end
(`broadRangeCheckpoint`), resolves every observed pool id against that pinned
registry, and the writer re-resolves every observed id again inside the commit
transaction. `discovery:v1` is never read or written. The backfill runs under
the main writer lock (`pg_try_advisory_lock(4663, 19002)`), so it cannot run
beside the Railway indexer; it refuses when the lock is held.

### The transaction-shaped evidence variant

A HyperSync group is the same `BroadPoolEventGroup` as the receipt-shaped
collector produces: the same swap rows (pool, token, hash, index, block, block
hash, timestamp, transaction initiator, manager sender, signed amounts,
price/liquidity/tick/fee, side, exact wei, `supported=false` with the existing
flags), the same counts (`observedSwaps`, `unregisteredSwaps`,
`unsupportedSwaps`), the same boundaries (`fromBlockParentHash`, cutoff hash
and timestamp) and the same registry pin. Only `evidence` differs, and it is
self-describing:

```
evidence: {
  source: "hypersync", schemaVersion: 1, url,
  query,                      // the exact first-page body; later pages differ only in from_block
  pages: [{ fromBlock, nextBlock, archiveHeight, totalExecutionTime, rollbackGuard, logs, transactions, blocks, bytes }],
  logs,                       // the registered Swap logs, verbatim selected fields
  transactions,               // their transactions (hash, from, to, status, block), one per hash, sorted
  blocks,                     // blocks of those logs plus the from, to and registry boundary headers
  unregistered: { swaps, poolIds }  // count and distinct topics[1] of manager swaps outside the registry
}
```

`serialized_group` in `broad_batches` retains these bytes once; `content_hash`
in `indexer_batches` is their SHA-256, exactly as for the receipt variant, and
`broad_swaps` rows carry the foreign key to the batch. Replay of an identical
batch is a no-op; a different content for the same range is refused. Before
any write, `verifyHyperSyncBroadGroup` re-derives every row, count and
boundary from the retained rows with no network and rejects any difference;
the writer additionally re-resolves the observed ids (registered and
unregistered alike) against the pinned registry, so a registered pool claimed
as unregistered is refused.

Two deliberate differences from the receipt variant, both documented in the
retained evidence: unregistered manager swaps are kept as their distinct pool
ids and a count rather than as full logs (no reader uses those rows, and at
about 89 percent of manager swaps they would dominate storage), and there is
no `tokenUnits` observation (HyperSync serves no state reads; see decimals
below).

### Dedupe, reorgs and the live worker's window

Duplicate legs keep the existing rule: identity is `(txHash, logIndex)`, the
same identity twice in one response is rejected, and `broad_swaps`'s primary
key plus the content-hashed batch make a re-run idempotent. Two legs of one
transaction have distinct log indexes and both are stored.

HyperSync returns canonical data only and each response is internally
consistent, so the backfill stops a safe distance below the provider's own
height: every range ends at most at `archive_height - 128` (checked on the
`/height` read and again on every page's `archive_height`), and never beyond
the discovery:v2 cursor. Before each batch the saved cursor's block hash is
read back from HyperSync; if it no longer matches, the stream walks its saved
checkpoints back to the newest canonical one and rewinds to it, exactly like
the broad worker. Boundaries (`from`, `to`, the registry block) are read again
after collection, so a change during collection fails the batch before any
write. Because every broad batch pins a discovery checkpoint at or above its
own end, a reorg that touches a broad cursor also touches its pinned discovery
checkpoint; the discovery worker's own reconciliation then cascades the
dependent broad batches (migration 010's trigger), and the backfill waits with
"Broad registry boundary changed" rather than pinning a newer tip. The
integration test covers that sequence.

The live worker's window is a different table (`recent_swaps`) with its own
reconciliation; the readers already reconcile recent copies against broad rows
by `(tx_hash, log_index)` and refuse conflicts. The live worker can read the tip
from HyperSync too, through the same client (`RECENT_SOURCE=hypersync`,
[HYPERSYNC-TIP.md](HYPERSYNC-TIP.md)). The backfill never writes
`recent_*`, and it never runs while the indexer holds the writer lock.

### Decimals and poolId verification

The registry the backfill filters against is the discovery:v2 catalogue, whose
`decodeLaunch` recomputes each poolId from the PoolKey and verifies it against
the emitted id before a pool is registered; a swap is kept only when its
`topics[1]` resolves to such a pool and its block is not before the pool's
verified launch block. Amounts are integer-exact decimal strings and
PostgreSQL `numeric` with scale 0; `eth_wei` and `token_raw` follow the same
sign rule as the receipt path, so the DB checks on `broad_swaps` hold.

Decimals cannot be observed from HyperSync (it serves logs, transactions and
blocks, not `eth_call`), so a HyperSync batch records no `broad_token_units`
row. The existing reader rule applies unchanged: the latest surviving
canonical units observation at or before the market cutoff sets the display
scale, and missing units never default to 18. Accounting is unaffected, since
it is in wei and raw token units. A units observation for every registered
token at one canonical cutoff (the Multicall3 variant from the cost-fixes
work) is the way to give backfilled pools a display scale, and that is a
separate change.

### What is wired and what is not

Wired: the transport, the tier-2 broad group collector and verifier, the
commit-path dispatch on the evidence variant, and the backfill command. Built
and tested but not wired to a writer: the tier-3 Transfer collector
(`collectHyperSyncTransfers`). The pool-stream writer that the analytics
projector reads is receipt-shaped by contract (`projectAnalytics` re-verifies
each log against `receipt.logs`), so feeding pool streams from HyperSync needs
the projector to accept a transaction-shaped variant. That change belongs with
the deep-tier decision (D4) and the cost-fixes work on the projector, not here.

## The command

```
pnpm hypersync:plan   # dry run: saved cursor, discovery coverage, archive height, one page, estimates; no writes, no lock
pnpm hypersync:run    # bounded run under the writer lock; commits at most HYPERSYNC_MAX_BATCHES batches
```

Both refuse unless `HYPERSYNC_BACKFILL_ENABLED=1` and `ENVIO_API_TOKEN` are
set. `HYPERSYNC_URL` defaults to `https://4663.hypersync.xyz`. Caps, all per
run unless noted: `HYPERSYNC_BATCH_BLOCKS` (per batch, at most 9,999),
`HYPERSYNC_MAX_PAGES` (whole pages per batch, at most 16),
`HYPERSYNC_MAX_BATCHES`, `HYPERSYNC_MAX_BLOCKS`, `HYPERSYNC_MAX_REQUESTS`,
`HYPERSYNC_MIN_INTERVAL_MS`. Per batch the schema caps also hold: 10,000
observed manager swaps and 16 MiB of retained evidence. A run stops at the
first of: its caps, the archive height minus 128, or the end of discovery
coverage. Every batch commits or fails alone, so a stopped run resumes from
the saved cursor. The indexer service never starts it.

The command a captain-approved production backfill would use, from a machine
with `DATABASE_URL` pointing at the Railway Postgres while the indexer stays
stopped:

```
HYPERSYNC_BACKFILL_ENABLED=1 HYPERSYNC_MAX_BATCHES=10000 HYPERSYNC_MAX_BLOCKS=42000000 \
HYPERSYNC_MAX_REQUESTS=200000 HYPERSYNC_MIN_INTERVAL_MS=1000 pnpm hypersync:run
```

Estimated request count from the study's floor of 8.6M registered swaps: the
broad stream needs every manager swap, and 89.34 percent of observed swaps
were unregistered at collection, so about 80M manager swaps at the floor. At
5,000 logs per page that is about 16,100 pages; at 10,000 observed swaps per
batch about 8,100 batches, each with up to seven one-block header reads, so
about 73,000 requests at the floor, roughly 20 hours at one request per
second. The recorded 10,000-block probe inside the launch period returned 3.6
manager swaps per block, so the true total is higher than the floor; the plan
command reports the density of the first page it reads and scales from it.

## Bounded live verification (done 2026-09-16, 02:24 to 02:25 UTC)

Two `/height` reads (keyless 200 in 4.7 s cold, with the token 200 in 153 ms;
height 64,148,377) and seven `/query` requests with the captain's token, all
over 20 blocks from 62,688,988. The four small responses and their exact
requests are the recorded fixtures under
`packages/chain/src/fixtures/hypersync/` (provenance in its README). Proven:
the query shape; the log-to-transaction join (`from`, `status`) and the block
join (`timestamp`) in one response; the registered-pool `topics[1]` filter
(the 4-id query returned exactly the 5 logs the unfiltered query held for
those ids); the selection-size limit (2 MiB request body: 10,000 ids accepted,
62,265 rejected with 413); paging by `next_block` (a 10,000-block query
returned 4,754 logs over 1,321 blocks, 5.9 MB, in 525 ms); and one-block
header reads. Not run: the backfill itself.

Still unverified: the free tier's sustained request rate (the token showed a
temporary "boosted" allowance that this design does not plan around), the
true full-history swap count, and behaviour at the chain tip (`rollback_guard`
was null this far below the archive height; the backfill does not rely on it).

## Blockscout beside the index

Blockscout is the chain's official explorer from block one; its PRO API at
`https://api.blockscout.com/4663/api/v2/...` takes one free key (Bearer or
`?apikey=`) at 5 requests per second and 100,000 credits per day, 20 credits
per call by default, 30 for logs and token transfers, 40 for internal
transactions (<https://docs.blockscout.com/robinhood-api>,
<https://docs.blockscout.com/rate-limits>, read 2026-09-16; endpoint index
from Blockscout's own agent skill). At zero cost it could take over from our
index, beyond the wallet pages already recommended:

| Need                                       | Endpoint                                                                                      |           Credits | Serves                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------: | ------------------------------------------------------------------------------------- |
| every transaction of a wallet              | `GET /4663/api/v2/addresses/{address}/transactions`                                           |                20 | the "all of their txns" page, 50 per page                                             |
| a wallet's token transfers (ERC-20 filter) | `GET /4663/api/v2/addresses/{address}/token-transfers`                                        |                30 | transfer-in detection for one wallet on demand                                        |
| a wallet's logs, an address's logs         | `GET /4663/api/v2/addresses/{address}/logs`                                                   |                30 | per-wallet or per-contract event views                                                |
| one transaction decoded                    | `GET /4663/api/v2/transactions/{hash}`, `/logs`, `/token-transfers`, `/internal-transactions` | 20 / 30 / 30 / 40 | the trade-share and transaction detail pages, sell proceeds via internal transactions |
| token holders and counters                 | `GET /4663/api/v2/tokens/{address}/holders`, `/counters`                                      |                20 | holder lists for pools without tier-3 coverage                                        |
| contract state at a block                  | `POST /4663/json-rpc` (`eth_call`)                                                            |                20 | `decimals()`, `totalSupply()`, `balanceOf()` reads without an Alchemy key             |

A wallet page would cache one address's transaction and transfer pages for a
short time (the per-address list is 50 rows per page, so a busy wallet is
several calls) and the per-transaction detail indefinitely. What Blockscout
cannot take over: the leaderboard (no ranked-wallets endpoint), verified PnL
(needs our Swap accounting and Transfer evidence), and the bulk swap history
(the PoolManager logs endpoint pages 50 rows at 30 credits, so 8.6M swaps is
about 172,000 calls and 52 days of the free allowance).
