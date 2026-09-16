# HyperSync at the tip: the live worker's Envio source

The live worker (`apps/indexer/src/recent-main.ts`, the `recent_*` tables that
serve the live trade feed) can read the chain from Envio HyperSync instead of
the JSON-RPC provider. One environment variable selects the source:
`RECENT_SOURCE=rpc` (the default, unchanged behaviour) or
`RECENT_SOURCE=hypersync`. Merging this changes nothing in production; the
switch is the captain's.

Why: at the 16 Sep 2026 volume of about 29,500 registered swaps per hour, the
JSON-RPC cycle pays a receipt and a header per registered swap, about 1.0M
Alchemy CU per hour for the live feed alone, and an hour of downtime cost
845,948 CU to catch up (receipts 456,560, headers 376,380, getCode 59,960).
On HyperSync the live worker pays no receipt, header or log call to Alchemy,
at the tip or while catching up.

It reuses the transport from the backfill (`packages/chain/src/hypersync.ts`,
[HYPERSYNC-BACKFILL.md](HYPERSYNC-BACKFILL.md)) and the recent writer
(`commitRecentBatch`); there is no second HyperSync layer and no new stream.

## One cycle

`runRecentHyperSyncCycle` in `apps/indexer/src/recent-worker.ts` keeps the
JSON-RPC cycle's order, cursors and rules and moves only the reads:

1. `GET /height` is the head. `observeRecentHead` stores it with the head
   block's timestamp, read with a one-block `include_all_blocks` query.
2. Reconcile both lanes exactly as before: read the saved cursor's hash from
   HyperSync (one read serves both lanes when they share a cursor) and, if it
   no longer matches, walk the 256 saved checkpoints back to the newest one
   that still does and rewind (a discovery rewind also rewinds swaps).
3. The range is the one the JSON-RPC cycle would take: from the lagging cursor,
   at most `RECENT_BATCH_BLOCKS` (default 2,000 here, the writer's bound), never
   past `height - 128`, and never past discovery for the swap lane.
4. One paged query (`recentLogQuery`) serves both lanes. It selects PoolManager
   `Swap` logs, strategy `TokenLaunched` and factory `TokenCreated` logs, and
   every log of the launchers, joined to their transactions, with
   `include_all_blocks` so every block of the range arrives with the page.
   Pages are consumed whole (`collectRecentPages`, at most
   `RECENT_HYPERSYNC_MAX_PAGES`, default 4), so a dense range ends early on a
   block boundary instead of failing. Every block of the consumed range must
   form one parent-linked chain with non-decreasing timestamps, and every
   returned log must belong to exactly one of the three selections.
5. Discovery lane: `recentLaunchesFromPages` verifies each launch (strategy,
   deployment block, PoolKey and pool id through `decodeLaunch`, a launcher log
   in the same successful transaction, factory metadata matched to the token)
   and reads name and symbol through Multicall3 at the cutoff. That is the only
   JSON-RPC read, and only when the range holds a launch. The batch commits
   first, so a swap in a pool launched in the same range is registered.
6. Swap lane: `recentSwapsFromPages` resolves only the observed pool ids against
   the registry (`knownRecentPools`), keeps registered swaps with their
   transaction and block, and counts the rest.
7. Both batches commit through `commitRecentBatch`, which re-derives every row
   from the retained HyperSync evidence inside the commit (below).

At the confirmed tip with no new block, a cycle is three HyperSync requests:
height, head header, cursor header. A cycle with new blocks adds its pages.

## Confirmation and reorgs

The 128-block buffer is unchanged and is measured against HyperSync's archive
height: the range end must sit at least 128 below the height read at the start
of the cycle and below every page's `archive_height`. A page whose archive
height is absent, null or inside the buffer fails the cycle, and a literal
`false` is rejected as an invalid envelope; nothing defaults a missing height to
confirmed (tests: `hypersync-recent.test.ts`, "confirmation and canonical-chain
checks fail closed").

HyperSync serves canonical data only, so a reorg shows up as changed hashes,
never as `removed` logs. It is detected three ways, the first being the
existing path:

- Every cycle re-reads the saved cursor's block hash from HyperSync; on a
  mismatch the saved checkpoints are walked back to a matching ancestor and
  both lanes rewind in one transaction (`rewindRecent`), after which the same
  cycle recollects from the ancestor.
- Every commit checks that the first block's parent hash equals the saved
  cursor hash (`Noncontiguous recent checkpoint` otherwise), so a reorg between
  the reconcile and the commit fails the batch; the next cycle reconciles.
- Within a cycle, every block of the range is checked against its predecessor
  in memory, and every retained log must match its block's hash and its
  transaction's block hash and number.

`rollback_guard` is not relied on. It was null 2,800 blocks below the archive
height and present on the head block in the live check below.

The reorg replay is `apps/indexer/src/recent-worker.test.ts`, "HyperSync
source": a fork below the saved cursor replaces a committed transaction; the
cycle reads the cursor, finds checkpoint `base + 10599` still canonical,
rewinds both lanes, recollects, and the replaced row and the new block hashes
are what remain.

## Evidence

Batches keep the recent schema and the content hash (SHA-256 of the committed
batch JSON) and share the existing `discovery` and `swaps` streams. Provenance
is labelled twice: `recent_batches.source` (migration 016, `recent:rpc:v1` for
every earlier batch and the JSON-RPC cycle, `recent:hypersync:v1` here), and
`source: "hypersync"`, `stream: "recent:hypersync:v1"`, `schemaVersion: 1`
inside the evidence, which the hash covers. JSON-RPC batches are byte-identical
to before (they carry no `source` field), so their hashes do not change.

Where each field now comes from:

| Field                                        | JSON-RPC cycle                      | HyperSync cycle                                                       |
| -------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| swap, launch, factory metadata logs          | `eth_getLogs`                       | log rows, selections 1 and 2                                          |
| swap `transactionSender` (the initiator)     | receipt `from`                      | transaction row `from`                                                |
| launch `launchSender`                        | receipt `from`                      | transaction row `from`                                                |
| transaction success                          | receipt `status` `0x1`              | transaction row `status` 1 (HyperSync takes it from the receipt)      |
| the log belongs to that transaction          | the log is among `receipt.logs`     | the log row joins its transaction by hash, block hash and number      |
| launcher ran in the launch transaction       | a launcher log among `receipt.logs` | a launcher log row in the same transaction, selection 3               |
| block hash, parent hash, timestamp           | `eth_getBlockByNumber`              | block rows (`include_all_blocks`)                                     |
| head                                         | `eth_blockNumber`                   | `/height`                                                             |
| head timestamp, cursor and checkpoint hashes | `eth_getBlockByNumber`              | one-block `include_all_blocks` query                                  |
| chain id                                     | `eth_chainId`                       | the chain-specific endpoint; `eth_chainId` still guards the name read |
| token name and symbol                        | Multicall3 `eth_call` at the cutoff | unchanged: Multicall3 `eth_call` at the cutoff                        |

Name and symbol are contract state, which HyperSync does not serve; they are
the one field left on JSON-RPC, read once per batch that holds a launch (one
aggregate per 100 launches plus one `eth_chainId`). `transaction_sender` is
still the initiator, never the beneficiary; no accounting reads the live feed.

Retained evidence per lane (`packages/chain/src/hypersync-recent.ts`):

- swaps: `url`, `query` (first-page body), `pages` (per-page metadata and
  counts), `logs` (registered swaps, verbatim selected fields), `transactions`
  (one per hash), `blocks` (the from and to boundaries and each retained log's
  block) and `unregistered: { swaps, poolIds }`. The JSON-RPC variant also kept
  only registered logs, with their receipts and headers.
- discovery: the same envelope with `logs` (launches), `launcherLogs`,
  `tokenMetadataLogs`, `transactions`, `blocks`, `tokenMetadataIssues` (log
  index as a number, where the JSON-RPC variant kept the hex string) and
  `calls` (the raw Multicall3 replies, as before).

Before anything is written, the writer re-derives every row, count, boundary
and launch from these rows with no network, requires the label and the
evidence variant to agree, and re-resolves every observed pool id (retained
and unregistered) against the registry inside the transaction, so a registered
pool counted as unregistered is refused (`packages/db/src/recent.test.ts`).
Integer-exact wei, the realized identity, the supported and excluded XOR,
basis across windows and every accounting table are untouched: the live feed
writes only `recent_*`. The writer lock (19004) and `discovery:v1` are
untouched.

Measured on the recorded tip page: 1,284 bytes of retained evidence per
registered swap when every observed pool is registered, 1,518 when about a
third are (the fixed query and page records spread over fewer rows).

## Gap resume

A restart resumes from the saved cursor; there is no separate catch-up mode and
no Alchemy catch-up. Cycles run back to back until the confirmed tip, each a
2,000-block batch of whole pages. One pacer spans the worker's life, so the
spacing holds across cycles: at least 2 s between requests (30 per minute, the
free tier's measured sustained rate with zero 429s; 60 throttled), and
`RECENT_HYPERSYNC_MIN_INTERVAL_MS` can only slow it. A cycle is also capped at
300 requests. Sustained 429s (four throttled attempts) exit with the JSON-RPC
stop's reserved code 75, which the supervisor treats as a clean pause of the
service without an automatic restart; a rejected token fails at once.

The logs report a gap larger than one batch as `recent_gap_fill` events:
`started` (gap blocks, batches, a floor on minutes), `progress` per batch
(remaining blocks, blocks per second, ETA) and `complete` (blocks, batches,
requests, elapsed). Every `recent_batch` line carries `source`,
`hypersyncRequests`, `hypersyncBytes`, `pages` and the JSON-RPC `httpRequests`
and `rpcCalls`.

Measured page shape at the tip (16 Sep, 09:53 UTC): a 2,000-block query ending
at the confirmed tip returned one page covering 822 blocks, 1,938 manager swaps
(2.36 per block), 1,529 transactions, 2.47 MB, in 426 ms. So a 2,000-block
batch is about 3 pages plus the 3 fixed reads, 6 requests or about 12 s at
30 per minute: about 160 blocks per second collected, 150 net of the chain's
9.9 blocks per second.

| Downtime | Gap (blocks) | Batches | HyperSync requests | Time to the tip |
| -------: | -----------: | ------: | -----------------: | --------------: |
|   1 hour |       35,640 |      18 |                108 |       4 minutes |
|  6 hours |      213,840 |     107 |                642 |      24 minutes |
| 12 hours |      427,680 |     214 |              1,284 |      48 minutes |
| 24 hours |      855,360 |     428 |              2,568 |      95 minutes |

The indexer stopped at 09:32 UTC on 16 Sep, so the first fill covers the
blocks from its saved cursor to the tip at enablement: read the row for the
hours since then. JSON-RPC calls during the fill are only the name and symbol
reads for launches inside the gap (about 22 launches per hour, at most one
aggregate per batch).

## Residual Alchemy

Counted against a mocked JSON-RPC provider in the worker test, which fails on
any other method:

| Live worker cycle                      | JSON-RPC calls (before: 230 to 270 per 30-second cycle) |
| -------------------------------------- | ------------------------------------------------------- |
| at the tip, no launch in the range     | 0                                                       |
| a range with 1 to 100 launches         | 2: `eth_chainId` and one Multicall3 `eth_call`          |
| catching up, per 2,000-block batch     | 0, or 2 when the batch holds a launch                   |
| receipts, headers, logs, block numbers | 0 in every cycle                                        |

The live check counted 22 launches in the last confirmed hour, so the live
worker makes at most 44 JSON-RPC calls an hour: at most about 570 CU for the
`eth_call`s at 26 CU each, plus 22 `eth_chainId` calls, about 1,000 CU per hour
even if `eth_chainId` were priced like an ordinary call. Before: 0.6 to 1.0M CU
per hour at the tip and 845,948 CU for an hour's catch-up.

The other two workers are unchanged by this switch. Their tip calls, from the
code:

- `indexer`, discovery:v2 every 15 s (`INDEXER_POLL_MS`): 2 `eth_chainId`,
  2 `eth_blockNumber`, 6 headers and 1 `eth_getLogs` per cycle with new blocks,
  plus a header and a receipt per launch and one Multicall3 `eth_call` per batch
  with launches. The cost study measured discovery at the tip at about 2% of
  1.19M CU per hour, about 24,000 CU per hour. It is the next candidate for
  HyperSync. The broad worker is off unless `INDEXER_BROAD_V1_ENABLED=1`.
- `analytics`: no RPC call while no pool stream is ahead of its snapshot, which
  holds with the deep tier off; a pending projection costs a few `eth_call` and
  `eth_getCode` reads (1,872 and 4,960 CU in the 08:00 UTC hour on 16 Sep).

Expected service-wide steady state with `RECENT_SOURCE=hypersync` and the deep
tier off: about 30,000 CU per hour (discovery about 24,000, analytics up to
about 7,000 while its backlog drains, the live worker under 1,000), against
1,047,642 and 1,167,842 CU in the two measured hours. Verify it from Alchemy's
hourly series: read a closed hour only once its `freshness.dataThrough` is at
or past the end of that hour, never by `isPartial`.

## Rollout (the captain's decision, through the main firstmate)

1. Set on the Railway indexer service: `RECENT_SOURCE=hypersync` and
   `ENVIO_API_TOKEN` (the captain's Envio token; `HYPERSYNC_URL` defaults to
   `https://4663.hypersync.xyz`). `RECENT_ENABLED=1` stays as it is.
   `ROBINHOOD_RPC_URL` stays: launches still read name and symbol through it.
2. Resume the service: `railway service source connect --repo eddy-guo/pools-info
--branch main --service indexer` deploys the head of `main`. Migration 016
   runs at start: it adds `recent_batches.source` with a constant default and a
   check, and updates two comments.
3. Watch the recent logs: `recent_configuration` shows `"source":"hypersync"`,
   `hypersyncMinIntervalMs: 2000`; `recent_gap_fill` `started` reports the gap,
   `progress` lines report blocks per second and ETA, `complete` marks the tip;
   `recent_batch` lines show `httpRequests: 0` except in launch batches; no
   `hypersync_retry` lines with `"reason":"throttled"`.
4. After the first closed hour, read the Alchemy hourly series as above.
5. Rollback is `RECENT_SOURCE=rpc`: the same streams continue over JSON-RPC
   from the saved cursor. Any gap then refills over Alchemy at the old cost, so
   restore the HyperSync source rather than toggling repeatedly.

## Live verification (16 Sep 2026, 09:53 UTC)

One bounded run of five requests with the captain's token read from the local
env file (never printed), at most one request every 3 s; two earlier attempts
stopped on the script's own field selections after two requests each, nine
requests in all. Recorded: height 64,416,467; 22 strategy launches in the last
36,000 confirmed blocks (the first and last 32,973 blocks and 3,323 s apart,
9.9 blocks per second); the head header (with a non-null `rollback_guard`); the
tip query over 25 blocks around the newest launch (60 logs: 55 manager swaps,
the launch, its factory metadata and three launcher logs; all 25 blocks
returned by `include_all_blocks`; 74,132 bytes; 65 ms); and the 2,000-block
page shape above. The tip page and head header are fixtures under
`packages/chain/src/fixtures/hypersync/` (`recent-tip.*`, `header-tip.*`);
against the recorded page the collectors produce one verified launch (sender,
block and time from HyperSync) and 55 swaps across 37 pools.

## Tests

- `packages/chain/src/hypersync-recent.test.ts`: the query reproduces the
  recorded body; the recorded page becomes verified launch and swap batches
  with exactly one `eth_chainId` and one Multicall3 `eth_call`; a synthetic
  range (registered, unregistered, two legs of one transaction, an unsupported
  sign pair) derives exactly, a quiet range makes no JSON-RPC call, dense pages
  end on a block boundary; confirmation and canonical-chain checks fail closed;
  every tampered row, count, label, registry claim and retained row is rejected.
- `packages/db/src/recent.test.ts`: the writer refuses forged launches and
  swaps, an unlabelled HyperSync batch, a receipt batch carrying the HyperSync
  label and a registered pool claimed as unregistered; an identical replay is a
  no-op; `source` is recorded.
- `apps/indexer/src/recent-worker.test.ts`, "HyperSync source": a 10,000-block
  gap fills in five paced 2,000-block batches with zero receipt, header, log or
  block-number calls; idle, launch and quiet tip cycles have exact HyperSync
  request and JSON-RPC call counts; the reorg replay above.
- `apps/indexer/src/recent-source.test.ts`: `RECENT_SOURCE` defaults to `rpc`,
  the pacing floor is 2,000 ms, per-cycle clients share one pacer and budget,
  gap progress events, error descriptions and the sticky throttle stop.
