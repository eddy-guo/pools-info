# The ledger's production cutover

The record of moving the aggregate ledger
([AGGREGATE-LEDGER.md](AGGREGATE-LEDGER.md), served as described in
[LEDGER-MARKET-SERVING.md](LEDGER-MARKET-SERVING.md)) into production: the
database, the token supplies FDV needs, the switch and the live feed. Every
figure here was read on 17 Sep 2026; nothing touched Alchemy.

## The ledger database

A new Railway Postgres service, `LedgerPostgres` (Postgres 18.6, the Hobby
plan's 5,000 MB volume), in the existing project beside the old `Postgres`,
which is untouched. It was built from the completed local pass database
`pools_agg_pass` (Postgres 18, port 5418): migrations 001 to 018 applied with
`node --import tsx apps/indexer/src/main.ts migrate`, then a data-only
`pg_restore --disable-triggers -j 4` of one custom-format `pg_dump`, so the
schema is exactly the repository's and the launch trigger does not write the
launch sources a second time.

| Table                                |        Rows | Why it is there                                                         |
| ------------------------------------ | ----------: | ----------------------------------------------------------------------- |
| `indexed_pools`                      |      62,858 | the catalog, every launch of `launches:agg:v1` through block 65,242,918 |
| `pool_launch_sources`                |      62,858 | the screener's launch filter reads it; references the launch batches    |
| `indexer_batches`, `indexer_streams` | 716, 62,859 | the launch stream's evidence, which the launch sources reference        |
| `agg_streams`, `agg_batches`         |      1, 716 | the ledger cursor (block 65,244,380) and its checkpoints                |
| `agg_pool_hours`                     |     166,098 | pool activity per UTC hour, 2026-07-30 16:00Z to 2026-09-17 09:00Z      |
| `agg_pool_state`                     |      61,575 | each traded pool's latest price and totals                              |
| `agg_live_trades`                    |     250,000 | the live ring                                                           |
| `agg_wallets`                        |     428,376 | `agg_live_trades.wallet_ref` references it                              |

Left behind: `agg_journal` (1,504,850 rows, 1.86 GB and a 1.01 GB index) for
good, since it is walk-back evidence the tip loop rewrites for itself; and
`agg_positions` (2,173,398 rows, 635 MB) and `agg_wallet_hours` (3,058,325
rows, 670 MB), which follow for the wallet, leaderboard and PnL surfaces and
bring the database to about 1.8 GB.

Row counts and an md5 of every restored table's rows (`md5(string_agg(md5(row::text)))`
in key order, time zone UTC) match the source exactly, with zero orphaned
references. The dump took 12 s (126 MB), migrations 4 s, the restore 44 s over
Railway's TCP proxy; the database is 470 MB.

Cost, from Railway's own per-service metrics priced at the account's unit
prices (RAM USD 10 per GB-month, CPU USD 20 per vCPU-month, volume USD 0.15 per
GB-month): the old Postgres runs about USD 10.3 a month (0.97 GB RAM, 3.9 GB
disk). The new one's bill follows its memory, and container memory counts the
page cache: straight after the restore it read 1.8 GB, a restart of the
then-unused service cleared that to 55 MB (about USD 0.8), and verification
reads warmed it back to 0.43 GB (about USD 4.5). It grows with the cache its
reads keep warm, and a Railway memory limit is the lever that caps it.

## Token supplies

FDV is price times `totalSupply()`. `pnpm supply:read run`
(`apps/indexer/src/token-supply.ts`) reads the supply of every catalog token
whose `indexed_pools.token_total_supply_raw` is null in Multicall3 aggregates
of 200 over the public RPC, one aggregate per request at most one a second,
pinned to a head read every 20 pages (the public RPC serves state only for
its last few thousand blocks), and stores each value with
`token_supply_block`. It refuses an Alchemy host, never falls back to one
request per token, and pages forward: a reply that is not one ABI word leaves
its token null, a call that reverts is isolated by halving its page and leaves
only that token null, and a later run resumes and fills new launches. The
columns are migration 019's.

The first run, into `LedgerPostgres` (11:11:27Z to 11:17:39Z, 372 s): 62,858
tokens read and none unreadable, from 334 HTTP requests to
`rpc.mainnet.chain.robinhood.com` (315 aggregates, 16 head reads and 3
transport retries, no 429). The reads span blocks 65,320,924 to 65,324,452.
Every token's supply is 1,000,000,000 whole tokens (1e27 raw, 18 decimals).
Blockscout's token API agrees for POOLS, FRONG, KAIJU, CONFETTI, HOOKR, UNICAT
and CYBERCAB. Migration 019 was applied from the reader change's own file
before the run, so its recorded checksum is that file's.

## Creator-fee flags

Whether a pool's creator takes a fee is decided by which strategy contract
launched it: the pinned registry (`packages/chain/src/deployments.ts`,
`docs/DEPLOYMENT-REGISTRY.md`) holds one flag per strategy, and the launch
lane resolves that deployment from the launch log's emitting address to verify
every launch it writes. Migration 021 stores it as `indexed_pools.creator_fees`
(nullable: null is unknown, never a stand-in for false), the lane writes it
with each launch from then on, and the pool page prefers it over the frozen
deep publication's flag, which answers only for a row written before the
column existed (`docs/LEDGER-MARKET-SERVING.md`, "Creator fee").

Rows written before the column are filled by `pnpm creator-fees:backfill run`
(`apps/indexer/src/creator-fees-backfill.ts`), which makes no chain request:
the launch stream `launches:agg:v1` retains every verified launch log in its
batch evidence, so the fill reads those logs back per batch, resolves each
emitting strategy through the same registry, restricts the result to the exact
pool ids selected in that batch, and writes the flag onto the pool whose
recorded launch transaction and block the log names, only where the flag is
still null. `run` fills the pools with no deep publication (the ones whose page
shows the stat as unavailable); `run --all` fills every unknown flag; `status`
counts both. It is idempotent and resumable, and a batch that fills fewer pools
than it was selected for is logged as `creator_fees_batch_short` rather than
hidden. On a copy of the production-shaped database (62,858 pools, 716 launch
batches, Postgres 18) `run --all` took 8 s, filled all 62,858 with no short
batch, and every one of the 1,364 deep publications' flags agreed with the
derived value: 59,392 launches from fees-on strategies, 3,466 from fees-off
ones.

The first production `run` selected 61,705 unpublished pools but the old write
passed every launch from those retained batches, so it filled 62,807 rows. The
extra 1,102 were published pools, and their derived flags agreed with all 1,102
publications. The exact-pool filter above closes that scope mismatch. The 21 Sep
daily `LedgerPostgres` backup then had 63,744 pools, 63,482 known flags and 262
unknown flags, all published and all selectable by `run --all` across six
retained batches (pool-id set md5 `3b4a407cc2b0977b854fa09a3e8308c3`). Before
running it on production, confirm that `LedgerPostgres` is still the active
target, open the proxy only for the command window, run `status`, require zero
unpublished unknowns and an exact 262-row `--all` plan (or reconcile any drift),
then verify `unknown=0`, no short batch and unchanged existing flags before
closing the proxy. The retired `Postgres` service is not a target.

## What the api reads, and what came across from the old database

The read API opens one `DATABASE_URL`, so `MARKET_SOURCE=ledger` alone reads
empty ledger tables in the old database. The switch is therefore two
variables: `DATABASE_URL` on the new service and `MARKET_SOURCE=ledger`.
Rollback is pointing `DATABASE_URL` back. Every table `apps/api/src` reads was
checked in `LedgerPostgres` before the switch.

- Copied from production's old database, read-only through a TCP proxy that
  was added for the copy and deleted after it: `analytics_accounting_pools`,
  `_positions`, `_trades` and `_prices` (1,364 / 49,401 / 127,079 / 127,079
  rows). `analytics_pool_snapshots` (1,364) came with them because the
  accounting pools reference it and every leaderboard, wallet, trade-share,
  following and search read joins it. Its foreign key needs only the 1,363
  deep-tier `indexer_batches` rows those snapshots cite (81 MB), and those
  came too, along with `token_images` (130). Foreign keys were checked on
  load and every table's row digest matches production's. With them, the
  reader on `LedgerPostgres` answers the leaderboard, a wallet's PnL, a trade
  share and following identically to production, except for
  `coverage.catalogPools` (62,858 against 62,464).
- Left empty by decision: `recent_*` (frozen since 16 Sep), the `broad_*`
  rollups (every catalog pool is ledger-covered) and `indexed_events` (deep
  observations the ledger outranks). `/v1/live-trades` then answers no events
  with coverage state `uninitialized`, and `/v1/feed` answers 503
  `feed_coverage_unavailable`. The live feed is dark until the ledger's tip
  loop runs; the reader does not serve it from `agg_live_trades`.

## The switch in production

Production has served from `LedgerPostgres` with `MARKET_SOURCE=ledger` since
18 Sep 2026 00:12:32Z (api deployment 32a0ecb8 on 88ac98f, `listening
marketSource="ledger"`). Three earlier flips on 17 Sep were rolled back within
minutes, none on wrong data: an empty screener Trend column (removed since),
a cold page cache on the ledger database (the screener's explore statement hit
the api's 3 s budget with `57014`), and the pool page's Creator fee stat
rendering its unavailable mark because the ledger path answers
`analytics: null` (fixed on the read side by the flag on `market.creatorFees`
and on the page by reading it where no accounted cut names it). The fourth
flip was held on three rollback conditions checked at equal weight, at the
first read and again after a thirty-minute watch, and every one must still
hold after any change to either path:

- FRONG's Creator fee stat reads Enabled or Disabled on the live site, never
  the unavailable mark. It is the only test of the flag's primary case, a
  published pool the ledger serves: the integration fixture cannot reach it
  because there a publication outranks the ledger, the opposite of production.
- `window=24h` and `window=7d` on the same pool return different figures. On
  the old path they were byte-identical for every pool (the broad rollups
  closed on 31 July), so identical figures mean the ledger is not being served
  whatever else looks right.
- No `read_failed` with `57014` on any product read. At the original cutover,
  the page cache could go cold after about ninety idle minutes, so the flip was
  preceded by a hand-warm through a temporary API in ledger mode, confirmed
  under half a second twice in a row. That historical procedure is superseded
  by the fail-closed automation in `docs/DATABASE-WARMING.md`.

Rollback stays the same pair: `DATABASE_URL` referencing the old `Postgres`,
`MARKET_SOURCE` deleted, the previous image redeployed.

Two visible consequences of the empty `broad_*` rollups followed from the
decision above and were not defects: the Live trades rail reads "Feed not
running", and the creators aggregate (`apps/api/src/creators-read.ts`), which
measured a launch by the broad rule whatever `MARKET_SOURCE` said, counted
only launches with a deep publication in its still-trading, volume, median and
best columns (one creator read 28 of 28 launches and 207 ETH where the old
path read 42 of 42 and 743 ETH, and 28 of the top 100 by launches had no
measured launch at all). Launch counts and ranking were unchanged, and no
figure was invented for an unmeasured launch. The creators read has followed
the switch since https://github.com/eddy-guo/pools-info/pull/115 (`docs/LEDGER-MARKET-SERVING.md`, "The creators
aggregate"): every launch the ledger covers is measured from its hours and
state, and on the walk recorded in that PR (production's rule and data beside
the ledger's on one copy) all 100 of the top 100 by launches are measured on
every launch (14,727 of 14,727; that creator reads 211 of 211 and 4,154 ETH),
the Launches column and the launch count at every rank are identical, 43 rows
swap places within their equal-launch-count tie groups on the served-volume
tie-break, and own-buy reads true on 85 rows against 59 under the ledger's
attributed evidence. The live feed stays dark.

## The trader leaderboard: the old board beside the new

The trader leaderboard was the last product read still on the copied
accounting tables after the switch above: frozen at 15 Sep 22:47Z, computed
over deep captures that stop minutes after each pool's launch, and excluding
every wrapper-routed position. `apps/api/src/ledger-leaderboard.ts` serves it
from `agg_wallet_windows` under the same `MARKET_SOURCE=ledger`
(`docs/LEDGER-MARKET-SERVING.md`, "The trader leaderboard"); it goes live
with the next api deployment on the switched service, no variable change.
The board is supposed to differ, and this is by how much, so that whoever
compares the two knows the change was expected. Walked with
`node scripts/leaderboard-walk.mjs <old api> <new api>` on 18 Sep 2026
01:5xZ: the old board from the production api
(`https://api-production-9f93.up.railway.app`), the new from a local api in
ledger mode over a production-shape copy of the ledger with its windows
refreshed to cursor 65,409,776 (17 Sep 13:40:27Z). Rerun it after the deploy
with both origins live to refresh the figures.

| window | old: shown / eligible, asOf | old top, bottom (realized) | new: shown / eligible, asOf | new top, bottom (realized) | shared |
| ------ | --------------------------- | -------------------------- | --------------------------- | -------------------------- | ------ |
| 24h    | 100 / 1,017, 15 Sep 22:47Z  | 1.0466 ETH, 0.0578 ETH     | 100 / 2,453, 17 Sep 13:40Z  | 76.0767 ETH, 2.6528 ETH    | 0      |
| 7d     | 100 / 1,405, 15 Sep 22:47Z  | 1.0466 ETH, 0.0706 ETH     | 100 / 9,206, 17 Sep 13:40Z  | 138.3626 ETH, 9.6893 ETH   | 0      |
| 30d    | 100 / 1,406, 15 Sep 22:47Z  | 1.0466 ETH, 0.0706 ETH     | 100 / 45,585, 17 Sep 13:40Z | 138.3626 ETH, 22.3487 ETH  | 0      |
| All    | 100 / 1,431, 15 Sep 22:47Z  | 1.0466 ETH, 0.0832 ETH     | 100 / 86,281, 17 Sep 13:40Z | 246.6491 ETH, 25.6153 ETH  | 0      |

Shape: identical, field for field (the integration test pins the key set to
the accounting mapper's); `unrealizedWei` is null on every new row where it
was a figure or null before, `coverage.pnlScope` reads
`attributed_positions_all_pools`, and `total` is at most 100.

Population: the old board's four windows all top out at the same wallet and
1.0466 ETH because its data ends on 15 Sep; the new board's eligible
population (`agg_wallet_windows` rows with 10 or more supported trades on a
supported position) is 2.4 to 60 times the old one per window, drawn from
61,613 pools with a trade and 428,610 wallets against the old 1,364 pools,
and no wallet of the old top 100 is in the new top 100 on any window. The
reason is the design report's section 4.5, verified again here: on 7d, 30d
and All every one of the new top 100 holds a wrapper-routed position (89, 72
and 67 of them hold nothing else), the sniper and copy-trade wallets the old
rule dropped with `unsupported_route`, and their token flow is
transfer-verified. Two population facts the captain should know before
looking: on 24h, 81 of the top 100 hold a zero-cost-inflow position (tokens
received without a purchase), whose sales realize their full proceeds with
no ROI (design decision D2 counts them; a predicate on the position flags
would exclude them), and the top wallets are bots by trade count (up to
43,063 supported trades on All).

Warm set for the deploy: the four default boards
(`/v1/leaderboard?window=<24h|7d|30d|All>&limit=100`, about 480 pages each
plus the coverage's catalog and pool-state counts) and the four `metric=net`
boards (the window's whole eligible set, about 8,600 pages on All), all
measured under 60 ms warm on the copy; the old 7d board cost 821 ms cold on
the accounting tables, and the new one's cold cost is the same order for the
catalog count and smaller for the board itself.

## Unattributed transfers excluded: the board before and after migration 022

The board above went live at 03:28Z on 18 Sep with 58 of its 24h top 100
resting on a cost basis under one percent of their realized figure (48 with
ROI null and volume equal to realized, 10 with ROI between 374 and 457
million percent): design decision D2 had `zero_cost_inflow` informational,
so a sale of tokens received without a swap booked its whole proceeds as a
supported win. The rows were creator-run distribution farms, and the board's
top row `0xb3c9cf93ec4eff830d01766681052607040c53b1` was the buying side of
one: on the production-shape copy it had launched all 85 pools it traded,
invested 308.93 ETH, sold part itself (+110.43 ETH realized) and moved
202.62 ETH of basis out as tokens (`outflow_cost_wei`) that its receivers,
about 43 wallets per pool, sold for 204.94 ETH, which is why its wallet page
read +198.89 ETH realized beside -122.54 ETH net on 18 Sep (realized - net =
spent - disposed cost = held cost + cost that left as tokens). D2 was taken
at the fold on 18 Sep 2026 (PR #108, `docs/AGGREGATE-LEDGER.md`): a transfer
the ledger did not attribute to a swap excludes the position, in
(`zero_cost_inflow`) or out (the new `unattributed_outflow`), and migration
`022_unattributed_transfers_exclude.sql` brought every row written under
the old rule to the new one in one transaction: re-flag, hour rows zeroed,
journal pre-images rewritten so a walk-back restores rows the new
constraints accept, the constraints, and the six windows rebuilt and
re-ranked with their refresh rows (byte-identical to the writer's own
rebuild). The alternatives, a transfer-out booked as a zero-proceeds
disposal and a rank by net, were rejected because both show a transfer to
one's own cold wallet as a loss; this rule invents nothing, and a move costs
that position's coverage rather than the truth. Recording each transfer's
counterparty at the fold and the attended wrapper/farm evidence registry are
specified in [TRANSFER-PROVENANCE.md](TRANSFER-PROVENANCE.md). Every address
without positive evidence is retained raw as `unregistered`, never guessed
from behavior.

The apply, 18 Sep 2026: `ledger-tip` deployment cdcf1179 on the merge
5550167; the old instance released the writer lock at 08:11:35Z, the new one
took it and ran `migrate()` (now after the lock, on its own connection with
an hour's statement budget; PR #108 moved it), `ledger_tip_started` at
08:13:47Z, so 022 took about 131 s on LedgerPostgres against 70 s (load 4)
and 145 s (load 11) on the copy; the first cycle at 08:14:07Z folded the
redeploy's 2,000-block gap (lag 247 blocks, 25 s) and the second at
08:14:27Z was at the tip (128 blocks, 13 s). Disk: the database read 2,430
MB (volume 2,874 MB of 5,000) before; the copy grew 473 MB on the same
migration. Production's shape at the apply: 2,209,267 positions of which
536,663 carried a transfer (508,838 still supported), 3,103,291 hour rows,
58,636 journal rows (the copy's pass-era journal had a million; the tip's
256 batches are small, so the pre-image steps were near-instant here).

Old beside new, on the production-shape copy `pools_test_zerobasis` (cursor
17 Sep 13:40:27Z, the same source as the table above; realized in ETH, the
full top 10 per window in the firstmate data directory
`pools-zero-basis-rank-z1/before-after.md`):

| window | old 100: cost 0 / under 1% | new 100: cost 0 / under 1% | of the old 100 survive | old top row                                           |
| ------ | -------------------------- | -------------------------- | ---------------------- | ----------------------------------------------------- |
| 24h    | 59 / 66                    | 0 / 0                      | 29                     | `0xb3c9…` rank 33 at 1.9323 (was 76.0766 at rank 1)   |
| 7d     | 4 / 6                      | 0 / 0                      | 71                     | `0x62cc…` rank 1 at 138.3625, unchanged               |
| 30d    | 5 / 7                      | 0 / 0                      | 59                     | `0x62cc…` rank 1 at 138.3625, unchanged               |
| All    | 3 / 4                      | 0 / 0                      | 48                     | `0xaead…` rank 2 at 104.0910 (was 246.6490 at rank 1) |

Production, read from the api at 08:15:04Z, one cycle after the apply: 24h
`0xb3c9…` at rank 40 with 1.4785 ETH (the live board is 19 hours past the
copy), top `0xcf4828…` 11.97 ETH; 7d, 30d and All `0x62cc…` rank 1 at
138.3626 ETH, All then `0xaead…` 104.09 and `0x3012…` 96.38, the copy's
figures to the wei; on all four windows no row with realized above zero and
ROI null, none above 10,000 percent, ROI between 4.4 and 3,304 percent,
every row on a positive disposed cost. The launcher's own page reads 14
supported and 115 excluded positions, realized equal to net (1.4785 ETH on
24h, 3.2957 ETH on All). Production's pre-apply top 100 was not archived,
so its survivor counts are the copy's.

Two things to know when reading the board now. Eight of the All top 9 on
the copy, before and after, launched every pool they trade
(`indexed_pools.launch_sender`), including the new #1 `0x62cc…` (35 pools,
no transfers): the rule removes the sybil receivers and the launchers that
fan tokens out, and a launcher that buys and sells its own launches without
moving tokens keeps its place; a "trades own launches" flag is derivable
from `launch_sender` with no fold change, a product decision not taken. And
the rollback lever: the journal restores batches, not the migration (its
pre-images now carry the new rule); undoing the rule is a code revert plus
a migration that restores 017's constraints and re-supports the transfer
positions, which brings back their flag state and every position row's
lifetime figures (022 did not touch them) but not the per-hour finances the
migration zeroed, which the ledger keeps nowhere else, so the old board
figures return only from a LedgerPostgres snapshot taken before 08:11:36Z
or a re-fold with `pnpm ledger:pass` (day-scale, on the captain's word).
No such snapshot exists: read at 08:3xZ the same day, Railway holds no
backup and no backup schedule for the volume (instance c29bc41c on
`postgres-volume-Beld`), and volume backups are not available on the
project's Hobby plan (`subscriptionPlanLimit.volumes.maxBackupsCount` is 0;
Pro, USD 20 minimum usage a month against Hobby's 5, allows them, billed
like volume storage on the backup's incremental size, and a manual backup is
limited to half the volume's size, so this 5 GB volume at 2.9 GB used would
first have to grow). Enabling them is a plan change the captain decides.

## The wallet page: the frozen route beside the ledger's

Every row of the ledger's board links to `/wallet/<address>/?window=<w>`,
and until `apps/api/src/ledger-wallet.ts` that route still read the copied
accounting tables, in which the ledger's top traders have no supported row:
the click-through from the board landed on an empty profile. The wallet
reader now serves the header and the window figures from the wallet's own
`agg_wallet_windows` row and the positions from `agg_positions` under the same
`MARKET_SOURCE=ledger` (`docs/LEDGER-MARKET-SERVING.md`, "The wallet page");
it goes live with the next api deployment on the switched service, no
variable change. The numbers are supposed to differ from the frozen route's,
and this is by how much. Walked on 18 Sep 2026 03:5xZ: the frozen route
read live from the production api
(`https://api-production-9f93.up.railway.app`) and from the same reader over
a copy of the production accounting tables (frozen at 15 Sep 22:47Z), the
ledger route from the new reader over a production-shape copy of the ledger
with its windows refreshed to cursor 65,409,776 (17 Sep 13:40:27Z), the
copy PR 102's board was walked on.

### The difference walk: the live 24h #1

`0xb3c9cf93ec4eff830d01766681052607040c53b1`, the first row of the first
production board served from the ledger (18 Sep 03:28:53Z), field by field
on `window=24h`; the other three windows differ only as noted below.

| field                                                     | production, frozen tables (live read) | frozen copy                     | ledger copy                                                        |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `wallet.rank`                                             | null                                  | null                            | 1                                                                  |
| `wallet.realizedWei`                                      | null                                  | null                            | 76.0767 ETH                                                        |
| `wallet.netWei`                                           | null                                  | null                            | -64.1605 ETH                                                       |
| `wallet.unrealizedWei`                                    | null                                  | null                            | 0 (85 flat positions)                                              |
| `wallet.volumeWei`                                        | 0                                     | 0                               | 373.5195 ETH                                                       |
| `wallet.roi`                                              | null                                  | null                            | 96.7861                                                            |
| `wallet.wins` / `losses` / `winRate`                      | 0 / 0 / null                          | 0 / 0 / null                    | 66 / 1 / 98.5                                                      |
| `wallet.tradeCount` / `supportedTradeCount`               | 0 / 0                                 | 0 / 0                           | 300 / 300                                                          |
| `wallet.supportedPositionCount` / `excludedPositionCount` | 0 / 0                                 | 0 / 0                           | 85 / 0                                                             |
| `wallet.bestWei`                                          | null                                  | null                            | 5.1012 ETH                                                         |
| `wallet.avgHold`                                          | null                                  | null                            | 461.6 s                                                            |
| `wallet.last`                                             | null                                  | null                            | 17 Sep 13:26:35Z                                                   |
| `wallet.asOf` / `completeWindow`                          | null / false                          | null / false                    | 17 Sep 13:40:27Z / true                                            |
| `positions.length`                                        | 0                                     | 0                               | 85 (all supported, all `wrapper_route`, 9 also `zero_cost_inflow`) |
| `trades.length`                                           | 0                                     | 0                               | 0                                                                  |
| `curve.length`                                            | 0                                     | 0                               | 0                                                                  |
| `launches.length`                                         | 129                                   | 79                              | 85 (the copy's catalog)                                            |
| `coverage.asOf`                                           | 15 Sep 22:47:15Z                      | 15 Sep 22:47:15Z                | 17 Sep 13:40:27Z                                                   |
| `coverage.pnlScope`                                       | `supported_pool_positions_only`       | `supported_pool_positions_only` | `attributed_positions_all_pools`                                   |

On 7d, 30d and All the ledger route answers rank 2, 3 and 5 with 110.4341
ETH realized, -92.1833 ETH net, 525.6767 ETH volume, 91 wins to 2 losses over
417 trades and a 500.4 s average hold, the frozen route the same nulls and
zeros as on 24h. The response's key set and the summary's key set are equal
between the two routes (the integration test pins both to the accounting
mapper's). Net is negative while realized is positive because this wallet
transfers most of what it buys out of the pool rather than selling it: on
its first position, 3.68 ETH invested, 2.1456 ETH of proceeds against 0.9028
ETH of disposed cost (realized +1.2428 ETH) and 2.777 ETH of basis sent away
as tokens (`outflow_cost_wei`), which is the ledger's own invariant
`invested = cost + disposed_cost + outflow_cost`.

### The population walk: the 24h top 100

For each wallet on a 24h board, the wallet route on both sides: "populated"
is a header with a realized figure (`wallet.realizedWei` not null), which
is what the page shows as the eight stats and what the frozen route lacks
for a wallet with no supported row.

| board                                                     | route                       | populated header | ranked | with positions | with trades | known to the store |
| --------------------------------------------------------- | --------------------------- | ---------------- | ------ | -------------- | ----------- | ------------------ |
| production's live 24h top 100 (asOf 18 Sep 03:46:29Z)     | frozen                      | 3                | 3      | 32             | 20          | 32                 |
|                                                           | ledger copy (17 Sep 13:40Z) | 93               | 40     | 93             | 82          | 93                 |
| the ledger copy's own 24h top 100 (asOf 17 Sep 13:40:27Z) | frozen                      | 0                | 0      | 15             | 5           | 15                 |
|                                                           | ledger copy                 | 100              | 100    | 100            | 100         | 100                |

The 7 of production's live top 100 the copy does not know first traded after
the copy's cursor, and the 53 it knows but does not rank on 24h had their
ranked hours after it too: on production, where the board and the profile
read the same cursor, every ranked wallet has the row it is ranked by, so
all 100 render a populated header with their rank, as the copy's own top
100 do. On the frozen route, 3 of the live top 100 render a header (the
wallets that also had a supported deep-tier position by 15 Sep) and 97 an
empty one; 68 of them are wallets the accounting tables never saw at all.
The slowest ledger read of the 200 was 46 ms warm.

What the ledger route left empty on purpose at that walk: `trades` (no row
per sale in the ledger, design decision D3, so the Trades tab reads 0 and no
trade-share link is emitted from it; still empty) and `curve`, both of
which the page already rendered empty for every wallet the frozen route has
no rows for, which is the state the frontend home captured as its "before".
The curve landed in the next slice (PR https://github.com/eddy-guo/pools-info/pull/111): the hourly cumulative realized
from `agg_wallet_hours`, one point at the end of each hour with a sale on a
supported position, ending on the header's figure, so on a clean wallet the
curve's endpoint equals the realized the header shows; its frozen-versus-
ledger walk for the 7d leader `0x62cc49d34520f821f851f7f7073e8d6e4184675c`
(15 points to 138.362590 ETH, the header's figure to the wei) and the
launcher `0xb3c9cf93ec4eff830d01766681052607040c53b1` is in that pull
request, and the points, rule and cost are in `docs/LEDGER-MARKET-SERVING.md`
"The wallet page".

## Reading our figures against pools.xyz

The screener's and pool page's 24h volume and trades are the swaps in the
token's Pools launch pool on the Uniswap v4 PoolManager (the ETH leg), summed
over whole UTC hours ending at the ledger cursor. pools.xyz counts every trade
row it attributes to the token across venues, including Uniswap v3 pools and
aggregator routes, one row per venue leg, over a rolling 24h in USD. For FRONG,
raw HyperSync Swap logs over the ledger's window reproduce its 2,378 swaps and
295.2478 ETH exactly. In the hour 08:00-09:00Z, pools.xyz's 78 rows are our
52 swaps plus 14 other-venue legs inside the same transactions and 12
transactions with no launch-pool swap. So established tokens read about 27%
below pools.xyz on volume, while launches from the last day agree within
about 1%.

Change differs by definition too. Ours is the latest price against the last
price before the window, in ETH, and null for a pool launched inside the
window. pools.xyz's is in USD over its rolling window, with a different
baseline. The third parties disagree with each other as well: FRONG's 24h
volume read USD 1.53M on Blockscout (CoinGecko's figure) and USD 1.00M on
pools.xyz.

## The old database retired, and the backup that replaces it

The old Railway `Postgres` (service 479062d3, volume `postgres-volume`) was
deleted on 21 Sep 2026 at 03:36:55Z after a read-only pass (no service but the
stopped indexer referenced it; the indexer stays down for good and keeps its
dangling `${{Postgres.DATABASE_URL}}` so that any attempt to start it fails
loudly), a verified final `pg_dump` (1,038,972,561 bytes, sha256
`eccb9e63…3ea22`, `pg_restore --list` 258 entries over 37 tables with rows)
kept in the firstmate home under
`data/pools-creators-ledger-measure-m1/archive/`, and the volume's deletion
(pending 48 hours on Railway's side). Railway's own usage metrics priced the
idle service at about USD 2.61 per 30 days. The record with every reading is
`old-postgres-retirement.md` beside the archive.

`LedgerPostgres` is now the only production database, on the Hobby plan with
no managed backup (the captain's ruling: a demo does not need the Pro plan).
Its backup is a **daily refresh of the local production-shaped copy**:

- Cadence: once a day, at a quiet hour (production reads warm again after it;
  a full dump reads every table once through the 128 MB `shared_buffers`, so
  run it when nobody is looking rather than at the top of a trading hour).
- Command, from any shell on the captain's machine with the `railway` CLI
  logged in and the Postgres 18 test server up:
  `bash ~/.treehouse/firstmate-7bab20/1/firstmate/data/pools-backups/ledger-backup.sh`.
  It opens a TCP proxy on `LedgerPostgres` for the window only and deletes it
  the moment `pg_dump` returns (also on any failure), dumps in custom format
  with the Postgres 18 `pg_dump`, verifies the file with `pg_restore --list`
  (a dump that cannot be listed is not a backup and the script stops there),
  restores it into `pools_prod_backup` on `127.0.0.1:5418` (dropped and
  recreated each run; `pools_prod_shape`, which `ledger-replay.test.ts`
  reads, is never touched), records the size and sha256 in a `.log` beside
  the dump, and keeps the last seven dumps in that folder. It prints no
  credential, connection string or proxy host.
- Last refresh: **2026-09-21T03:38:18Z to 03:40:31Z**, ledger cursor
  68,480,859 (03:37:51Z), `ledger-20260921T033818Z.dump` of 431,178,307
  bytes, sha256 `92c8352b…588b`, 272 entries over 38 tables with rows,
  restored as 63,744 pools and 2,288,768 positions.
- Nothing in this repository or in a task worktree can run it unattended: a
  worktree is disposable and the worker that wrote the script is torn down
  with it, so the refresh is a standing daily item in the firstmate backlog,
  run by hand or by whatever scheduler the captain's machine offers, and the
  date on the newest file in `data/pools-backups/` is the truth of whether it
  happened. A missing day means no backup for that day, not a silent one.
