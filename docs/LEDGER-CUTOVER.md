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
- No `read_failed` with `57014` on any product read. A slow first pass after a
  redeploy is the fresh api process warming and settles; the cold database
  fails loudly instead, and the page cache goes cold on its own after about
  ninety idle minutes with no restart, so the flip was preceded by a hand-warm
  through a temporary api in ledger mode confirmed under half a second twice
  in a row (the reads are the warm-up; nothing can inspect residency).

Rollback stays the same pair: `DATABASE_URL` referencing the old `Postgres`,
`MARKET_SOURCE` deleted, the previous image redeployed.

Two visible consequences of the empty `broad_*` rollups follow from the
decision above and are not defects: the Live trades rail reads "Feed not
running", and the creators aggregate (`apps/api/src/creators-read.ts`), which
measures a launch by the broad rule whatever `MARKET_SOURCE` says, now counts
only launches with a deep publication in its still-trading, volume, median and
best columns (one creator reads 28 of 28 launches and 207 ETH where the old
path read 42 of 42 and 743 ETH). Launch counts and ranking are unchanged, and
no figure is invented for an unmeasured launch. Serving creators from the
ledger would close that gap.

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
