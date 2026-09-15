# Implementation status

15 September 2026. The product scope is preserved in [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md).

## Saved-data product

One pnpm workspace contains the Next.js website, Railway read API, background
indexer and shared chain/accounting/database packages. Postgres is private to
Railway. Production page reads use saved database analytics through the API;
a clearly dated committed capture remains available as an outage fallback.
No fictional identities, financial values or simulated price conversion are used.

Explore, token/pool detail, a cross-pool PnL leaderboard, public wallet profiles,
creator launches, PnL cards, typed search and methodology are routed. Local
watchlists and wallet follows need no account. Wallet connection, profile edits
and copy-trade execution remain design previews.

The indexer saves verified launch provenance, swap/transfer evidence and
per-stream checkpoints. The analytics worker reconstructs holders and supported
positions from complete birth-to-cutoff evidence, then publishes saved pool
analytics. Exact integer average-cost accounting carries cost basis into selected
windows and excludes unsupported attribution or unknown inventory cost.
Cross-pool ranking combines supported saved positions, not every wallet's full
on-chain history. The first real capture was independently reconciled; see
[ANALYTICS-VALIDATION.md](ANALYTICS-VALIDATION.md).

## Recent activity iteration

Initial page loads use content-shaped skeletons for metrics, charts, lists and
search results, with a subdued pulse and reduced-motion support. Background
refresh retains existing matching data. Loading is distinct from a completed
request with no results or unavailable analytics.

A separate recent collector follows verified Pools launch events and relevant
PoolManager swaps while historical collection continues. Recent tables do not
claim complete PnL history. New launches can appear in catalog/search before
financial metrics are available. Explore and pool details show a saved-trade
rail, including newly discovered pools that are still awaiting analytics.

The browser refreshes the latest 50 trades every 15 seconds while visible, can
pause, preserves old rows on an error, and replaces rewound windows. Coverage
shows the actual block cutoff and delayed states. Read APIs perform no RPC
requests. See [PERSISTENT-INDEXER.md](PERSISTENT-INDEXER.md) and
[the API contract](../apps/api/README.md).

## Limits that remain

The catalog covers observed launches from verified Pools contracts, not all
Robinhood tokens or every historical Pools launch. Historical and recent scans
have explicit start points. A deployed process is not proof that its cutoff is
current. The existing Alchemy key's query limits and shared allowance constrain
catch-up speed; provider upgrades must be verified before increasing range sizes.

Complete market coverage, uniformly fresh full-history PnL, some liquidity/fee
metrics and production-scale read models remain ongoing work. No missing metric
is silently converted to zero. ENS resolution uses Ethereum separately from
Robinhood market ingestion. Envio is not used.

## Development and release workflow

`pnpm dev` serves port 3100. Production builds and Playwright use port 3101.
`pnpm check` runs lint, strict typechecks, accounting/ingestion/read tests and the
production build. `TEST_DATABASE_URL=... pnpm test:db` runs isolated Postgres
integration tests, while `pnpm test:e2e` checks desktop and mobile product flows.
Main pushes deploy through existing Vercel/Railway connections after CI. Verify
actual live service checkpoints and product responses before declaring a rollout
successful; test fixtures alone do not establish production data coverage.
