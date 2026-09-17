# The aggregate ledger: phase 1

The aggregate architecture replaces the per-pool evidence tiers with one
ledger built from HyperSync: every registered PoolManager `Swap` and every
ERC-20 `Transfer` of a registered token folds into positions, hour buckets and
pool state, with the evidence hash retained and the bytes dropped. The design,
its measurements and its decisions are the scout report
`data/pools-aggregate-design-s5/report.md` in the firstmate home (sections 4,
6, 7.2 and 11 are the ones this phase implements); the captain approved it on
16 Sep 2026 with the report's recommended answers to D1 to D5 as defaults.
This document records what phase 1 delivers, where it deviates from the
report and why, and what phases 2 to 5 still owe.

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

## What phases 2 to 5 still owe

- **Phase 2, the pass** (`apps/indexer/src/ledger-pass.ts`, report 7.1): the
  HyperSync launch, swap and transfer lanes over `packages/chain/src/hypersync.ts`,
  launches verified by `decodeLaunch` and written through a new discovery
  stream `launches:agg:v1` (the ledger verifies each launch is registered and
  counts it), name, symbol and decimals through Multicall3 on the public RPC,
  progress counters, the 128-block lag from `archive_height`, and a full local
  pass that reproduces the calibration ranges and the three wallets.
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
fed by `LedgerSale`; D4 and D5 belong to phases 5 and 4.
