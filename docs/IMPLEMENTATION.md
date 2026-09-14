# Implementation status

14 September 2026. The local project is at Projects/pools-info. The original docs were moved into this repository intact.

## Deployment and real-data update

The private GitHub repo is connected and the initial Vercel deployment is live at https://pools-info.vercel.app. A separate `/live/` view now displays a real, explicitly bounded snapshot of instant launches and swaps. It does not reuse demo prices or rankings. See [LIVE-DATA.md](LIVE-DATA.md) for source verification, measurements, refresh commands, and remaining accounting work.

## Implemented

A pnpm workspace with Next.js, React, TypeScript, and Tailwind. The initial deployment used a static export. The local extension now pre-renders the same pages in ordinary Next.js and adds two bounded runtime routes; no database or worker is required. This extension is being validated on the preview/live-markets branch.

The screener, pool pages, leaderboards, wallet pages, typed search, creator profiles, and performance cards use one deterministic demo snapshot. Creator profiles are the first stretch feature. The snapshot is not real chain data; the demo flag is visible throughout.

All covered pool and wallet paths are generated at build time. PNGs and the transaction search index are also build-time static route outputs. Unknown addresses use the /wallet lookup route rather than requiring arbitrary dynamic paths.

## Extension boundary

- `AnalyticsReader` supplies pages, pools, wallet summaries, leaderboards, and search results.
- `SnapshotReader` builds those views from canonical-shaped demo trade inputs.
- `foldTrades` uses integer arithmetic, rejects mixed positions and conflicting duplicate events, and returns unknown basis rather than overstated realized profit.
- Windowed realized profit filters realization events after the complete available history is folded.
- React receives read models and shared formatters. Database writes and provider credentials must stay outside it.
- Browser transaction search loads one shared static file on demand.

## Next data milestone

Keep it bounded and separate from UI work:

1. Verify chain identity, deployment code, source ABIs, launch relationships, and swap sign conventions with an actual transaction.
2. Probe one short block window for provider range/result limits and throughput. Record requests, block numbers, and elapsed time. The earlier block-time measurement alone is not a backfill estimate.
3. Select one confirmed instant-launch pool and a small set of trades, resolve attribution, decimals, and timestamps, and preserve raw evidence.
4. Reconcile a wallet's buys, sells, and inventory. Identify pre-window basis and transfers; unknown cost must exclude a result from ranking.
5. Emit a separately named verified snapshot with an explicit manifest. Do not mix fixtures into verified aggregates. Missing holders and missing historical basis remain unavailable.
6. Broaden the dataset only after that pass succeeds. A real snapshot may initially expose fewer metrics than the demo.

The demo generator must never be relabeled or repurposed as a real-data generator. Real ingestion deserves its own script and validation fixtures.

## Later persistent backend

Add a worker and database package inside this repository. Preserve raw events, block hashes, and cursor updates transactionally. Reorg recovery must delete and replay an affected suffix; insert-ignore alone is insufficient. Query endpoints should return the existing read-model contract with pagination and coverage metadata. The runtime rendering change is now prepared locally; a worker can reuse `packages/chain` and `packages/core`.

Holder data-source selection, auction settlement, and full backfill are not completed. They do not block the static preview.

## Validation completed locally

- ESLint and strict TypeScript checks pass.
- 13 accounting and snapshot-contract tests pass.
- Production static export succeeds, including 12 pool pages, 8 wallet pages, 8 PNG cards, creator profiles, and the lazy search index.
- 18 Playwright checks pass across desktop and mobile Chromium against exported files, with zero retries. They cover URL filters/reloads, watchlist persistence, pool-wallet navigation, PNG download, typed transaction search, unknown addresses, currency/timeframe changes, wallet chart-window reconciliation, creator navigation, and page overflow/runtime errors.
- PNG files were decoded visually and browser layouts were inspected locally.
- Frozen-lockfile installation passes.

These original checks establish demo behavior. The deployment and bounded chain-data work are documented in LIVE-DATA.md.

## Runtime extension on preview branch

- `/api/markets/` caches successful bounded market snapshots for 60 seconds. The browser polls while visible, supports pause/retry, and keeps the last snapshot on failure.
- `/api/markets/[poolId]/accounting/` audits only a pool present in the current sample. Audit results have an independent cutoff and five-minute cache.
- `packages/chain` shares collectors between the CLI and Next.js. RPC supplies logs, headers, complete receipts, deployment checks, token metadata, sender code, and balances.
- Per-pool gross realized swap PnL uses BigInt average basis and is before gas. Only supported direct router/token flows qualify; unknown-basis transfers and inventory mismatches exclude positions.
- The public RPC hit 429 responses and time budgets on larger pools. No full-history throughput or production reliability claim is established. See LIVE-DATA.md before publishing.

The runtime extension passes lint, strict typechecking, 30 unit tests, the production build, and 24 desktop/mobile Playwright tests. A frozen-lockfile install succeeds. Mobile refresh and audit layouts were inspected at a 390px viewport. Browser success/failure cases use controlled API fixtures; The public-RPC market endpoint has now succeeded locally; Vercel preview behavior is checked separately.
