# Implementation status

14 September 2026. The product scope is preserved in [PRODUCT-SCOPE.md](PRODUCT-SCOPE.md). Removing demos means replacing their data, not dropping pages.

## Current implementation

Next.js in one pnpm workspace. The UI's source is a real committed Robinhood Chain sample plus cached runtime refresh. There is no demo dataset, simulated price conversion, fictional identity, SnapshotReader, or demo generator in the running app.

Explore, pool detail, traders, arbitrary wallet profiles, cards, creators/detail, search and methodology are all routed. Pool details retain a launch transaction in their URL for bounded retrieval after the recent list rotates. The data provider shares a market snapshot and independent audited pool results across client navigation. Production builds stay independent of RPC availability.

Pure read models in `packages/core/src/live-analytics.ts` derive windowed volume and price changes, carried-basis realized PnL, net ETH, disposed-cost ROI, closed-cycle records and hold times, cumulative PnL, open inventory marks and early-entry observations. Unknown-basis positions remain excluded in every window. Card parameters identify a wallet/pool/window; they cannot inject metrics. Cards independently use the server audit and display a scoped rank.

All ranking and wallet accounting currently covers one audited pool at a time. The full product still needs multi-pool indexing. Creators are grouped by observed launch sender, with a clear attribution qualification. N/A means an input has not been collected or a metric is not meaningful; it is never converted to zero.

## Sources and boundaries

Only public Robinhood RPC is used for market ingestion. The collector checks chain, deployments, launch receipt and pool identity, token metadata, canonical event/block relationships, and the final cutoff hash. Audits additionally check full swap receipts, supported router/token flows, transfers and cutoff balances. Envio is removed. pools.xyz was inspected for reconciliation and presentation research only.

The build sample includes 8 recent pools and their audits, collected from RPC with `CHAIN_INCLUDE_ACCOUNTING=1 pnpm snapshot:chain`. Market-only runtime polling remains cheaper. An older retained audit is visibly labeled with its own cutoff; it does not become current because the market list refreshed.

## Still in scope

Holder concentration, liquidity, fee compounding, validated permanent-lock evidence, full wallet/creator history, global rankings, known-bad-token filters, ENS, wallet connection, CCA accounting and persistent indexing. See the scope matrix. No extra repo or database is required for this first real-data pass.

## Development and release workflow

`pnpm dev` runs the hot-reloading app at 127.0.0.1:3100. `pnpm check` builds the production server; Playwright uses port 3101 so local development can remain running. CI repeats frozen installation, validation and desktop/mobile flows on pushes. Main deploys through the existing Vercel connection. Verify the actual deployment as well as localhost before calling a release complete.


## Validation for this migration

Lint and strict typechecks, 29 accounting/ingestion/read-model tests, production build and frozen installation pass. Twelve desktop/mobile browser checks cover real routes, watchlists and filters, refresh failure/recovery, pool-scoped ranking gates, wallet navigation, share-card PNG dimensions, creator lookup, typed search and direct candle-chart hydration. The card was also generated through actual public RPC and visually inspected; an independent receipt-word calculation matched a real wallet's closed-cycle result exactly. See LIVE-DATA.md for hashes and amounts.
