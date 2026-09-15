# Pools Info

Analytics for verified Pools launches on Robinhood Chain (4663). One pnpm repository contains the Next.js frontend on Vercel, a Railway chain collector and analytics worker, and a read API backed by private Railway Postgres. Public wallet addresses are chain identities, not user accounts.

## How data reaches a page

1. The collector discovers launches from the configured Pools contracts and stores validated swap/transfer events with receipts, block hashes, and resumable checkpoints.
2. The analytics worker reconstructs each pool's wallet inventory and average-cost PnL, verifies cutoff balances, and publishes a dated snapshot and holder ledger. Successful pools become due again after 30 minutes; that is a scheduling target, not a freshness guarantee.
3. The API reads the full saved catalog and processed pool publications. Global sorting and wallet aggregation happen before pagination. Page requests do not run chain scans.
4. Next.js proxies the read API through server-only `INDEXER_API_URL`. A clearly labeled committed public dataset remains available when the service is unconfigured or unavailable. No fictional market or wallet data is used.

The database stays private. The HTTP service exposes read-only public chain analytics, never SQL or credentials. Production uses the existing Alchemy endpoint for both logs and archival state, with ten-block log ranges. The public Robinhood endpoint worked for local historical captures but returned HTTP 403 from Railway, so it is not the hosted collector's source. Optional `INDEXER_LOG_RPC_URL` can select a separately verified log provider; production references the existing `ROBINHOOD_RPC_URL`. ENS uses Ethereum PublicNode RPC, independently of Robinhood.

## Product routes

- `/`: searchable catalog, pending-metric pools included, global sorting and pagination, local watchlist.
- `/pool/[id]/`: launch/creator facts, saved price/FDV candles, trades, pool wallet accounting and holders when processed.
- `/traders/`: cross-pool supported-position rankings with a default 10-swap gate, windows and realized/net-ETH metrics.
- `/wallet/[address]/`: positions, trades, PnL curve and creator launches from the same saved corpus. Arbitrary addresses work; an address outside coverage has no invented history.
- `/cards/[address].png?window=All`: 1200×630 image using the same wallet figures and default rank as the profile.
- `/creators/`, `/creators/[address]/`: creator discovery and public profile surfaces.
- Cmd/Ctrl+K: tokens, wallet addresses, creators, transaction hashes and ENS. Saved search results augment immediate local results.
- `/methodology/`: formulas and limitations. Legacy scoped audit endpoints remain advanced tools, not prerequisites for normal browsing.

Account sign-in, account-synced watchlists and copy trading are design surfaces only. Browser-local watchlists work without accounts.

## Coverage and accounting

The configured initial discovery boundary is block 62,625,935. It does not include earlier launches or prove that every historical Pools contract version is covered. All catalog rows are visible; calculated metrics require a published pool snapshot. Different pools can have different historical cutoffs, which are disclosed.

PnL uses integer average cost, carrying earlier purchases into later windows. Only reconciled positions with supported transaction attribution contribute to profit. Unsupported routes, unexplained transfers and unknown basis are excluded and counted, not assigned zero profit. Values are ETH-denominated and before gas. These are supported-position totals over processed pools, not complete wallet returns. A leaderboard ranks the available qualifying wallets; it does not fabricate 100 rows.

Holders require birth-contiguous Transfer history and matching supply. Liquidity remains unavailable until pool-specific reserves are verified; the shared PoolManager balance is not pool liquidity. The read model has explicit corpus limits and fails clearly rather than silently ranking a truncated sample. Full indexed materialized wallet tables and continuous live streaming remain future extensions.

## Local development

Use Node 22.9+ and pnpm 11.9.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3100. `.env.local` is ignored; `.env.example` documents settings. The frontend can use the deployed API without direct database access. Local database tests must use a separate test database.

`pnpm dev` and `pnpm preview` load the optional repository-root `.env.local` before starting Next.js, including `INDEXER_API_URL`. Existing shell environment values take precedence. Use `pnpm build` before `pnpm preview`; both servers use port 3100.

```sh
pnpm check
TEST_DATABASE_URL=postgresql://localhost/pools_test pnpm test:db
pnpm exec playwright install chromium
pnpm test:e2e
```

Production is https://www.poolsinfo.com. Main pushes deploy through the existing Vercel integration, Next.js preset, root `apps/web`. No PR is required. Verify CI, Railway and Vercel after changes.

## Background commands

```sh
pnpm db:migrate
pnpm indexer:service   # collector and analytics in one Railway container
pnpm indexer:once
pnpm indexer:status
pnpm analytics:once
pnpm analytics:run
pnpm api:run
```

Railway indexer: Dockerfile `apps/indexer/Dockerfile`, pre-deploy `node --import tsx src/main.ts migrate`, start `node --import tsx src/service.ts`. API: Dockerfile `apps/api/Dockerfile`, healthcheck `/ready`, private `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Both use the same repository. See [API README](apps/api/README.md) for read endpoints.

CLI captures (`snapshot:chain`, `snapshot:pool`, `catalog:chain`) remain available for reproducible public datasets. Analytics capture seeds include raw evidence and are reconstructed and verified on import, not accepted as supplied profit numbers.

```text
apps/web/          Next.js frontend, server proxies and share images
apps/api/          Read-only saved-chain-data API
apps/indexer/      Collector, analytics projector and process supervisor
packages/db/       Postgres migrations and checkpoint persistence
packages/core/     Integer accounting and shared product read models
packages/chain/    RPC ingestion, validation and attribution
scripts/           Snapshot and catalog exporters
data/              Captured public datasets and seed evidence
docs/              Original requirements and implementation notes
```

Original scope and supplied research remain in [docs/PRODUCT-SCOPE.md](docs/PRODUCT-SCOPE.md). Older implementation notes describe prior rollout stages; this README describes the current saved-data architecture.
