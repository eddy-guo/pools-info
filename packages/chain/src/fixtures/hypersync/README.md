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
derived. `apps/indexer/src/ledger-swap-selection.test.ts` replays both
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
