# The ledger's production cutover

The record of moving the aggregate ledger ([AGGREGATE-LEDGER.md](AGGREGATE-LEDGER.md))
into production: the database, the token supplies FDV needs, the switch and the
live feed. Every figure here was read on 17 Sep 2026; nothing touched Alchemy.

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
disk) and the new one about USD 0.8 idle (55 MB RAM). Container memory counts
the page cache: straight after the restore the new service read 1.8 GB, which
a restart of the then-unused service cleared, so its bill grows with the cache
its reads keep warm.

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
