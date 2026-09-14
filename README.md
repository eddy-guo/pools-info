# Pools Info

A static Next.js analytics dashboard for pools on Robinhood Chain, designed to gain a real data pipeline without rebuilding its interface.

**This version uses a reproducible fictional dataset.** Its 12 tokens, 8 wallets, 1,536 trades, prices, liquidity, and creator identities are simulated. It is a working product preview, not an indexed market feed or a verified trader leaderboard. The disclosure is included on every page and downloadable card.

## Run locally

Requires Node 22+ and pnpm 11.9.0 (pinned in package.json).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3100. No API keys, database, wallet connection, or hosting account is required.

To build and serve the actual static export:

```sh
pnpm build
pnpm preview
```

Stop the development server before using preview, since both use port 3100. Static files are emitted in `apps/web/out`.

## Included

- Pool screener with URL-based token filters, launch types, ranking, time windows, and pagination.
- Device-local watchlists and an ETH/USD display preference.
- Pool pages with interactive price charts, searchable transaction deep links, and per-pool traders.
- Seven-day and 24-hour realized-PnL leaderboards with carried opening basis, minimum trade counts, and crowd exclusions.
- Wallet profiles with positions, trade history, cumulative PnL, and build-time PNG share cards.
- Typed token, wallet, and transaction search, with the full transaction index loaded on demand.
- Creator profiles linking all launches and their trading profile: the first implemented stretch feature.
- A methodology page, explicit snapshot coverage, mobile layouts, keyboard search, unknown-address lookup, and unavailable-holder states.

The USD toggle uses one simulated ETH/USD rate. It does not claim historical dollar PnL. Wallet inventory is inferred from the demo swap ledger and is not a verified token balance.

## Repository

```text
apps/web/           Next.js App Router, static export, UI, build-time cards
packages/core/      Domain types, AnalyticsReader, SnapshotReader, accounting
scripts/            Deterministic snapshot generator
data/snapshots/     Small, versioned demo dataset
tests/e2e/          Browser tests against the exported static site
docs/               Original project research, setup, and implementation notes
```

`apps/web/src/lib/data.ts` is the single application entry point for the snapshot. React components receive typed view data; they do not import the JSON file. The search adapter reads a static export from the same data contract. A future API reader can replace these sources while reusing the UI and pure accounting functions.

Add `apps/indexer` and `packages/db` only when persistent indexing is ready. Large chain dumps belong outside the Git repository.

## Validation

```sh
pnpm check                    # lint, typecheck, core tests, static build
pnpm exec playwright install chromium
pnpm test:e2e                 # desktop + mobile, actual exported files on 3101
```

The browser suite serves the export automatically on a separate port. Regenerate a snapshot deterministically with `pnpm snapshot:demo`. That script always produces fictional data; it never contacts a chain.

## Vercel setup

1. Push this single repository to GitHub.
2. Import it with the Next.js preset and Root Directory `apps/web`.
3. Enable access to shared files outside that root. Keep framework build/output detection.
4. Use Node 22. Add `SITE_URL` at build time with the final HTTPS origin to generate correct social-preview image URLs. Until configured, local metadata uses `http://localhost:3100`.
5. Add the purchased domain in Vercel and use the DNS records that Vercel supplies.

No Railway services or data-source secrets are needed for this preview. Robots metadata is deliberately `noindex` while the site contains synthetic data. Revisit that when replacing it with verified data.

## Deliberate omissions

- **Verified chain data:** a bounded ingestion and reconciliation pass is required before reporting actual market performance.
- **Live pricing and activity:** this is a fixed snapshot. Nothing refreshes on a timer.
- **Holder metrics:** not fabricated from swaps. Data-source research is deferred.
- **ENS and wallet connect:** public address pages already work for covered wallets. No account or signature flow is present.
- **Unknown-address data:** a static lookup explains missing coverage instead of reporting a zero balance.
- **Auction settlement, all-time PnL, and comparative studies:** require validated event models and sufficient history. A token classified as crowd is excluded from ranked totals.
- **Postgres, Railway worker, reorg recovery, and recurring snapshots:** later infrastructure. The pure accounting code does not make an unimplemented indexer production-ready.

See `docs/IMPLEMENTATION.md` for the next data milestone and `docs/SETUP.md` for the agreed MVP boundary.
