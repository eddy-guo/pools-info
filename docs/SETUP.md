# pools-info: MVP first, extensible data layer

Updated 14 September 2026 following Eddy's scope clarification. This plan supersedes the earlier recommendation to start with Postgres. Original research documents remain unchanged.

## Agreed direction

Build a polished Next.js site backed by preloaded snapshots first. It must run locally without Railway, Postgres, a hosted worker, cloud credentials, or any deployment. Keep stretch goals in scope for the session after this working checkpoint, but do not make the MVP depend on a large backfill.

The original docs already put Railway/Postgres in Phase 2. Their MVP still includes offline/scheduled indexing to produce real JSON data; a static frontend does not eliminate data preparation. We can start UI work with clearly labeled fixtures, then replace them with a bounded verified snapshot. Demo fixtures alone do not establish a real trader leaderboard.

## Repository layout

```text
pools-info/
  docs/                    # move the existing folder here
  apps/
    web/                   # Next.js App Router
  packages/
    core/                  # domain types, pure accounting, read interface
  data/
    snapshots/             # bounded, versioned public data + manifest
  scripts/                 # add bounded snapshot generation when needed
  package.json             # private pnpm workspace
  pnpm-workspace.yaml
  pnpm-lock.yaml
```

Add apps/indexer and packages/db when the persistent backend is justified. These are future packages in the same repo, not prerequisites and not separate repositories. The local workspace is now scaffolded, and the existing docs have been moved into pools-info/docs. See IMPLEMENTATION.md for current scope.

## Eddy's actions now

1. Create an empty GitHub repository named pools-info, without an initial README, license, or gitignore. The local repository and scaffold already exist.
2. Provide its URL when ready to connect and push.
3. Connect Vercel after the first push: Next.js preset, apps/web root, shared workspace files included.
4. After purchasing the domain, add it through Vercel and apply the DNS records shown there. No DNS changes are needed before that.

No Railway setup, database, Blockscout key, or deployment is required now. Vercel can be connected whenever a preview is useful; its project root will be apps/web with access to shared workspace files. Provider selection and holder-source alternatives are deferred.

## What the MVP contains

- Screener and pool pages with snapshot prices, charts, volume, and launch facts.
- Leaderboard and wallet profiles for the covered dataset, linked in both directions.
- Typed search over that dataset, URL filters, sorting, mobile layouts, copy/explorer links, and deliberate empty/error states.
- Shareable links and pre-generated cards for covered wallets where practical.
- Methodology and coverage/freshness labels; unknown basis is explicit and not ranked as zero-cost profit.
- Holder panels only where we have reliable snapshot data. Otherwise show unavailable data, not invented concentration figures.

A useful first checkpoint is the screener and one linked pool/wallet flow. We then finish the remaining MVP surfaces before letting backfill or infrastructure take over the session.

## How static stays compatible with stretch goals

1. **One typed read interface.** Components call an asynchronous AnalyticsReader with pools, pool detail, leaderboard, wallet, and search operations. Initially a SnapshotReader supplies them. Later server reads or an HttpReader use the same response contracts. Database write methods never enter React components.
2. **Stable data semantics.** Use chain + pool identity, decimal strings for large quantities, explicit token decimals, pagination/query shapes, and a manifest with schema version, source type, covered blocks/time, generated time, and accounting coverage. Not every metric needs to be available in every snapshot.
3. **Pure accounting.** Keep transformations and price calculations outside UI code. A bounded snapshot script and a future worker can reuse them. Preserve enough raw source evidence for reconciliation and replay; keep large dumps out of Git.
4. **Bounded static routes.** Pre-generate covered pool/wallet routes using generateStaticParams. A static /wallet lookup page can explain addresses absent from the snapshot. Runtime arbitrary-address routes and dynamic OG cards are later rendering changes, not reasons to rebuild the product.
5. **Separate pipelines.** A future worker populates Postgres and read endpoints. Existing snapshot output remains useful for fixtures, offline demos, and regression checks. Tests verify the read contract against both implementations when the second exists.

Strict output: 'export' is viable for the bounded snapshot MVP. It requires build-time routes and cards, and compatible image handling; runtime server features and ISR are unavailable. Alternatively, ordinary Next.js can pre-render the same pages without requiring us to implement a backend. We can choose during scaffold wiring. Moving to runtime rendering later changes data wiring, routing configuration, and hosting; the UI and accounting remain reusable. This is a contained migration, not literally zero work.

## Stretch goals during this session

After the snapshot MVP works, continue into worthwhile extensions rather than stopping automatically at MVP:

- Creator pages, richer attribution views, and a CCA visualization can use bounded snapshots if the relevant data exists.
- Measure provider limits and throughput using a small real scan before expanding. A modest verified dataset is preferable to an unbounded hours-long prerequisite.
- Persisted/resumable indexing, broader history, arbitrary-wallet data, automatic refresh, and Railway/Postgres follow once they add value to a working product.
- Real all-time PnL, auction results, and comparative studies need adequate history and verified accounting. UI completion does not establish those data claims.
- Defer Blockscout alternatives until holder coverage matters. Keep enrichment behind its own provider interface so switching source does not change pages.

## Verification order

First verify the complete user flow against the snapshot in the browser, including mobile and empty states. Verify arithmetic and schema independently with meaningful fixtures. Before presenting real analytics, reconcile a covered wallet with chain evidence. Backend restart, reorg, and replay checks apply when the worker is implemented. No broad backfill duration has been established.

## Corrections needed before adopting the sample code

- **Windowed PnL:** SPEC switches from realized PnL to net ETH flow for rolling windows. These measure different things. For true 7-day realized PnL, carry verified opening inventory/basis from earlier history and sum realized sale events inside the window. Until history is sufficient, show Net ETH Flow explicitly or exclude incomplete-basis results from PnL ranking.
- **Unknown basis:** The sample fold clips sold quantity to known inventory but credits all sale proceeds, overstating profit on an oversell. Unknown inventory must not receive a fabricated zero basis. Transfers, auction claims, and missing pre-window history need explicit accounting coverage. A swap-only position is not necessarily a wallet's actual balance.
- **Auction accounting:** Missing entry cost makes realized PnL unknown too. Do not accept the spec's statement that sells remain correct, or assume final clearing price times claimed tokens is exact cost, without checking the actual auction settlement and bid records.
- **Reorgs:** Insert-or-ignore plus overlap scanning cannot remove orphaned rows. Store block hashes, detect canonical-chain changes, delete/replay the affected suffix, and publish derived rows with a consistent checkpoint.
- **Precision:** SQLite SUM/subtraction over numeric strings does not provide exact 256-bit arithmetic. Do aggregation in BigInt or Postgres exact numeric types; serialize quantities as strings at API boundaries.
- **Schema:** The appendix's UNIQUE token constraint contradicts the stated one-token-to-many-pools model. Use pool identity as the key, with chain identity explicit. Tokens need a non-unique lookup from pools.
- **Attribution:** tx.from is a useful attribution for direct EOA/router transactions, not universal proof of the end user. Flag unsupported smart-wallet, bundler, relayer, and multi-recipient flows rather than confidently attributing them to a human trader.
- **Launch matching:** Crowd auction creation and later pool migration may occur in different transactions. Confirm strategy and token relationships across lifecycle events instead of requiring same-transaction auction creation.
- **Raw history:** BLUEPRINT says to discard logs after folding, while SPEC relies on replayable raw rows. Retain canonical raw inputs so corrections can be recomputed without re-fetching everything. Keep protocol labels as filtering metadata rather than irreversibly dropping raw events.

## Checks performed on 14 September 2026

- Public RPC eth_chainId: HTTP 200, result 0x1237 = 4663.
- Blocks 62,583,982 and 62,593,982: timestamps 1,789,366,165 and 1,789,367,180. Mean interval across this sample is **0.1015 seconds/block**. This sizes block ranges; it does not establish swap throughput or backfill duration.
- Keyless explorer /api/v2/stats: HTTP 403 with a Cloudflare challenge from this machine. This is an access observation, not proof of global unavailability.
- Not yet checked: contract addresses/ABIs, log caps, swaps/hour, crowd ratio, authenticated Blockscout, full wallet reconciliation, or any hosted deployment.

## Current platform references

- [Next.js installation and scaffold options](https://nextjs.org/docs/app/getting-started/installation)
- [Vercel monorepo configuration](https://vercel.com/docs/monorepos)
- [Railway shared monorepo deployment](https://docs.railway.com/deployments/monorepo)
- [Robinhood Chain endpoint configuration](https://docs.robinhood.com/chain/connecting/)
- [Blockscout Robinhood API](https://docs.blockscout.com/robinhood-api)

Project requirements come from the five supplied documents. They provide product/research context but no separate employer rubric or explicit delivery deadline was found.
