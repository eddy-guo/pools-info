# HyperSync recorded fixtures

Recorded from `https://4663.hypersync.xyz/query` on 2026-09-16 between
02:25:25 and 02:25:32 UTC with the captain's Envio API token (bearer auth;
the token is not part of any fixture). Each `*.request.json` is the exact body
sent and each `*.response.json` is the exact body received, unedited. Block
range: 62,688,988 to 62,689,007 inclusive (20 blocks starting at the MEEP
launch block, inside the August launch period).

| Fixture                                     | HTTP |   Time |  Bytes | Logs / transactions / blocks | next_block | archive_height |
| ------------------------------------------- | ---: | -----: | -----: | ---------------------------- | ---------: | -------------: |
| swaps-unfiltered                            |  200 | 169 ms | 88,149 | 73 / 50 / 19                 | 62,689,008 |     64,149,078 |
| swaps-pool-filter (4 pool ids in topics[1]) |  200 |  58 ms |  7,224 | 5 / 5 / 4                    | 62,689,008 |     64,149,088 |
| transfers-token-filter (2 token addresses)  |  200 |  38 ms |  7,234 | 9 / 3 / 3                    | 62,689,008 |     64,149,136 |
| header-single-block (include_all_blocks)    |  200 | 123 ms |    322 | 0 / 0 / 1                    | 62,688,989 |     64,149,147 |

Wire facts these fixtures pin, relied on by `hypersync.ts`:

- `data` is an array of chunks, each with `logs`, `transactions`, `blocks`
  (only the selected tables appear).
- `block_number`, `log_index`, `transaction_index` and `status` are JSON
  numbers; the block `timestamp` is a 0x-prefixed hex string; `removed` is a
  boolean; absent topics are omitted rather than null; hashes and addresses are
  lowercase.
- `rollback_guard` is null for history this far below the archive height.
- Block 62,688,995 holds no manager swap, so it is absent from the unfiltered
  page's `blocks`; boundary headers that carry no selected log are read with a
  one-block `include_all_blocks` query (the header fixture).

Two further live observations were not kept as fixtures because of size:

- A 10,000-block unfiltered query from 62,688,988 returned 4,754 logs, 3,681
  transactions and 1,194 blocks covering 1,321 blocks (next_block 62,690,309)
  in 525 ms end to end (81 ms server time), 5,859,579 bytes.
- Selection size: 62,265 pool ids in one topics[1] list (4,296,814-byte body)
  were rejected with HTTP 413 `request body exceeds 2097152 bytes`; 10,000 ids
  (690,529 bytes) were accepted and returned the same 5 logs as the 4-id query.

## Tip fixtures (2026-09-16, 09:53 UTC)

Recorded the same way for the live worker's HyperSync source
(`docs/HYPERSYNC-TIP.md`), at the confirmed tip, with the height at 64,416,467:

| Fixture                                          | HTTP |  Time |  Bytes | Logs / transactions / blocks | next_block | archive_height |
| ------------------------------------------------ | ---: | ----: | -----: | ---------------------------- | ---------: | -------------: |
| recent-tip (64,413,742 to 64,413,766, 25 blocks) |  200 | 65 ms | 74,132 | 60 / 42 / 25                 | 64,413,767 |     64,416,556 |
| header-tip (the head block, include_all_blocks)  |  200 |     - |    562 | 0 / 0 / 1                    | 64,416,468 |     64,416,515 |

- `recent-tip` is `recentLogQuery`'s body: manager swaps, strategy launches with
  factory metadata, and the launchers' logs, with `include_all_blocks`. It holds
  55 manager swaps over 37 pools and the launch at 64,413,754 with its metadata
  and three launcher logs; all 25 blocks come back with the logs, including
  blocks without a selected log.
- `rollback_guard` is null on the tip page (2,800 blocks below the archive
  height) and present on the head block's header response.

## Ledger swap selection fixtures (2026-09-17, 17:35 to 17:39 UTC)

`ledger-swap-selection-<from>-<to>.json.br` (brotli JSON) hold both ways the
ledger's swap lane can select one real range, recorded from the requests
`compareLedgerSwapSelections` (`pnpm ledger:pass compare <from> <to>`) sent
with the registry of the local tip-loop ledger (62,892 and 62,426 pools before
the ranges): the launch query, the three pool-id queries the registry split
into, the manager-wide query (`address` the PoolManager, `topics` the Swap
selector, no pool ids), the two transfer queries and the boundary headers.
Each answer is the body received for the exact request the collector builds
for the range, matched by the request body's SHA-256, parsed and serialised
again with every row and its order unchanged. The pool-id and token lists are
not kept: `pools` holds the registered pools the answers name and `registry` a
digest of the full sorted pool id list. `expected` is what the live comparison
derived. `apps/indexer/src/ledger-selection.test.ts` replays both
selections through `collectLedgerRange` and requires the same rows and
content hash.

| Range (inclusive)     | Blocks | Launches | Registered swaps | Transfers | Manager swaps (pages) | Pool-id answers (logs) | Content hash    |
| --------------------- | -----: | -------: | ---------------: | --------: | --------------------- | ---------------------- | --------------- |
| 65,402,717-65,403,527 |    811 |        1 |              236 |       307 | 4,296 (1)             | 196, 35, 5             | `0x094b79e6...` |
| 64,340,780-64,342,779 |  2,000 |        2 |            2,071 |     2,208 | 4,441 + 5,965 (2)     | 377, 452, 1,242        | `0x3b8574b5...` |

The first is a tip range exactly as the local tip loop committed it (its
`agg_batches.content_hash` is the same); the second is the busiest morning of
16 Sep at the swap lane's `managerSwapBlocks` threshold. Wire facts:

- A manager-wide answer is about 1,170 bytes per swap log with its joined
  transactions and blocks; a page held up to 5,965 logs and 6.9 MB, ending on
  a server partition (65,405,074-65,405,859 split at 3,530 logs, the 2,000-block
  range at 4,441).
- The same query can come back with its rows split over a different number of
  `data` chunks; compare rows, not chunks.
- A gzip request body (`content-encoding: gzip`) is rejected with HTTP 400
  `invalid JSON: expected value at line 1 column 1`: the server does not
  decompress requests.

## Ledger transfer probe fixture (Blockscout, 2026-09-25, 22:30 UTC)

`ledger-transfer-probe-65402717-65403527.json.br` (brotli JSON, 37 KB) holds
every `Transfer` log (ERC-20 and ERC-721 share the topic) of the 811-block tip
range of the swap selection fixture above, 27,441 logs from 672 contracts,
as Blockscout's PRO API answered
`module=logs&action=getLogs&topic0=0xddf252ad...` between 22:30:20 and
22:30:57 UTC, 29 calls of at most 1,000 logs walked block by block. Each log
is kept as the two fields the transfer lane's probe (`transferAddressQuery`)
selects, its block and emitting contract (`rows` index `addresses`). It is
another indexer's answer for the same chain, not a HyperSync recording: no
HyperSync call was made, because the only token is the production tip
loop's. Filtered to the registry, its rows are the recorded transfer
answers' 307 logs field for field (block, log index, transaction, address,
data, topics). `apps/indexer/src/ledger-selection.test.ts` replays the
27,441 rows as six simulated, block-complete pages of roughly 4,600 logs
each, within the recorded tip page sizes, and requires the same rows and
content hash as the recorded full-list answers. The page boundaries are a
test simulation, not a recorded HyperSync answer to this probe.

Transfer density on chain 4663, from the same API on 25 Sep 2026 (93 calls,
1,860 of the free key's credits):

| Sample                                                                       |        Transfers |                                           Per block | Transactions |
| ---------------------------------------------------------------------------- | ---------------: | --------------------------------------------------: | -----------: |
| 65,402,717-65,403,527 (811 blocks, 17 Sep 13:28 UTC)                         |           27,441 |                                               33.84 |        4,846 |
| 72,582,901-72,583,681 (781 blocks, the tip loop's range of 25 Sep 22:25 UTC) |           11,909 |                                               15.25 |        2,365 |
| 42 samples, one per 145,000 blocks, 18 Sep 21:42 to 25 Sep 20:06 UTC         | first 1,000 each | 7.93 to 84.27 (median 15.87, 90th percentile 32.23) |            - |

The recorded registered transfers of the first range were 307 (0.4 a block
at the busy rate); the tip loop's own logs of 25 Sep counted 5 to 185 a
range, 34 on average. With their transactions and blocks the recorded rows
average 613 bytes a log, 318 a transaction and 203 a block, so whole
chain-wide answers would be 8.2 MB (25 Sep) and 18.5 MB (17 Sep) per tip
range, against a client cap of 32 MB and 20,000 rows a page; the probe's
rows serialise to 81 bytes, 0.96 MB and 2.2 MB.

The page cap uses the available HyperSync page evidence, not the one-page
manager answer as a proxy for the probe. Near the tip, recorded pages held
3,530 to 5,965 logs: the 811-block manager-wide answer was one page of
4,296, and the 2,000-block answer was 4,441 + 5,965. August pages held
1,300 to 2,300. On 16-17 Sep, the same query ended at the same block with
default fields, logs plus blocks, logs only, and `max_num_logs=20,000`:
server partitions, not selected fields, set page boundaries. The probe's
two-field selection reduces response bytes but does not change that measured
page boundary behavior. PR 91's whole-row chain-wide Transfer query exceeded
32 MB over 780 tip blocks, so the small selection is necessary.

Deployment `02a6827b`'s ledger-tip logs cover 233 cycles on 25 Sep,
17:37-22:26 UTC: range sizes 708-837 blocks, p50 741, p90 764, p95 about
770, maximum 837. They used eight HyperSync requests per cycle, maximum
nine, with a roughly 74-second cycle, or about 6.5 requests/minute.
At 32 Transfers/block over 770 blocks, `ceil(24,640 / 3,530) = 7` probe
pages; at the observed p90 of 32.23, it is eight. The recorded 27,441-log
range also needs eight at that page floor; the 11,909-log tip range needs
four. `chainTransferPages=10` allows two pages of margin. At the August
1,300-log floor, the rounded 32/block case needs 19 pages (20 at the
exact p90) and falls back to full token lists. A capped fallback costs
at most ten probe requests plus two list requests. The observed maximum
nine-request cycle had seven non-transfer requests. The pre-probe cutoff
header adds one more, so the capped fallback costs at most 20 requests;
2-second pacing spans at least 38 seconds, and the 60-second tip poll makes
roughly 12 requests per minute,
below the shared free tier's roughly 30. Even within the request burst,
20 is below 30 requests in a minute.

Ten pages at the 3,530-log tip floor cover about 45.8 Transfers/block for a
770-block range. That exceeds the p90 density of the 42 Blockscout samples,
so under those page-size and range assumptions only about the upper tenth
of sampled densities would fall back for page count; byte
limits or failed requests can add fallbacks. This is a modeled frequency,
not a measured HyperSync fallback rate. Production tip logs after deployment
must establish actual pages, fallback counts, lag and committed Transfers.
