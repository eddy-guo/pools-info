# Persistent Pools indexer

Decision: 14 September 2026. Keep one repository, the existing Vercel website,
and add a Railway project containing Postgres and one long-running indexer.
This is the implementation target, not a claim these services already exist.

## Responsibilities

- `apps/web` (existing): Next.js UI and server-side read endpoints. Read indexed
  market data through a small connection pool using a read-only database role.
  Cache common queries. Database credentials never reach the browser.
- `apps/indexer` (planned): background discovery, historical backfill, new swaps,
  transfer ingestion, holder snapshots and trader accounting. Reuse the chain
  decoders and core calculations. No public HTTP API is required initially.
- `packages/db` (planned): versioned SQL migrations, connection handling and
  shared query code. Separate migration, writer and web-reader permissions.
- `packages/chain` and `packages/core` (existing): RPC access, event validation,
  exact arithmetic and accounting rules.
- `docs` stays at the repository root.

Data flow: Robinhood RPC -> indexer -> Postgres -> Next.js server -> browser.
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

Create one project named `pools-info`, and add PostgreSQL. Choose a region near
the Vercel server-function region. For local migration and connection testing,
enable Postgres public access and put its `DATABASE_PUBLIC_URL` value into the
ignored repository-root `.env.local` under the key `DATABASE_URL`. Do not paste
the credential into chat or commit it. The placeholder is currently commented
out, so it does not affect existing commands.

The worker will connect to the same project's Postgres over private networking
using `DATABASE_URL`, and receive the existing `ROBINHOOD_RPC_URL` separately.
Build it from the repository root so shared workspace packages are available;
use a dedicated start command for `apps/indexer` once implemented. No separate
repository is needed. Do not deploy the repository's default web command as
the worker.

Vercel will need an externally reachable Postgres connection using a dedicated
read-only role. Set that server-side credential only when the read path is ready.
Keep local/test writes separate from production. Before production backfill,
configure backups and a Railway usage alert and measure RPC consumption.

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
RPC counts separately. One slow or broken pool retains its old checkpoint.

### Deploy the worker on Railway

1. In the existing project, add a GitHub service from `eddy-guo/pools-info`,
   branch `main`. Name it `indexer`.
2. Keep the root directory at `/` so the build can access workspace packages.
3. Set the Railway configuration file path to `/apps/indexer/railway.json`.
   This selects the worker Dockerfile, migration pre-deploy command and worker
   start command. Do not use the default Next.js build/start commands.
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
Migrations use the provided database role initially; before exposing database
reads through Vercel, create the separate read-only role and size its connection
pool. Do not add DATABASE_URL to Vercel until that read path is implemented.

Railway's pre-deploy command has private-network access:
https://docs.railway.com/deployments/pre-deploy-command

### Initial verification

Local Postgres integration tests exercise replay/conflicting replay, contiguous
coverage, wrong-token rejection, transaction rollback, a competing worker lock,
restart reads and pool/discovery reorg cleanup. A real Alchemy-backed one-shot
collected the PEPE launch at blocks 62625935-62625944: one pool, two swaps and
8 transfers, checked against receipts and block hashes. A second process resumed
at 62625945-62625954 without duplicating the first batch. This is a small live
acceptance check, not a completed historical backfill or Railway deployment.
