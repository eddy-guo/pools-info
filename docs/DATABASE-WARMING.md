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
screener volume ranking and launch strip, the creators page's first load (All
window, launches order, 25 rows), home leaderboard (24h, five rows, minimum
ten trades), traders (7d), the busiest ledger pool's 24h market, ledger cut
and a wallet profile. Smaller reads follow creators so their pages remain in a
tight shared cache. With the broad source it uses the same broad
serving readers. Empty databases have no pool or wallet to warm; they do not
invent an identity. All warm connections are read-only and use autocommit.

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
