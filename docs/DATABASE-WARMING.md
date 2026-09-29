# Database reader warming

The read API refuses database-backed product routes while warming with HTTP
503, `{"error":"data_temporarily_unavailable","reason":"warming"}` and
`Retry-After: 5`. The gate runs before response caches and request coalescing;
responses from an earlier readiness generation cannot be published after
invalidation. `/ready` still checks database/schema access and returns 200
while warming. `/health`, Blockscout wallet history and ETH price retain their
own behavior. Icons refuse with the database routes.

The website's existing unavailable behavior is a prerequisite: live failures
must never substitute the committed preloaded dataset. `PRODUCT_FIXTURES=1`
is an explicit test deployment, not a fallback. The current website proxy
normalizes the API error code to its existing `data_unavailable` contract while
preserving `reason: "warming"` and a valid `Retry-After`. `fetchProduct`
(`apps/web/src/lib/use-product.ts`) keeps honoring that guidance across
repeated warming responses, one 12-second request at a time, as long as the
next retry lands within 60 seconds of the first request - matching this
page's own one-minute warm-attempt budget above. A database still warming
past that ceiling, or a warming response with no usable `Retry-After`, is
finally reported unavailable rather than retried forever.

`apps/api/src/database-warmth.ts` owns the policy and readiness state.
`apps/api/src/warm-set.ts` invokes the current serving readers in order:
screener volume ranking and launch strip, every creators directory window
(24h, 7d, 30d, All) and sort (launches, volume, median) at 25 rows plus
All-window pages of 50 and 100 rows for each sort, home leaderboard (24h, five rows, minimum
ten trades), traders (7d), the busiest ledger pool's 24h market, ledger cut
and a wallet profile. Smaller reads follow creators so their pages remain in a
tight shared cache. With the broad source it uses the same broad
serving readers. Empty databases have no pool or wallet to warm; they do not
invent an identity. All warm connections are read-only and use autocommit.
The warm set calls `readData` directly, so it fills database pages rather than
the API's HTTP response cache; a visitor's first request is still a cache
miss. Nonempty first pages get their total from the ranking statement itself,
so they do not issue the separate empty-page count query.

The 29 Sep private PostgreSQL 18.6 replay copied `pools_test_creatorwalk`
(62,896 pools and 2,175,993 positions), applied current migrations, and used
128 MB shared buffers with `debug_io_direct=data`. The API and this private
Postgres were restarted before each measurement. With the earlier single
creators warm read, all 12 first-page window/sort requests answered HTTP 200
in 214-353 ms after warm-up; the All-window 50/100 launch pages took 343/353
ms. The ranked statement was the largest part of one profiled All/median/100
read at 219 ms, followed by the page's own-buy probe at 68 ms. This lab did
not reproduce the reported minute of `unavailable`, so it does not establish
that the missing warm variants alone caused it. With the expanded warm set,
startup warming finished in 5,614 ms and all 12 first-page requests answered
HTTP 200 on cache misses in 219-548 ms; the six All-window 50/100 pages took
272-410 ms. The gate and `/ready` behavior are unchanged.

The 29 Sep gate replay on a fresh `pools_prod_backup` copy
(`pools_test_q8_coldrestart`) applied migrations 023-026 with `migrate()` and
restarted the API in ledger mode. The copy held 64,625 indexed pools and
2,405,682 positions. After the warm set completed, all 18 first HTTP creators
reads returned 200 with `X-Data-Cache: MISS` in 272-1,407 ms, below the
3,000 ms budget. The [per-URL timings](evidence/creators-q8-coldrestart-2026-09-29.json)
include every default window and sort and the 50/100-row All pages. Migration
024 created `crowd_auctions`, which remained empty in this copy; migration
alone does not replay the crowd lane's later chain data. This run restarted
the API, not the PostgreSQL postmaster, so its timings do not measure a cold
operating-system page cache.

After this change merges and the Railway `api` service reports the deployed
commit, check all 12 creators first-page window/sort URLs and the six
All-window 50/100-row URLs against the production API. Record the deployment
SHA, timestamp, HTTP status, `X-Data-Cache` and end-to-end time for each URL;
each first cache miss must return 200 within 3,000 ms. This is a post-deploy
check, not a pipeline test against an undeployed commit.

The following 27 Sep local PG 18.6 production-copy replay predates the
first-hit creators probe described in `docs/LEDGER-MARKET-SERVING.md` ("The
creators aggregate"). It used `debug_io_direct=data`,
a cold restart, one warm set, then a direct serving read. The figures below are
8 KB `shared_blks_read` blocks from `pg_stat_statements`. Three cold restarts
per warm-set order gave the same counts for the immediate creators read; a
separate direct probe checked each other purpose after its own restart and
warm-up.

| Shared cache | Creators with no creators warm read | Creators before the smaller reads | Creators last | Other direct reads that increased when creators ran last       |
| ------------ | ----------------------------------: | --------------------------------: | ------------: | -------------------------------------------------------------- |
| 128 MB       |                              34,103 |                            33,405 | 31,807-31,814 | Home leaderboard 0 to 3; traders 0 to 34; busy pool 0 to 1,142 |
| 256 MB       |                              33,633 |                            24,964 |        24,964 | None                                                           |

At 128 MB, moving creators last saved about 1,600 blocks on its next read but
made the home, traders and busy-pool reads fetch blocks from disk. The screener
fell from 13,836 to 13,460 blocks; launch strip, wallet and ledger cut were
unchanged. At 256 MB, the order made no measured difference. The earlier
creators position retained the other reads' cache residency at 128 MB, while
its own next read still fetched about 33,400 blocks. Those residual disk reads
showed that warming alone could not rule out the original 3-second timeout
under production load; they do not describe the current first-hit query's
read cost.

Startup and new database identities trigger warming. The API reads
`pg_postmaster_start_time()` once per new pooled connection, before using it.
Idle connection failures, product statement cancellation (`57014`) and slow or
failed warm reads drop readiness. A warm set is three bounded attempts one
second apart; a set that fails leaves the gate closed and the API retries the
whole set after a back-off of 1, 2 and 4 seconds, then every 5 seconds until
one warms, never waiting for the next cadence. One set runs at a time and the
next is armed only once it settles. A new database identity resets the
back-off and makes warming due immediately; the gate reopens only after a
successful set. Each warm purpose must finish within the 2.8-second serving
budget. Warm statements may run up to ten seconds to populate pages; a whole
attempt is limited to one minute.

The five-minute keep-warm cadence also detects ordinary cache eviction.
Restart identity is a fast path, not a cache-residency probe. Eviction between
cadence runs can still cause the first visitor's slow failure before the
backstop closes the gate. This bounds exposure to a cadence interval; it does
not promise absolute absence of timeouts. Never substituting stale preloaded
figures is absolute.

The ledger tip service reuses these readers and credentials. It reads database
identity once per cycle, starts due warming only in its idle polling window
(a failed set is due again after the same back-off, not a cadence later),
and cancels the warm backend before disconnecting its connection as soon as
the next cycle wins. It never waits for the warm set to finish, writes through
that connection, or holds a warm transaction across loop writes. An
interrupted set remains due for the next idle window. Its existing service
supervisor reconnects after a database restart; no new service or deployment
setting is required.

Regression coverage: `database-warmth.test.ts`, `warming-http.test.ts`,
`warmup.integration.test.ts` and the idle-preemption case in
`apps/indexer/src/ledger-tip.test.ts`. Integration checks require the dedicated
`TEST_DATABASE_URL`; never restart a shared test server or production to test
this feature.

Local restart verification, 27 Sep 2026: the API (`MARKET_SOURCE=ledger`) ran
against a private, migrated Postgres 18 cluster. `/v1/explore` was polled every
200 ms while `pg_ctl stop -m fast` held the database down for 8 seconds before
`pg_ctl start`. Three restarts each way, in seconds from the new postmaster
accepting to the first served read: before the back-off, 289.8, 288.6 and
288.8; with the back-off, 2.1, 2.1 and 2.1. The earlier Railway memory-cap
canary measured 71, 9 and 257 seconds across three restarts.
