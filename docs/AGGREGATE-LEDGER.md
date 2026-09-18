# The aggregate ledger: phases 1 to 3

The aggregate architecture replaces the per-pool evidence tiers with one
ledger built from HyperSync: every registered PoolManager `Swap` and every
ERC-20 `Transfer` of a registered token folds into positions, hour buckets and
pool state, with the evidence hash retained and the bytes dropped. The design,
its measurements and its decisions are the scout report
`data/pools-aggregate-design-s5/report.md` in the firstmate home (sections 4,
6, 7.2 and 11 are the ones this phase implements); the captain approved it on
16 Sep 2026 with the report's recommended answers to D1 to D5 as defaults.
This document records what phases 1 to 3 deliver, where they deviate from
the report and why, and what phases 4 and 5 still owe.

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
  recipient; both describe. `zero_cost_inflow` marks a position with
  `inflow_raw > 0` and `unattributed_outflow` one with `outflow_raw > 0`,
  and each excludes it from the moment the transfer lands (decided 18 Sep
  2026, migration 022): the ledger vouches for a position it witnessed end
  to end. Tokens that arrived without a swap have no basis it can vouch for,
  and a sale booked against a zero basis read as pure profit (on the 24h
  board of 18 Sep, 58 of the top 100 were such rows, sybil receivers of
  creator-run distribution farms); tokens that left without a swap took
  their basis (`outflow_cost_wei`) to a disposition it never saw (the same
  farms' buying wallets: buy, fan out, the receivers sell), so that
  position's outcome is unknown rather than the sales it did see, and no
  loss is invented for the move. The position's own figures keep folding and
  are never served; its hour rows keep counts and volume and lose their
  finances, as for the two other excluding flags.
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
  excluded by an unknown basis or unattributed activity (report: the same)
  and, since migration 022, more by a transfer in or out alone (the replay
  prints the count per flag set); the three wallets of report section 4.4
  hold no such position and reproduce to the wei shown there.

## Phase 2: the history pass

`pnpm ledger:pass run` (`apps/indexer/src/ledger-pass-main.ts`, the loop in
`apps/indexer/src/ledger-pass.ts`, the collector in
`packages/chain/src/hypersync-ledger.ts`) reads the whole registered history
from HyperSync once and folds it through phase 1's writer. It is manual, off
by default (`LEDGER_PASS_ENABLED=1` and `ENVIO_API_TOKEN`; the variables are
in `.env.example`) and never started by the indexer service. `status` reads
the streams and writes nothing; `calibrate <from> <to>` collects one range
exactly as the pass would and reports its counts without writing; `compare
<from> <to>` collects one range with each swap selection (below) and fails
unless both give the fold the same rows. Both spend about seven HyperSync
requests per collection on the token the production tip loop uses, so neither
runs while that loop does.

**One range** (report 7.1). From the ledger cursor (or block 23,467,030, the
first launch) to at most `archive_height - 128`, three lanes over the same
blocks, each consumed in whole pages (`collectLogPages`: 5,000 logs
requested per page, 16 pages, 24 MiB per lane query):

1. The launch lane: the strategies' `TokenLaunched` and the factory's
   `TokenCreated` logs plus every log of the launchers, joined to their
   transactions and blocks. Each launch is verified as in PR 35 (`decodeLaunch`
   recomputes the pool id from the PoolKey, the transaction succeeded, a
   launcher log sits in the same transaction, factory metadata is matched to
   the token), and its name, symbol, decimals and (since phase 3) total
   supply are read through one Multicall3 `aggregate3` per 50 launches over
   `ROBINHOOD_RPC_URL`, which must be the public RPC: an Alchemy URL is
   refused.
2. The swap lane, with the registry as of the range end selecting the swaps
   (report 3.4): every pool registered before the range plus the range's own
   launches. A range longer than `ledgerPassPolicy.managerSwapBlocks` (2,000
   blocks) sends it as pool-id lists, sorted and split evenly over the fewest
   queries of at most 25,000 ids, one selection per query (`ledgerChunks`;
   the 62,858 pools of 17 Sep 2026 are three queries of about 21,000 ids,
   1.45 MB against the 2 MiB limit, where the pass's fixed 20,000-id chunks
   took four). A range of at most 2,000 blocks selects every PoolManager
   `Swap` with one 527-byte query and drops the swaps of pools outside the
   registry locally, counted as `unregisteredSwaps` (phase 3, "The swap lane
   at the tip"). Every kept log is validated, joined to a successful
   transaction (the initiator, `to` for the route label) and its block, and
   decoded; a swap whose amounts share a sign is not a trade and is counted
   as `unsupportedSwaps`.
3. The transfer lane: every registered token's `Transfer` logs split the same
   way over queries of at most 40,000 addresses (two of about 31,400, 1.41
   MB, where fixed 31,000-address chunks took three), validated and joined
   the same way.

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
of the range end, reconstructible from the catalog); a manager-wide swap
query (`selection: "manager"`) sent no list and keeps its range, the same
count and digest of the registry it was filtered by, and the number of the
range's manager swaps outside it (`unregistered`). `pages` holds the page
records per query and the header reads. The content hash covers the rows, not
the query, so a range folds to the same batch whichever selection fetched it;
`agg_batches.unregistered_swaps` stays the writer's count of committed swaps
whose pool it could not find, 0 in both. The launch stream's
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

## Phase 3: the tip loop

`pnpm ledger:tip run` (`apps/indexer/src/ledger-tip-main.ts`, the loop in
`apps/indexer/src/ledger-tip.ts`) keeps the ledger the pass built current. It
extends a ledger and never starts one: it refuses a database whose
`agg_streams` holds no cursor, and it asks before migrating, so a loop
pointed at any other database (the old production one) exits without
altering it (exit code 78). It also refuses a ledger whose batches folded
trades but whose `agg_positions` or `agg_wallet_hours` are empty, as a restore
that leaves them for later would be: folding into empty positions would book
sales without their buys. It is off unless `LEDGER_TIP_ENABLED=1` and
`ENVIO_API_TOKEN` are set; the variables are in `.env.example`. On Railway it
is its own service, `apps/indexer/railway.ledger-tip.json`, whose start
command `src/ledger-tip-service.ts` supervises this one worker; the indexer
service's `src/service.ts` starts discovery, analytics and the recent worker
over Alchemy and is never its start command.

**One cycle** is PR 35's order over the pass's lanes, and every write in it
is a committed batch or nothing, so the loop can stop at any point:

1. `GET /height`, then the head block's header: `agg_streams.head_block`,
   `head_timestamp` and `checked_at` record the head beside the cursor.
2. Reconcile: the saved cursor's hash is read back from HyperSync; on a
   mismatch the newest still-canonical checkpoint is found and
   `walkBackLedger` restores the journal's pre-images, then the launch stream
   is rewound into lockstep (`reconcileLedgerPass`, the pass's own code).
3. One range from the cursor to at most `height - 128`, collected and
   committed exactly as the pass commits one (`runLedgerRange`): launches
   first through `launches:agg:v1`, then the swaps and transfers through
   `applyLedgerBatch` under the writer lock. A range that completes its whole
   size doubles the next one up to `LEDGER_TIP_MAX_RANGE_BLOCKS` while the
   loop is behind; a range a lane cut short sets the next to what it covered.
4. The leaderboard windows are refreshed when due (below).
5. At the confirmed tip the loop waits `LEDGER_TIP_POLL_MS` (60 s); behind
   it, the next cycle starts at once. A quiet tip cycle is three HyperSync
   requests (height, head, cursor) and a cycle with new blocks adds the launch
   query, the manager-wide swap query (one or two pages), one query per
   transfer selection (two at the 17 Sep catalogue), the cutoff header and
   any extra pages, all paced at one request per 2 s or slower. The
   `ledger_tip_cycle` line logs the cycle's `requests`, response `bytes` and
   `sentBytes`, the request bodies uploaded.

**The launch lane arrives complete.** Each launch's name, symbol, decimals
and `totalSupply()` are read in the same Multicall3 aggregate over the public
RPC and stored with the pool: `indexed_pools.token_total_supply_raw` and
`token_supply_block` (migration 019) are written by the discovery commit, and
a later reading replaces an earlier one, never the reverse. The launch
stream's evidence carries the new reads as schema version 2; version 1
batches (name, symbol and decimals) still verify.

**The live ring holds the 24 hours ending at the cursor**
(`pruneLedgerLiveTrades`, run inside every batch), with a disk bound under it
sized from measured rows: the busiest rolling 24 hours of the registered
history held 1,026,761 swaps (5 to 6 Aug 2026, summed from `agg_pool_hours`
in the pass database; 17 Sep's held 382,835), and a ring row costs 459 bytes
with its indexes freshly written and 661 under the writer's churn, so the cap
of 1,250,000 rows keeps a whole day on every day measured and holds the table
near 0.6 to 0.8 GB when a day that busy recurs. Phase 2's cap of 250,000 rows
covered 15.2 hours of 17 Sep.

**The windows** (`packages/db/src/ledger-windows.ts`). `agg_wallet_windows`
holds one row per wallet per window (`1h`, `6h`, `24h`, `7d`, `30d`, `All`),
summed from the whole UTC hours ending with the cursor's hour, with the
wallet's position counts and last activity. `rank` is the wallet's place
among the eligible (at least 10 supported trades on a supported position) by
realized, the address breaking ties, and is kept for the top 100 only.
`agg_window_refreshes` (migration 020) records the cursor each window
reflects. The first refresh rebuilds every window from the hour rows; after
that a refresh recomputes only the wallets the journal names for the batches
since, with their position figures read once for all six windows. When a
window's start moves, a wallet the batches did not touch has the leaving
hours' sums subtracted from its row, exact since those hours did not change;
it is summed again only when its best sale or its last unfolded closure sat in
them, and leaves the window when no hour is left. It runs
at most once per `LEDGER_TIP_WINDOW_REFRESH_MS` (60 s) and whenever the
cursor's hour moves, in one transaction, so all six windows reflect the same
cursor. A walk-back removes the refresh state with its batch (and the window
rows of any wallet it deletes), which forces a rebuild; so does a batch whose
journal is not whole.

**Closed-cycle hold time** (decided 17 Sep 2026). A sale that closes an
inventory cycle folds its hold time into the position (`closed_cycles`,
`flash_cycles` held under 60 seconds, `shortest_cycle_seconds`) and into the
wallet's hour row (`flash_closures`), and a window sums the latter. Rows
written before migration 020 hold closures whose hold time was never folded:
their columns are null and stay null when a later closure lands (a count
from then on would read as the whole history), and a window holding such an
hour serves null. A position or hour row created from then on starts at
zero. The history backfill fills the rest.

**Stops.** A sustained throttle (four throttled attempts on one HyperSync or
RPC request) ends the loop with exit code 75, a rejected token 77, a page
over HyperSync's own caps 76, and a ledger that refuses to change (a walk-back
its journal cannot serve, a conflicting batch, no ledger) 78; the service's
supervisor turns each into a clean exit that Railway's `ON_FAILURE` policy
does not restart. Any other failure is retried after 2, 4, 8 and 16 seconds;
five failed cycles in a row exit 1 for a restart from the cursor. SIGTERM
ends the loop on a committed batch.

### Changes to phases 1 and 2, and why

- **Walk-back restored amounts through JavaScript numbers.** The journal's
  pre-images were parsed into objects and serialised again, so any amount
  past 2^53 (almost every wei figure) came back rounded: a real reorg would
  have failed an identity check or silently changed a volume. Pre-images now
  travel as jsonb text (`packages/db/src/ledger.test.ts`, "walk-back restores
  amounts beyond double precision to the wei").
- **Walk-back checks that a batch's journal is whole.** `agg_batches` records
  the journal rows each batch wrote (`journal_rows`), and a batch written
  before that, or whose journal was pruned or left out of a restored dump (the
  production restore of 17 Sep leaves `agg_journal` out), is refused instead
  of being removed with its changes left in place.
- **Value lists split evenly over the fewest queries**, two requests fewer
  per range at the 17 Sep catalogue (see the lanes above).
- **The swap lane at the tip selects every manager swap** (17 Sep 2026). The
  pool-id lists cost the tip loop about 7.2 MB of upload per 80-second cycle
  (5.3 MB a minute on Railway, most of the service's bill) to ask for a few
  hundred swaps. A range of at most `managerSwapBlocks` (2,000) blocks now
  sends one 527-byte manager-wide query and keeps the registry's swaps
  locally; the transfer lane keeps its token lists, since a chain-wide
  `Transfer` selection over 780 blocks overflowed HyperSync's 32 MB response.
  Replaying the recorded answers of four 17 Sep tip ranges through the
  production client on a local TLS server, a cycle uploads 2.84 MB instead of
  7.19 MB (TLS bytes, handshakes and HTTP headers included) in 8 or 9
  requests instead of 10, and downloads about 5.3 to 5.8 MB instead of 0.05
  to 1.1 MB. The threshold is the tip loop's base range: tip ranges are 760
  to 822 blocks, a 2,000-block manager-wide query is 12.1 MB in two pages at
  16 Sep's busy rate (manager swaps run 3.2 to 6.5 a block at about 1,170
  bytes each), and only catch-up ranges are longer, where the lists answer
  64,000 blocks in one page per query and a manager-wide query would be cut
  near 3,300 blocks at the busiest rate. Both selections gave identical rows and content hashes
  over seven real ranges (launches, the busiest morning, a quiet evening,
  the threshold); two are committed as recorded fixtures
  (`apps/indexer/src/ledger-swap-selection.test.ts`) and
  `pnpm ledger:pass compare` reruns the comparison live. Envio does not
  accept a gzip request body (HTTP 400), so the transfer lists stay
  uncompressed.
- **Ranks are row numbers kept for the top 100**, not the report's dense rank
  over every eligible wallet: the leaderboard today ranks by position with
  the address breaking ties, and serves no rank past 100 (captain, 17 Sep
  2026), so the rows past it would churn on every refresh for no reader.

### Acceptance evidence

The tests: `apps/indexer/src/ledger-tip.test.ts` in `test:db` (the loop takes
the stream over from the pass and folds to exactly the pass's ledger and
catalogue, a fresh launch arrives with decimals and supply, the exact request
count of a quiet and a small tip cycle, PR 35's reorg replay on the journal:
walked back to exactly the checkpoint's ledger and recollected to a fresh
build of the fork, a stop after every request of a cycle resuming to the
same ledger and windows with both streams in lockstep, a stop between the two
commits, the throttle stop, backoff, the refusal of a database without a
ledger), `packages/db/src/ledger-windows.test.ts` (the build, top-100 ranks
with the address tie-break, incremental refreshes equal to a rebuild as
batches land, hours leave and positions are excluded, the interval, walk-back,
unknown flash counts), `packages/db/src/ledger.test.ts` (the ring's bound,
the journal guard, hold times persisted and walked back) and
`packages/core/src/ledger.test.ts` (the hold-time fold, and the flash share
equal to `walletMetrics`' `fastHoldShare` on every accounting fixture). The
local run at the real tip against a copy of `pools_agg_pass` is in the pull
request.

## What phases 4 and 5 still owe

- **Phase 4, readers and the API deltas** (report section 8): every response
  shape is untouched in phase 1; phase 4 changes the readers and the web
  validators in one PR. Its first part, explore's and the pool page's market
  figures served from `agg_pool_hours` and `agg_pool_state` behind
  `MARKET_SOURCE=ledger` (off by default), is in
  `docs/LEDGER-MARKET-SERVING.md`; the leaderboard, wallet and creators
  readers still read the deep and broad tables.
- **Phase 5, cutover and retirement** (report section 9): the tip loop's
  Railway service against the ledger database, and 24 hours of it unattended
  with its lag under two batches, belong to it. The old indexer service stays
  down.

Decision D1 (wrapper-routed wallets on the board) is a query predicate on
`flags`; D2 (zero-cost inflows in ranking) was taken at the fold on 18 Sep
2026, `zero_cost_inflow` and `unattributed_outflow` each excluding the
position (migration 022 re-flagged the rows written before it, zeroed their
hours and pre-images and rebuilt the windows in one transaction; recording
each transfer's counterparty is a filed follow-up); D3's flip adds a
per-sale table fed by `LedgerSale`; D4 and D5 belong to phases 5 and 4. The pass leaves the
stream in mode `tip` once a fresh archive height leaves a gap under
`ledgerPassPolicy.catchUpMargin` (2,000 blocks) past the 128-block safety lag,
not on an exact zero gap: a chain that never stops producing blocks never
closes that gap to zero, so the cursor can sit up to about 2,128 blocks below
the archive height when mode flips to `tip`. Phase 3 takes it from there, and
takes over a stream a stopped pass left in mode `pass` as well.
