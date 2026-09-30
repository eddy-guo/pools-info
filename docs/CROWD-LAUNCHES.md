# Crowd launches

pools.xyz's "Crowd" quick launch sells a token in a Uniswap continuous
clearing auction (CCA) and, when the auction graduates, migrates the raise and
a token reserve into an ordinary v4 pool on the same PoolManager. Captain's
decision (25 Sep 2026, option B of the sizing report
`pools-cca-scope-scout-c1`): index the pools.xyz crowd launches as catalogue
and market data, count their trading like any other launch, and show auction
entrants as excluded. Exact auction cost basis (option C) is deferred.

## What counts as a crowd launch

Contracts (`packages/chain/src/crowd.ts`, verified source on Blockscout):

| Contract                         | Address                                      |
| -------------------------------- | -------------------------------------------- |
| ContinuousClearingAuctionFactory | `0x000000001f26a0044baa66024e7b6599c61963f8` |
| LBPStrategy v1 (4-hour auctions) | `0x05d552391067389ee44fec3924157ed33f976000` |
| LBPStrategy v2 (1-hour auctions) | `0xbf1ab81f7d534b2cc0da76fcf4d541322bb0e000` |

A launch spans two transactions:

1. **Creation**, through pools.xyz's LiquidityLauncher: the factory's
   `AuctionCreated(auction, token, amount, configData)` and the strategy's
   `InitializerCreated(auction, MigratorParameters)`, beside the launcher's
   own logs and the UERC20Factory's `TokenCreated` metadata.
2. **Migration**, permissionless and usually sent by a keeper, hours or days
   later: the strategy's `Migrated(auction, PoolKey, sqrtPrice, plan)`, whose
   indexed key topic is the v4 pool id.

The pools.xyz template rule (`crowdAuctionOf`): 500,000,000 tokens (18
decimals) auctioned, raised in ETH, unsold tokens to `0x…dEaD`, an auction of
144,000 or 36,000 blocks, funds to the emitting strategy, a hookless pool,
and LP positions paid to one of pools.xyz's pinned fee splitters (whose
registry flag becomes the pool's `creator_fees`). At migration the creation
transaction must also carry a pinned launcher's log, and the migrated pool id
must be the auction's own hookless ETH/token pool. Over the factory's whole
history (1,007 graduations, 25 Sep 2026) this admits exactly the report's 54
pools; `packages/chain/src/crowd.test.ts` replays every recorded graduation
(`fixtures/crowd/graduations.json.br`, read from Blockscout) against it and
`fixtures/crowd/template-pools.json` lists the 54.

A crowd pool is registered at its migration: `launch_block`/`launch_tx`/
`launched_at` are the migration, `launch_sender` is the wallet that created
the auction (crediting the keeper would misattribute every crowd launch), and
`indexed_pools.launch_type = 'crowd'` (migration 024).

## The crowd lane

Crowd pools fold through a ledger stream of their own, `ledger:crowd:v1`,
with a catalogue stream `launches:crowd:v1` in lockstep, written by the same
writer into the same `agg_*` tables. Its pools are never in the main stream's
registry nor the main pools in its (`ledgerRegistry` and `applyLedgerBatch`
filter by `launch_type`), and the fold is per token, so the two streams never
touch the same position, hour or pool row and every Instant row stays byte for
byte what the main stream alone writes (`apps/indexer/src/ledger-crowd.test.ts`).

One crowd range (`collectCrowdRange`, `packages/chain/src/hypersync-crowd.ts`):

1. The launch lane: the factory's `AuctionCreated` and the strategies'
   `InitializerCreated`/`Migrated`, logs and blocks only.
2. Template creations are remembered in `crowd_auctions` (auction to creation
   block; an index, never evidence), rewound with the batch that saw them.
3. For each `Migrated` of a remembered or in-range template auction, its
   creation block is read again with the launchers' and metadata factory's
   logs and transactions, and the launch is verified from that read alone;
   a graduation that fails is recorded in the batch's `rejected` list.
4. Swaps of every crowd pool by pool id, and transfers of every crowd token
   from its pool's migration on. At each migration, a separate read of every
   token Transfer from auction creation through the preceding block carries
   claims and onward transfers into the exclusion fold.
5. The cutoff header; name, symbol, decimals and supply over the public RPC.

`verifyCrowdLaunchBatch` re-derives every pool, remembered auction, transfer,
rejection and metadata issue from the retained rows before commit.

## Inside the tip loop

`runLedgerCrowdStep` (`apps/indexer/src/ledger-crowd.ts`) runs after the
main range of every tip cycle, on the same HyperSync client, pacer and token:

- **Catch-up.** From an empty stream it folds the crowd history from the
  ledger's start block in ranges of 100,000 blocks growing to 1,000,000 while
  quiet, for at most 60 s of each cycle; the loop
  skips its poll wait while the lane is behind. The 54 pools' history is
  about 0.7M logs; at the pages the pass measured that is 300 to 800
  requests, about an hour at the token's spare rate. Nothing runs from a
  workstation.
- **Following.** Level with the main cursor, it extends to the main cursor
  every cycle: launch lane, swaps, transfers and the cutoff header, about four
  requests. Ranges end on a main checkpoint where one lies in them, so its
  reconcile reads no header.
- **Reorgs.** The crowd cursor never passes the main one. A crowd cursor above
  the main cursor (the main stream walked back) or off the canonical chain
  walks the crowd stream back to its newest checkpoint that is neither. The
  streams share `agg_wallets`, so a walk-back keeps a wallet it created while
  the other stream's rows name it.
- **Failures.** A throttle pauses the loop and a rejected token stops it,
  following the main lane's rules ([aggregate ledger stops](AGGREGATE-LEDGER.md#phase-3-the-tip-loop));
  they share the token. Any other crowd failure is logged
  (`ledger_crowd_failed`), backs the lane off for 1, 2, 4 … 64 cycles, and the
  main stream carries on.
- **Windows.** A crowd batch recomputes the leaderboard window rows of the
  wallets it touched inside its own transaction
  (`recomputeLedgerWindowWallets`), since the main stream's journal-driven
  refresh never sees them.

`LEDGER_CROWD_ENABLED=0` leaves the lane out.

## Serving

`ledgerLaunchSql`/`ledgerSourceSql` (`apps/api/src/ledger-market.ts`) serve a
crowd pool from the ledger only while the crowd stream's cursor height and hash
match the main cursor; otherwise it is listed but
unmeasured, as any unmeasured launch is, rather than cut at an older block
under the main cutoff. Every catalogue row carries `launchType` (explore
items, the pool page's `pool`, a creator's `bestLaunch` and a wallet
profile's `launches[]`, all through `catalogPool` in
`apps/api/src/explore-read.ts`), and `/v1/explore?view=crowd` lists the crowd
launches. A creator's launch count and medians include their crowd launches.

## Accounting

An auction entrant's tokens come from the auction contract, not a swap: the
transfer is a zero-cost inflow and the position is excluded
(`zero_cost_inflow`), as any unattributed inflow is. Pre-migration onward
transfers carry the sender's outflow and recipient's zero-cost inflow through
the same transfer fold. The auction's raise is not pool volume, and the
migration's liquidity arrives as `ModifyLiquidity`, which the ledger does not
read.

## History

Every template auction was created after the ledger's start block (the first
at 28,575,416, the ledger starts at 23,467,030), so no crowd pool has a
truncated history, and the lane cannot admit one whose creation precedes its
start. The start-block check on `agg_streams` is unchanged.

## Acceptance on a production-shaped copy (27 Sep 2026)

A TEMPLATE copy of the local production-shaped ledger (main cursor
65,409,776, 17 Sep 13:40Z; 62,896 Instant pools, 2.18M positions) was
migrated with the crowd migration, now numbered 024, and the crowd lane was run
over it through `runLedgerCrowdStep`,
answered from recorded data only: the 1,007 graduations of
`fixtures/crowd/graduations.json.br` and the 54 template creations'
transactions and logs from Blockscout. It took 46 ranges and 225 requests
with no trade pages in them, and left the crowd stream level with the main
cursor on the same hash.

- Exactly the 54 template pools registered, each with its migration as the
  launch, the auction's creator as `launch_sender`, the explorer's name and
  symbol, and 49 with creator fees.
- Every Instant row of `indexed_pools` (less `launch_type`), `agg_pool_hours`,
  `agg_pool_state`, `agg_positions`, `agg_wallet_hours`, `agg_wallet_windows`,
  `agg_wallets`, and the main stream's batches, journal, live trades and
  window refreshes hashed the same before and after.
- 229 read-API responses (explore every window and sort to offset 500,
  gainers/new, the leaderboard every window and metric, creators every
  window and sort, 39 pool pages and 24 wallet profiles), served by `main`'s
  api code before and this code after, were identical apart from the added
  `launchType`, `generatedAt` and `coverage.catalogPools` (+54). Instant rows
  kept their figures and order; a crowd row takes its place in launch order,
  and only crowd creators' rows changed on the creators board.

Not yet measured: crowd trading. XBOW's volume against an on-chain recount
(the sizing report counted 599 swaps and 133.13 ETH over 24 Sep 21:46Z to
25 Sep 21:50Z) and its auction entrants' exclusion are checked on production
once the crowd lane has caught up, reading the explorer at about one page
every 3 s after its daily credit reset and stopping below 30,000 credits
left, since the free key also serves the site's wallet Trades tab.

## Out of scope

The 897 other ETH-paired CCA graduations (LILUNI among them), ERC-20-paired
auctions (NOTE/USDG), and the exact auction basis
(`BidSubmitted.amount - BidExited.currencyRefunded` per bid).
