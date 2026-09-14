# Pools Info

Real Robinhood Chain pool analytics in a single pnpm workspace. Next.js serves the frontend and bounded RPC endpoints on Vercel. Market data comes only from Robinhood's public RPC; there is no Envio, pools.xyz API, database, or paid data feed in the application.

The synthetic dataset and demo reader have been removed. The product routes remain: Explore, pool detail, trader leaderboard, wallet profile, share cards, creators and creator detail, plus typed search and methodology. These pages now use captured or refreshed chain data. **Coverage is a recent pool sample, not the full chain.** Wallet metrics and rankings are scoped to one audited pool at a time.

The full requested product scope remains in [PRODUCT-SCOPE.md](docs/PRODUCT-SCOPE.md). Missing inputs are displayed as unavailable rather than zero. The user's supplied research documents remain in `docs/`.

## Local development

Node 22.9+ and pnpm 11.9.0:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3100. Keep this terminal running for hot reload. No API key is required. Root `.env.local` is optional and ignored by Git; `.env.example` documents supported settings.

## Validation and deployment

```sh
pnpm check                    # lint, types, accounting/ingestion tests, production build
pnpm exec playwright install chromium
pnpm test:e2e                 # production Next.js on 3101, desktop and mobile
```

Tests run against production Next.js, independently of the dev server. Browser provider responses are controlled for failure/recovery testing. The PNG endpoint is exercised against the committed, RPC-audited sample. Normal builds never call RPC.

Main pushes deploy to the existing Vercel project, using the Next.js preset and `apps/web` root. No PR is required for this personal-project workflow. Check CI, Vercel deployment status and the actual deployed site after pushing. Local development alone does not validate hosting timeouts or provider behavior.

Production: https://www.poolsinfo.com. The Namecheap domain is already connected to Vercel. `SITE_URL` can override metadata origin; the default is the production custom domain. Robots remain noindex while coverage is still being established.

## Routes and data

- `/`: recent instant launches, windowed volume and price change, watchlist, latest observed swaps.
- `/pool/[id]/?launch=[transaction]`: verified launch facts, FDV, observed spot-price candles and volume, swaps and on-demand trader audit.
- `/traders/`: audited per-pool rankings, 10/25/100 gates, realized/net-ETH toggle, windows and visible exclusions.
- `/wallet/[address]/?pool=[id]&launch=[transaction]`: public address profile, audit-scoped performance, open position, history, behaviour and card actions. `/wallet/` provides lookup.
- `/cards/[address].png?pool=[id]&launch=[transaction]&window=All`: 1200×630 server-calculated audit card. Request parameters cannot supply PnL or rank.
- `/creators/` and `/creators/[address]/`: launch-sender grouping, volume, median volume, 24h still-trading ratio, fee option and audited own-purchase evidence.
- `Cmd/Ctrl+K`: covered tokens, audited wallets, launch senders and transaction hashes. Arbitrary addresses open a profile; untracked transaction hashes open the explorer. ENS is detected but resolution is not connected.
- `/methodology/`: sources, formulas, attribution and limits. `/live/` redirects to Explore.

Refreshes check about once a minute while visible. Market and audit cutoffs are independent and labeled. Linked pool URLs retain their launch transaction so bounded targeted scans can retrieve a pool after it leaves the newest-eight sample. They still have a 1,000,000-block scan ceiling.

## Collector and repository

```sh
pnpm snapshot:chain                            # cheap market-only snapshot
CHAIN_INCLUDE_ACCOUNTING=1 pnpm snapshot:chain  # also audit receipts and balances
```

The CLI writes only after all verification succeeds and preserves raw evidence under ignored `.data/chain/`. Keep accounting in the committed sample to populate initial wallet data and run the offline card integration test.

```text
apps/web/           Next.js pages, shared live state, bounded APIs and OG cards
packages/core/      Integer accounting, audit reconciliation and windowed read models
packages/chain/     Robinhood RPC ingestion, event validation and attribution
scripts/            Real snapshot collection
data/snapshots/     Captured on-chain sample, no fictional market data
tests/e2e/          Product flows on a production server
docs/               Original requirements and current implementation notes
```

A persistent worker and database can extend this same repo later. Complete wallet/global rankings, historical pool retention, holder concentration, reserve-based liquidity, compounded fees and crowd auctions remain data work, not removed product scope. See [LIVE-DATA.md](docs/LIVE-DATA.md) and [IMPLEMENTATION.md](docs/IMPLEMENTATION.md).
