# Persistent Pools indexer

The project uses one repository, a Vercel Next.js website, and a Railway
project containing private Postgres, a read API and a background worker service.

## Responsibilities

- `apps/web`: UI and server-side proxies to the Railway read API. Product views
  read saved analytics, with a labeled committed capture as an outage fallback.
- `apps/api`: bounded database reads for catalog, pool analytics, cross-pool
  leaderboard, public wallet/creator profiles, search and recent trades. No RPC
  requests run in this process.
- `apps/indexer`: independently scheduled historical discovery/events, analytics
  projection and recent activity collection. They share one container and RPC
  account, but keep separate checkpoints and database locks.
- `packages/db`: versioned SQL migrations, atomic publication, checkpoints and
  reorg invalidation. Separate reader permissions remain future work.
- `packages/chain` and `packages/core`: RPC validation, exact arithmetic and
  accounting rules. `docs` stays at the repository root.

Market ingestion: Alchemy Robinhood RPC -> indexer -> private Postgres.
Product reads: Postgres -> Railway read API -> Next.js server -> browser.
ENS is a separate Ethereum lookup. There is no account database: public wallet
profiles are derived from chain evidence; watchlists and follows stay in the
visitor's browser.

## Saved accounting and catalog reads

Migration 005 adds replaceable public-data projections alongside the original
per-pool evidence: pool publication markers, audited wallet positions, observed
trades with exact per-sale cost basis, and price points. The worker derives these
using the existing core average-cost calculation. Excluded positions retain their
reasons and null financial values. Selecting a time window filters realized sales;
it does not forget purchases before that window.

Each new snapshot and its accounting rows publish in one transaction. Replacing
or invalidating a snapshot cascades to its derived rows. On startup the analytics
worker upgrades existing saved snapshots one pool per transaction without RPC
calls. This is resumable and also available explicitly with
`node --import tsx apps/indexer/src/analytics-main.ts backfill` from the repository
root, after migrations. Existing writer locks still apply.

Migration 006 adds PostgreSQL `pg_trgm` name/symbol indexes and address/hash prefix
indexes. The API filters, sorts and paginates saved catalog data in SQL. Search
returns a bounded set of matching tokens, wallets, creators and transaction
references; loading a larger catalog does not require sending it to a browser.
Unknown exact transaction hashes can still open the chain explorer.

These projections improve reads and remove repeated accounting work from page
requests. They do not discover missing launches, manufacture missing trades, or
turn a historical snapshot into a current price. Full historical collection and
keeping the recent cursor near head remain separate work.

## Collection and correctness

1. Verify and version the Pools deployment registry, including historical
   deployments and Crowd paths, before claiming complete coverage. Follow
   INDEXING-SCOPE.md; never infer Pools membership from arbitrary ERC20s.
2. Store launch provenance, tokens, pools, canonical block evidence, raw relevant
   events and per-stream coverage. Keep token and pool identities separate.
3. Process bounded batches. Commit events and their checkpoint together;
   replaying a batch must not duplicate activity. Use a database lock to prevent
   competing writers during restarts or overlapping deployments.
4. Verify saved block hashes, rewind and rebuild affected derived data on a
   detected reorg. Retain a conservative head lag and publish exact cutoffs.
5. Run historical backfill separately from following new activity, with bounded per-process
   RPC budgets. Their combined usage consumes the same provider allowance. Persist gaps and progress; never label partial history
   complete. Measure Alchemy's observed 10-block log limit before expanding
   backfill volume; batching does not eliminate per-call provider usage.
6. Reconstruct holders from birth-to-cutoff Transfer coverage, reconcile against
   supply, and publish a snapshot every 30 minutes once coverage is sufficient.
   Persist schedule progress so worker restarts do not lose due work.
7. Calculate supported trader PnL from ordered events and verified attribution.
   Unknown cost basis remains excluded. Index balances as public chain data,
   without introducing account sign-in or profile persistence.

## Rollout

Build and test migrations and resumable collection locally first. Validate a
known pool against the current RPC capture, including restart/replay and reorg
tests. Then deploy the worker and expand verified coverage. Switch website
queries to indexed reads only after checking values, pagination and freshness.
Retain the existing snapshot path during rollout with its coverage label.

## Railway setup

Use Railway's standard PostgreSQL service with its persistent volume. Keep
Postgres and the worker in the same project, environment and region. Production
Postgres is private-only: its public TCP proxy and `DATABASE_PUBLIC_URL` were
removed. The official PostgreSQL image and storage settings remain unchanged.
No custom database tuning is required for this pilot.

The worker connects to the same project's Postgres over private networking
using `DATABASE_URL=${{Postgres.DATABASE_URL}}`, and receive the existing
`ROBINHOOD_RPC_URL` separately.
Build it from the repository root so shared workspace packages are available;
use the dedicated start command for `apps/indexer`. No separate
repository is needed. Do not deploy the repository's default web command as
the worker.

Use a separate local Postgres instance for development and tests. A private
`postgres.railway.internal` URL cannot connect directly from a laptop. Railway's
dashboard offers `railway connect Postgres` for an encrypted tunnel without
public access, or `railway connect Postgres --tunnel-only` for a GUI client.
Keep local/test writes separate from production. Do not add DATABASE_URL to
Vercel: the database-backed website read path is a separate rollout step.
Before expanding backfill, review backups, Railway usage and RPC consumption.

References checked 14 September 2026:

- https://docs.railway.com/databases/postgresql
- https://docs.railway.com/deployments/monorepo
- https://docs.railway.com/networking/private-networking/how-it-works

## Implemented foundation

`apps/indexer`, `packages/db` and the initial migration now exist. The worker
supports explicit-start, contiguous launch discovery through the current verified
instant-launch registry, and separate round-robin swap/Transfer collection per
verified pool. It saves raw receipts/logs/headers, decoded event amounts as exact
strings, discovered markets and per-stream checkpoints. A session-level advisory
lock allows only one worker; batch data and progress commit in one transaction.
During rolling deploys the new worker waits up to three minutes for the old
worker to release that lock, then resumes the saved checkpoints. It cannot write
while waiting. A one-shot command still fails immediately if another writer exists.
Canonical hash mismatches rewind a stream to a retained matching batch, deleting
orphaned records and (for discovery) affected pool streams before replaying.

The analytics worker now publishes holder snapshots and supported pool accounting,
and the website reads the saved catalog, rankings and wallet profiles through the
Railway API. This is still partial historical coverage. Crowd auctions remain
unsupported, and discovering a launch does not automatically provide its financial
history. Transfer coverage starts at each observed pool launch, which is not
automatically proof of a token's birth. The accounting rules still determine
whether PnL is supported.

### Worker commands

From the repository root:

- `pnpm db:migrate`: apply versioned, checksum-verified SQL migrations.
- `pnpm indexer:once`: one discovery batch plus a bounded number of pool batches.
- `pnpm indexer:run`: keep cycling; finish an in-flight batch on SIGTERM/SIGINT.
- `pnpm indexer:status`: print counts and the first 100 stream checkpoints.
- `pnpm test:db`: integration tests in an isolated schema on TEST_DATABASE_URL.
  Tests refuse to fall back to DATABASE_URL.

Required worker variables: `DATABASE_URL`, `ROBINHOOD_RPC_URL` and
`INDEXER_START_BLOCK`. Start blocks are explicit and persisted. They cannot be
silently changed later, because doing so would misrepresent historical coverage.
For the initial verified PEPE pilot use `62625935`. This excludes earlier launches;
a separate historical backfill path will be needed to expand coverage backwards.

Optional tuning: `INDEXER_BATCH_BLOCKS=1000` (maximum 2000),
`INDEXER_POLL_MS=15000`, `INDEXER_POOLS_PER_CYCLE=2`. These are conservative starting
values, not a guarantee of keeping up with chain activity. Logs report HTTP and
logical RPC counts separately; retries can increase billable provider calls.
Each worker sends at most two calls per batch, with at least one second between
HTTP requests. All workers consume the same provider account allowance; these
per-process caps are conservative pacing, not a global rate-limit guarantee. Per-call rate limits inside HTTP-success responses retry only
the throttled calls, preserving successful replies. One slow or broken pool
retains its old checkpoint.

`INDEXER_LOG_RANGE_BLOCKS=10` initializes the known Alchemy free-plan log range,
avoiding a rejected oversized probe each time a batch creates a new RPC client.
This is separate from `INDEXER_BATCH_BLOCKS`: a 1,000-block indexing batch still
collects all its log ranges before committing. Adjust this provider limit only
after verifying the configured endpoint's allowance; the adapter can still
learn a smaller advertised limit. It does not increase throughput or quota.

### Deploy the worker on Railway

1. In the existing project, add a GitHub service from `eddy-guo/pools-info`,
   branch `main`. Name it `indexer`.
2. Keep the root directory at `/` so the build can access workspace packages.
3. Configure the service directly in Railway Settings. The dashboard now says
   new services cannot opt into legacy Config as Code after 28 August 2026.
   `apps/indexer/railway.json` remains a reference for legacy services, but is not
   connected to this deployment. Use these settings:
   - Builder: Dockerfile; path: `apps/indexer/Dockerfile`.
   - Pre-deploy command: `node --import tsx src/main.ts migrate`.
   - Start command: `node --import tsx src/service.ts` (historical collector, analytics and recent activity).
   - Watch paths: `/apps/indexer/**`, `/packages/**`, `/pnpm-lock.yaml`,
     `/pnpm-workspace.yaml`, `/package.json`.
   - Wait for CI enabled; one replica, serverless disabled.
     Do not use the default Next.js build/start commands.
4. Set `DATABASE_URL` to the Postgres service's private URL via Railway's variable
   reference picker. Set `ROBINHOOD_RPC_URL` to the existing Alchemy URL and
   `INDEXER_START_BLOCK=62625935` for the pilot. Keep one replica and disable
   serverless sleeping. No public domain or HTTP health-check path is needed.
5. Deploy and inspect `discovered` / `indexed` JSON logs. Migration failure stops
   deployment. The worker has a finite per-batch RPC budget and retries cycles
   with backoff; checkpoints survive restarts and deployments.
6. Run `indexer:status` against the same database to inspect coverage. A green
   deployment alone does not prove all pools are caught up.

The worker container contains no `.env.local`, no saved local database, no web
app and no production credentials. Railway injects credentials at runtime.
Migrations use the provided database role initially. A future Railway read
service should use a separate read-only role and a bounded connection pool.
Production database credentials should remain inside Railway.

Railway's pre-deploy command has private-network access:
https://docs.railway.com/deployments/pre-deploy-command

### Initial verification

Local Postgres integration tests exercise replay/conflicting replay, contiguous
coverage, wrong-token rejection, transaction rollback, a competing worker lock,
restart reads and pool/discovery reorg cleanup. A real Alchemy-backed one-shot
collected the PEPE launch at blocks 62625935-62625944: one pool, two swaps and
8 transfers, checked against receipts and block hashes. A second process resumed
at 62625945-62625954 without duplicating the first batch. This is a small live
acceptance check, not a completed historical backfill. The hosted worker has
also applied migrations and persisted launch discoveries and checkpoints via
Railway's private network. Hosted event collection is verified separately from
the deployment's online status.

### Website read path

`apps/api` is a separate, read-only HTTP process in the same repository. It
reads the Railway database over the private network; it does not call RPC or
run migrations. Pool discovery, per-pool progress, paginated swap history and
wallet activity are exposed with explicit coverage. Wallet activity means
transaction initiator or token-transfer participation, not verified profit.
The API contract and deployment settings are in `apps/api/README.md`.

The product adapters use `INDEXER_API_URL` for `/v1/explore`, `/v1/pools`,
`/v1/leaderboard`, `/v1/wallets` and `/v1/search`. Financial values carry their
saved observation cutoff. Unsupported positions and incomplete histories remain
excluded from PnL. See [ANALYTICS-VALIDATION.md](ANALYTICS-VALIDATION.md) for an
independent integer reconciliation of the first full-history capture.

The live rail uses `/api/live-trades/` -> `/v1/live-trades`. It reads the newest
50 saved swaps, optionally scoped to one pool. It never calls RPC on a page view.
The browser checks every 15 seconds while visible, stops when paused or hidden,
and replaces the complete returned window so reorg removals disappear. Failed
requests retain the previous rows with a delayed label.

Recent launches and swaps have their own tables and independent checkpoints.
Only launches verified against the configured Pools strategies enter the
catalog. Recent discoveries join historical discoveries in search and pool
pages, but do not create financial analytics or complete-history claims.
Transactions identify their initiator, which may differ from the beneficiary.
A stale or empty recent checkpoint never falls back to historical activity and
pretends it is live. The API reports head, cutoff, lag and discovery coverage.

The recent lane starts with a bounded lookback and resumes from its saved cursor.
It does not discover every older launch. Historical coverage and recent worker
throughput still need to be measured before claiming current, all-Pools coverage.
The database stores public chain evidence, not account sign-ins or preferences.

### Independent recent activity worker

The service supervisor starts the third process only when `RECENT_ENABLED=1`.
The existing history collector and analytics projector continue independently.
Use `pnpm recent:once` for one bounded cycle or `pnpm recent:run` for continuous
collection. Both require the existing `ROBINHOOD_RPC_URL` and `DATABASE_URL`.
No new key or external integration is required. The worker intentionally ignores
`INDEXER_LOG_RPC_URL`; the public endpoint rejected Railway requests with HTTP 403.

Settings:

- `RECENT_ENABLED=1`: enable the recent child in `indexer:service`; default off.
- `RECENT_BOOTSTRAP_BLOCKS=6000`: initial lookback, saved once. Restarting or
  changing this value never moves an existing checkpoint forward or skips a gap.
- `RECENT_BATCH_BLOCKS=1000`: maximum blocks per cycle, inclusive, maximum 2000.
- `RECENT_LOG_RANGE_BLOCKS=10`: provider request range, matching Alchemy Free.

One combined query reads registered strategy launch events plus PoolManager
Swap events. Unknown pool IDs are discarded before receipt/header enrichment.
The registry combines verified historical and recent launches. Each cycle resolves
only the pool IDs present in its bounded swap-log batch through indexed database
lookups; it does not load the full catalog. Batch commits likewise validate only
their referenced markets. This allows the registry to exceed 10,000 pools while
retaining bounded collection work. A PostgreSQL regression test reproduces the
old failure with 10,002 markets and checks successful collection, restart and
reorg replacement after the fix. The swap cursor
never passes discovery, so a newly discovered launch cannot be skipped within
this recent window. Every published swap has a matching successful receipt,
canonical event header and rechecked cutoff. Transaction sender means initiator,
not necessarily token beneficiary. Recent rows cannot enter complete-history PnL.

Migration 004 stores separate recent streams, evidence batches, launches and swaps.
A single advisory lock 19004 prevents duplicate recent writers. Batch replay is
idempotent, parent links enforce contiguous coverage, and a discovery reorg
atomically removes affected discoveries and swaps. Reorgs deeper than the 256
retained checkpoint candidates reset this lane to its original saved start.
Evidence is currently retained rather than pruned; large-scale retention policy
is future work and must preserve the launch evidence that the registry depends on.

Each process now uses two calls per batch and a minimum 1000 ms interval, allowing
headroom when history, analytics and recent jobs share the same Alchemy key.
This is conservative local pacing, not a distributed provider-wide rate limiter.
The recent cycle budget remains 120 seconds / 300 HTTP requests. Explicit work-budget
failures halve the next range down to 10 blocks, preserving the cursor. Five good
cycles gradually restore the configured maximum; network/authentication/evidence
errors never trigger this size reduction. Repeated failures back off and restart
through the supervisor rather than pretending coverage advanced.

A local Alchemy-only pilot with isolated PostgreSQL measured two 200-block cycles
at 21.043 s and 23.048 s, slower than the observed chain rate of about 10 blocks/second.
A 1000-block cycle measured 61.054 s, or 16.38 blocks/second, so 1000 is the default.
That cycle saw 5,132 manager swaps and zero matching verified launches in its
window; all unknown swaps were excluded. This is throughput evidence for that
sample, not a claim that the hosted cursor is current. Receipt-heavy windows and
concurrent provider traffic can be slower. Inspect `recent_batch` logs for actual
head, cutoff, lag, duration and omitted-swap counts before claiming live coverage.

A positive real-data pilot also ran the entire recent worker over PEPE launch
blocks62625935-62625944 using Alchemy and an isolated local PostgreSQL schema:
one verified launch, two receipt-backed swaps,14 unrelated manager swaps omitted,
and16.048seconds/17HTTP requests/21logical calls. The `/v1/live-trades` API reader
returned both swaps with exact integer amounts, normalized token address and
explicit `stale` coverage (asOf1789370420). This caught and fixed checksummed ABI
address normalization before deployment; a regression test now covers it.
