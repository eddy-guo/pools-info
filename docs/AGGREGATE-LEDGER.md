# The aggregate ledger: phases 1 and 2

The aggregate architecture replaces the per-pool evidence tiers with one
ledger built from HyperSync: every registered PoolManager `Swap` and every
ERC-20 `Transfer` of a registered token folds into positions, hour buckets and
pool state, with the evidence hash retained and the bytes dropped. The design,
its measurements and its decisions are the scout report
`data/pools-aggregate-design-s5/report.md` in the firstmate home (sections 4,
6, 7.2 and 11 are the ones this phase implements); the captain approved it on
16 Sep 2026 with the report's recommended answers to D1 to D5 as defaults.
This document records what phases 1 and 2 deliver, where they deviate from
the report and why, and what phases 3 to 5 still owe.

## What phase 1 delivers

**`packages/core/src/ledger.ts`, pure functions.**

- `planLedgerBatch` is the attribution rule (report 4.3). Per transaction,
  the net movement of each registered token per address is computed from its
  `Transfer` logs; the manager and the zero address never become wallets. A
  swap's beneficiary is the address whose net movement has the swap's sign
  and at least the swapped amount: the initiator when it qualifies
  (`attribution = initiator`), otherwise the only such candidate
  (`counterparty`). The beneficiary's remainder and every other non-zero net
  movement of the token in the transaction are inflows at zero cost or
  outflows with proportional basis removal. Two registered swaps of one pool
  in one transaction, or no single candidate, leave the swap unattributed:
  nothing of that transaction is applied and every address whose balance of
  the token moved has its position excluded with `unattributed_swap_activity`.
  Transfers in transactions without a swap of the token are plain inflows and
  outflows. Swaps apply before residual transfers, transactions in block
  order, both in log order. `wrapper_route` marks a swap whose transaction
  `to` was not the router, `counterparty_route` a swap attributed to a
  recipient, `zero_cost_inflow` a position with `inflow_raw > 0`.
- `applyLedgerEvents` is the incremental average-cost position: `foldTrades`
  made stateful (buy adds quantity and cost; sell disposes `cost * tok / qty`,
  or the whole cost when the inventory closes), with `disposed_cost`,
  `outflow_cost`, `inflow` and `outflow` so the position-level identities
  `realized = proceeds - disposed_cost` and
  `invested = cost + disposed_cost + outflow_cost` hold at every step. A sell
  or an outflow above the held quantity empties the inventory and excludes the
  position with `unknown_basis`, exactly as `foldTrades` does. Inventory
  cycles open when the quantity leaves zero and close on the sell that returns
  it to zero; the closure's gain and hold time are the ones `walletMetrics`
  derives (`ledger.test.ts` proves it on every fixture). An outflow that
  empties the inventory ends the cycle without a closure: a transfer out is
  not a sale.
- Hour buckets: wallet hours per (wallet, pool, UTC hour) with realized,
  disposed cost, proceeds, spent, volume, counts, closures, wins, losses, hold
  seconds and the best sale; pool hours with counts, volume, distinct buyers
  and sellers and the OHLC of `sqrtPriceX96` in log order; pool state with the
  latest quote and totals. `ledgerKeys` names every row a batch can touch
  before it is applied, so the writer loads and journals them first.
- Per-sale realized values are computed and returned (`LedgerSale`) but not
  stored: D3's default drops them, and a later flip adds one table fed by
  that output without touching the fold.

**Migration `017_aggregate.sql`.** The `agg_*` tables of report section 6:
`agg_wallets`, `agg_streams`, `agg_batches`, `agg_positions`,
`agg_wallet_hours`, `agg_wallet_windows` (filled by phase 3),
`agg_pool_hours`, `agg_pool_state`, `agg_live_trades`, `agg_journal`, plus
`pool_ref` and `decimals` on `indexed_pools`. Nothing in 001 to 016 changes.
Every amount is an integer-exact `numeric`, every address and hash is
`bytea`, every table checks `chain_id = 4663`, and the accounting identities,
the supported/excluded XOR, the flag-to-counter equivalences, the cycle
invariant and the 128-block lag (`archive_height >= to_block + 128`) are
database checks. `packages/db/src/ledger.test.ts` forges each of them.

**`packages/db/src/ledger.ts`, the writer.**

- `applyLedgerBatch` (report 7.2), in one transaction under the ledger writer
  lock (`pg_try_advisory_lock(4663, 19005)`, checked inside the transaction):
  the content hash (SHA-256 of the canonical serialisation of the range, its
  boundary hashes and every launch, swap and transfer row in log order) makes
  a replayed range a no-op and a differing range for the same `to_block` a
  refusal (`ledger_batch_conflict`); the range must extend the cursor and name
  its hash (`ledger_noncontiguous_batch`); the batch row is inserted first,
  every row the plan can touch has its pre-image journaled before its first
  change (a null pre-image records creation), the fold runs, rows are
  upserted, `holders` is recounted for every touched pool, live trades are
  inserted, the ring is pruned (24 hours, 250,000 rows), the journal is pruned
  beyond the newest 256 batches and the cursor advances. Swaps of pools not
  in `indexed_pools` are counted as `unregistered_swaps` and dropped.
- `walkBackLedger` undoes every batch newer than an ancestor, newest first:
  the batch row goes (its live trades and journal cascade), each pre-image is
  restored or the row deleted, and the cursor returns to the ancestor. It
  refuses when a batch to undo is older than the journal keeps.
- `ensureLedgerStream`, `readLedgerStream`, `ledgerCheckpoints`,
  `acquireLedgerWriter` and `releaseLedgerWriter` are the stream's surface
  for the pass and the tip loop.

## Deviations from the report, and why

- **`agg_wallet_hours` is keyed by (wallet, pool, hour), not (wallet, hour),
  and carries `volume_wei`.** A position can be excluded after it has
  realized gains in earlier hours (an oversell or an unattributed loop). With
  wallet-wide hour rows those gains could not be removed exactly, and a
  timed-window board would keep counting a position whose `All` figure is
  null. Per-pool rows let the writer zero exactly the excluded position's
  finances while keeping its counts and volume, and each row witnesses one
  distinct buyer or seller for the pool hour, so `buyers` and `sellers` are
  exact across batches. `volume_wei` is what the window tables of section 6
  need and the hour rows lacked. The window rebuild of section 7.3 is the
  same `GROUP BY wallet_ref` over about twice as many rows.
- **`holders` is recounted, not delta-tracked.** After each batch the writer
  counts positions with a positive quantity for every touched pool, over the
  partial index the schema already had. Exact by construction.
- **A position is `supported` when it carries no excluding flag, including a
  holder that never traded.** Eligibility for ranking is
  `supported_trades >= 10` as today, so holder-only positions never rank; the
  report's replay counted such positions in neither bucket.
- **Undecodable swap logs.** Seven of the 127,080 deep-tier swap logs carry
  amounts of one sign and were stored undecoded by the deep tier. They are not
  trades; the pass must skip them the same way (phase 2).

## Acceptance evidence

- `pnpm test` runs `packages/core/src/ledger.test.ts`: the ledger folds to
  the same numbers as `foldTrades` on every accounting fixture
  (`accounting.test.ts`, `chain-accounting.test.ts`, `live-analytics.test.ts`,
  the api accounting definitions, `data/snapshots/chain.json`, the pepe
  capture: 24 and 342 positions, 18 and 341 of them complete) and on 400
  random histories; the hour rows reproduce `walletMetrics` closures for
  every complete wallet; the attribution rule over the pepe capture's raw
  logs, receipts and blocks agrees with all 341 wallets the old rule fully
  supported.
- `pnpm test:db` runs `packages/db/src/ledger.test.ts` (idempotence, conflict
  refusal, contiguity, forged identities, walk-back restoring pre-images, the
  reorg replay shape from PR 35: fork, replaced range, rebuild equals a fresh
  build) and `packages/db/src/ledger-replay.test.ts`, the dump replay. The
  replay reads the restored production dump `pools_prod_shape` on the local
  Postgres 18 test server (port 5418, or `POOLS_PROD_SHAPE_URL`) and skips with
  the reason where it is not reachable, which keeps it out of CI. Where it
  runs: all 27,970 supported positions and all 12,025 per-sale realized values
  (10,202 of them cycle closures) reproduce exactly; the rule over all 281,613
  deep-tier events gives 123,902 initiator and 2,412 counterparty
  attributions, 759 unattributed swaps, 54,423 positions of which 426 are
  excluded (report: the same), and the three wallets of report section 4.4
  reproduce to the wei shown there.

## Phase 2: the history pass

`pnpm ledger:pass run` (`apps/indexer/src/ledger-pass-main.ts`, the loop in
`apps/indexer/src/ledger-pass.ts`, the collector in
`packages/chain/src/hypersync-ledger.ts`) reads the whole registered history
from HyperSync once and folds it through phase 1's writer. It is manual, off
by default (`LEDGER_PASS_ENABLED=1` and `ENVIO_API_TOKEN`; the variables are
in `.env.example`) and never started by the indexer service. `status` reads
the streams and writes nothing; `calibrate <from> <to>` collects one range
exactly as the pass would and reports its counts without writing.

**One range** (report 7.1). From the ledger cursor (or block 23,467,030, the
first launch) to at most `archive_height - 128`, three lanes over the same
blocks, each consumed in whole pages (`collectLogPages`: 5,000 logs
requested per page, 16 pages, 24 MiB per lane query):

1. The launch lane: the strategies' `TokenLaunched` and the factory's
   `TokenCreated` logs plus every log of the launchers, joined to their
   transactions and blocks. Each launch is verified as in PR 35 (`decodeLaunch`
   recomputes the pool id from the PoolKey, the transaction succeeded, a
   launcher log sits in the same transaction, factory metadata is matched to
   the token), and its name, symbol and decimals are read through one
   Multicall3 `aggregate3` per 66 launches over `ROBINHOOD_RPC_URL`, which
   must be the public RPC: an Alchemy host is refused.
2. The swap lane, with the registry as of the range end leading the filter
   (report 3.4): every pool registered before the range plus the range's own
   launches, sorted, in selections of 20,000 pool ids, one selection per
   query (a 1.38 MB body against the 2 MiB limit; 62,642 pools are four
   queries). Every returned log is validated, joined to a successful
   transaction (the initiator, `to` for the route label) and its block, and
   decoded; a swap whose amounts share a sign is not a trade and is counted
   as `unsupportedSwaps`.
3. The transfer lane: every registered token's `Transfer` logs in selections
   of 31,000 addresses (1.40 MB), validated and joined the same way.

A lane query that hits a cap ends the range on its last whole page, every
later query is asked only up to that block, rows beyond it are dropped, and
the next range continues from it. A launch burst beyond 5,000 launches ends
the range before the excess. The cutoff header is read last (the parent hash
comes from the saved cursor; the first range reads its from header), every
page's `archive_height` must be at least 128 above the range end, and every
retained block must form one parent-linked chain with non-decreasing
timestamps. The launches commit first through the discovery commit on the
new stream `launches:agg:v1` (so `indexed_pools`, `pool_launch_sources` and
the catalog readers see exactly what discovery writes today, plus
`decimals`), then `applyLedgerBatch` folds the swaps and transfers under the
writer lock. Each range commits or fails alone; a stopped pass resumes from
the ledger cursor, a replayed range is the writer's content-hash no-op, and a
stop between the two commits leaves the launch stream one range ahead, which
the next start rewinds (`ledger_launch_rewind`) before extending.

**Reconcile, throttle, progress.** Before extending, the saved cursor's hash
is read from HyperSync; on a mismatch the newest still-canonical checkpoint
is found and `walkBackLedger` restores the pre-images (`ledger_walk_back`),
the tip loop's code path. Four throttled attempts on one request
(`HyperSyncRateLimitExhausted`, or the RPC's equivalent) end the run with
`stopped: "throttled"` and the reserved exit code 75; nothing restarts it.
Every committed range logs one `ledger_progress` line with the range's rows,
requests, bytes and pages, the run's blocks per second, throttled retries,
requests per million blocks and ETA, and the ledger's cumulative totals:
batches, swaps, transfers, launches, positions, wallets, `pairsPerSwap`,
`swapsPerBlock`, `requestsPerMillionBlocks` and `bytesPerSwap`. A
`ledger_million` line closes each million blocks of history with the same
counters for that million. `ledger_pass_summary` closes the run. These are
the counters report sections 3.6 and 5 are checked against.

**What the batch rows keep.** `agg_batches.query` holds the launch query
body verbatim and, for each swap and transfer query, its range, the number
of values and a SHA-256 of the sorted value list (the list is the registry as
of the range end, reconstructible from the catalog); `pages` holds the page
records per query and the header reads. The launch stream's
`indexer_batches.evidence` keeps the HyperSync launch variant: the launch,
launcher and metadata logs, the launch transactions, the launch blocks and
the cutoff header, the metadata issues and the raw Multicall3 replies;
`verifyLedgerLaunchBatch` re-derives every pool from it before the commit.

### Deviations from the report, and why

- **Quiet ranges grow.** The report fixes ranges at 100,000 blocks. Measured
  on HyperSync, a page holds about 1,300 to 2,300 logs whatever the field
  selection or `max_num_logs` (pages end on the server's own block
  partitions), so requests scale with logs, and in the sparse weeks of
  August the fixed per-range cost (one launch query, up to seven selection
  queries, one header) dominates. A range whose lane queries all answered in
  one page doubles the next range, up to `LEDGER_PASS_MAX_RANGE_BLOCKS`
  (default 1,000,000); a cut range resets to `LEDGER_PASS_RANGE_BLOCKS`
  (100,000). The batch semantics are unchanged; only the boundaries move.
- **Metadata is read at the RPC's head, not the cutoff.** The public RPC
  answers `eth_call` for the last few thousand blocks only (`historical state
  ... is not available` beyond them), so name, symbol and decimals are read
  at `eth_blockNumber`. They are immutable for factory tokens; the evidence
  records the block.
- **Value lists are digested, not stored.** Storing 62,000 pool ids per
  batch would be gigabytes of `query` jsonb over the pass; the count and the
  digest identify the selection and the catalog reproduces it.

### Acceptance evidence

Filled from the local full pass into `pools_agg_pass` on the Postgres 18
test server (port 5418): see the pull request for the run's wall-clock,
requests, bytes, 429 count, the calibration ranges against report 3.3 and the
three wallets against report 4.4.

## What phases 3 to 5 still owe

- **Phase 3, the tip loop** (report 7.3): PR 35's cycle with `applyLedgerBatch`
  as the commit, reconcile-then-extend over `ledgerCheckpoints` and
  `walkBackLedger`, the `agg_wallet_windows` refresh with ranks, the sticky
  throttle stop, 24 hours unattended on Railway.
- **Phase 4, readers and the API deltas** (report section 8): every response
  shape is untouched in phase 1; phase 4 changes the readers and the web
  validators in one PR.
- **Phase 5, cutover and retirement** (report section 9): no production write,
  Railway or Envio change happens before it. The indexer stays down and the
  Envio switch stays off.

Decisions D1 (wrapper-routed wallets on the board) and D2 (zero-cost inflows
in ranking) are query predicates on `flags`; D3's flip adds a per-sale table
fed by `LedgerSale`; D4 and D5 belong to phases 5 and 4. The pass leaves the
stream in mode `tip` once a fresh archive height leaves a gap under
`ledgerPassPolicy.catchUpMargin` (2,000 blocks) past the 128-block safety lag,
not on an exact zero gap: a chain that never stops producing blocks never
closes that gap to zero, so the cursor can sit up to about 2,128 blocks below
the archive height when mode flips to `tip`. Phase 3 takes it from there.
