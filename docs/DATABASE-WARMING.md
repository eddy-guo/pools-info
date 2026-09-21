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
normalizes product failures to its existing `data_unavailable` contract.

`apps/api/src/database-warmth.ts` owns the policy and readiness state.
`apps/api/src/warm-set.ts` invokes the current serving readers in order:
screener volume ranking and launch strip, home leaderboard (24h, five rows,
minimum ten trades), traders (7d), the busiest ledger pool's 24h market,
ledger cut and a wallet profile. With the broad source it uses the same broad
serving readers. Empty databases have no pool or wallet to warm; they do not
invent an identity. All warm connections are read-only and use autocommit.

Startup and new database identities trigger warming. The API reads
`pg_postmaster_start_time()` once per new pooled connection, before using it.
Idle connection failures, product statement cancellation (`57014`) and slow or
failed warm reads drop readiness. Three bounded attempts run sequentially;
failure leaves the gate closed until a later retry. Each warm purpose must
finish within the 2.8-second serving budget. Warm statements may run up to ten
seconds to populate pages; a whole attempt is limited to one minute.

The five-minute keep-warm cadence also detects ordinary cache eviction.
Restart identity is a fast path, not a cache-residency probe. Eviction between
cadence runs can still cause the first visitor's slow failure before the
backstop closes the gate. This bounds exposure to a cadence interval; it does
not promise absolute absence of timeouts. Never substituting stale preloaded
figures is absolute.

The ledger tip service reuses these readers and credentials. It reads database
identity once per cycle, starts due warming only in its idle polling window,
and disconnects the warm connection as soon as the next cycle wins. It never
waits for the warm set to finish, writes through that connection, or holds a
warm transaction across loop writes. An interrupted set remains due for the
next idle window. Its existing service supervisor reconnects after a database
restart; no new service or deployment setting is required.

Regression coverage: `database-warmth.test.ts`, `warming-http.test.ts`,
`warmup.integration.test.ts` and the idle-preemption case in
`apps/indexer/src/ledger-tip.test.ts`. Integration checks require the dedicated
`TEST_DATABASE_URL`; never restart a shared test server or production to test
this feature. Local restart evidence belongs with the task's acceptance record.
