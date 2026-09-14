# Pools Info

A Next.js analytics dashboard for pools on Robinhood Chain, designed to gain a real data pipeline without rebuilding its interface.

**The original dashboard uses a reproducible fictional dataset.** Its 12 tokens, 8 wallets, 1,536 trades, prices, liquidity, and creator identities are simulated. It is a working product preview, not an indexed market feed or a verified trader leaderboard. The disclosure is included on every page and downloadable card.

A separate **On-chain** view at `/live/` now uses real recent launches and swaps from Robinhood Chain. It includes capture time, exact block coverage, and transaction evidence. The deployed version is a bounded snapshot. The local runtime extension adds cached automatic refreshes and on-demand per-pool trader audits; public-RPC market refresh has been verified locally, and the extension is being validated on a preview branch. See [real-data notes](docs/LIVE-DATA.md) and run `pnpm snapshot:chain` to refresh it.

## Run locally

Requires Node 22.9+ and pnpm 11.9.0 (pinned in package.json).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3100. No API keys, database, wallet connection, or hosting account is required.

To build and serve the production application:

```sh
pnpm build
pnpm preview
```

Stop the development server before using preview, since both use port 3100. Next.js pre-renders the pages, cards, and search index; two server routes provide on-chain refresh and audit data. Set `CHAIN_REFRESH_DISABLED=1` in root `.env.local` for an offline preview.

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
apps/web/           Next.js App Router, UI, build-time cards, bounded data APIs
packages/core/      Domain types, AnalyticsReader, SnapshotReader, accounting
packages/chain/     RPC/bulk ingestion, event verification, trader auditing
scripts/            Demo and real snapshot generators
data/snapshots/     Separate, versioned demo and on-chain snapshots
tests/e2e/          Browser tests against the production Next.js server
docs/               Original project research, setup, and implementation notes
```

`apps/web/src/lib/data.ts` is the single application entry point for the snapshot. React components receive typed view data; they do not import the JSON file. The search adapter reads a static export from the same data contract. A future API reader can replace these sources while reusing the UI and pure accounting functions.

Add `apps/indexer` and `packages/db` only when persistent indexing is ready. Large chain dumps belong outside the Git repository.

## Validation

```sh
pnpm check                    # lint, typecheck, accounting/ingestion tests, build
pnpm exec playwright install chromium
pnpm test:e2e                 # desktop + mobile, production server on 3101
```

The browser suite starts production Next.js on a separate port and stubs runtime provider responses, including failure and recovery. Regenerate a snapshot deterministically with `pnpm snapshot:demo`. That script always produces fictional data; it never contacts a chain.

## Vercel setup

1. Push this single repository to GitHub.
2. Import it with the Next.js preset and Root Directory `apps/web`.
3. Enable access to shared files outside that root. Keep framework build/output detection.
4. Use Node 22. Add `SITE_URL` at build time with the final HTTPS origin to generate correct social-preview image URLs. Without an override, Vercel builds use the project production domain; local metadata uses `http://localhost:3100`.
5. Add the purchased domain in Vercel and use the DNS records that Vercel supplies.

No Railway services or data-source secrets are needed for the snapshot preview. Runtime ingestion uses public Robinhood RPC, with optional server-only `ROBINHOOD_RPC_URL`; see [setup and validation](docs/LIVE-DATA.md). Robots metadata is deliberately `noindex` while the site contains synthetic data. Revisit that when replacing it with verified data.

## Deliberate omissions

- **Global real trader rankings:** only bounded pool data is established. The local per-pool audit excludes unsupported attribution and unknown basis; it does not establish wallet-wide returns.
- **Continuous indexing:** runtime refresh polls bounded history; it does not persist every chain event or replace a reorg-aware indexer.
- **Holder metrics:** not fabricated from swaps. Data-source research is deferred.
- **ENS and wallet connect:** public address pages already work for covered wallets. No account or signature flow is present.
- **Unknown-address data:** a static lookup explains missing coverage instead of reporting a zero balance.
- **Auction settlement, all-time PnL, and comparative studies:** require validated event models and sufficient history. A token classified as crowd is excluded from ranked totals.
- **Postgres, Railway worker, reorg recovery, and recurring snapshots:** later infrastructure. The pure accounting code does not make an unimplemented indexer production-ready.

See `docs/IMPLEMENTATION.md` for the next data milestone and `docs/SETUP.md` for the agreed MVP boundary.
