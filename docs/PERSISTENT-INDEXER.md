# Persistent Pools indexer

Decision: 14 September 2026. Keep one repository, the existing Vercel website,
and add a Railway project containing Postgres and one long-running indexer.
The Postgres service and worker are now deployed in the same Railway project.
The website still reads its existing snapshots and RPC refresh endpoints.

## Responsibilities

- `apps/web` (existing): Next.js UI and server-side read endpoints. Its future
  indexed read path must preserve private-only Postgres, for example through a
  small Railway read service. That integration is not implemented yet.
- `apps/indexer` (implemented foundation): background discovery and resumable
  swap/transfer ingestion. Holder snapshots and trader accounting remain planned;
  they will reuse the chain decoders and core calculations.
- `packages/db` (implemented foundation): versioned SQL migrations, connection
  handling and checkpoint queries. Separate reader permissions remain future work.
- `packages/chain` and `packages/core` (existing): RPC access, event validation,
  exact arithmetic and accounting rules.
- `docs` stays at the repository root.

Current ingestion: Robinhood RPC -> indexer -> private Postgres. Planned reads:
Postgres -> Railway read service -> Next.js server -> browser.
Alchemy remains the configured RPC provider, not the database or indexer.
ENS remains an Ethereum lookup separate from the Robinhood market catalog.

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
5. Run historical backfill separately from following new activity, within a
   shared RPC budget. Persist gaps and progress; never label partial history
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

This foundation does not yet publish holder snapshots, compute database-backed
trader rankings, index Crowd auctions, or replace website reads. Transfer coverage
starts at each observed pool launch, which is not automatically proof of a token's
birth. The existing accounting rules still determine whether PnL is supported.

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
The worker sends at most five calls per batch, with at least one second between
HTTP requests. Per-call rate limits inside HTTP-success responses retry only
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
   - Start command: `node --import tsx src/main.ts run`.
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

The Next `/api/trades/` route supports a server-only `INDEXER_API_URL` origin.
When configured, it reads `/v1/feed` from the read service; on failure it keeps
the last visible feed rather than starting extra RPC scans. Without the setting,
the current bounded RPC feed continues. The database feed uses the shared
indexed interval of the requested pools and a saved canonical header timestamp.
It refuses unknown or unstarted pool streams and never calls a recent database
write proof of recent chain coverage. Enable this origin only after verifying
coverage for the selected pools. This adapter does not yet switch the screener,
charts or wallet PnL away from their existing captured/audited data providers.

Public wallet and creator views should share the wallet address as identity.
Launch records provide the creator activity section; trade positions and
accounting provide trading activity. No account table, login or user preferences
are needed for that public profile. Derived positions, realized sales, candle
buckets and holder balances are subsequent read models, rebuilt from verified
source events with their own coverage/version. They must not interpret a
transaction initiator alone as the beneficiary or treat incomplete cost basis
as zero. Current cross-pool ranking and persistent derived PnL remain unfinished.

Fresh block following and historical backfill need independent scheduling before
claiming continuously current, all-Pools coverage. Adding a database or the read
service alone does not increase collection throughput. Until that work is
verified, the website must keep showing the actual observation cutoff.
