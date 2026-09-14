# Real data and deployment

14 September 2026.

## Running the collector

`pnpm snapshot:chain` collects a bounded slice from Robinhood Chain mainnet (4663). It defaults to the public RPC, a 100,000-block discovery window, a 128-block lag behind the scan head, and the newest 8 instant launches. The lag is not a claim of L1 finality.

Override `ROBINHOOD_RPC_URL`, `CHAIN_BLOCK_SPAN` (up to 1,000,000), and `CHAIN_POOL_LIMIT` (up to 30) in the process environment. Credentials stay outside the browser and repository. Builds consume the committed snapshot and never require a working RPC.

The exporter writes `data/snapshots/chain.json` atomically after all queries succeed. Raw logs, receipts, and fetched headers are retained under ignored `.data/chain/<cutoff>.json`. Preserve these files when archiving a dataset. A failed run retains the last successful snapshot.

Refresh the snapshot, run `pnpm check` and `pnpm test:e2e`, then commit and push to main to deploy updated data. Automatic refresh is not configured yet. `/live/` explicitly reports the capture time and block coverage, and never claims to stream.

## What is established

- The RPC must report chain ID 4663, and each configured deployment must contain code at the cutoff.
- The source contracts and event definitions come from Uniswap's official deployment documentation and published source commit.
- Each launch's pool ID is recomputed from its PoolKey. Only native ETH currency0 / token currency1 pools without hooks are accepted.
- Launch receipts must succeed and contain the LiquidityLauncher. Pool swap logs are selected by the canonical manager address and full pool ID.
- Token name, symbol, decimals, and supply come from ERC20 calls at the cutoff.
- Each selected pool's swaps are fetched from its launch block through the common cutoff. Volume is the sum of absolute ETH swap legs, not net flow, wallet spend including gas, or volume for a full 24-hour period.
- Prices use the post-swap square-root price, inverted for ETH/token and adjusted for token decimals with integer arithmetic. Display formatting is lossy; raw values remain decimal strings.
- A receipt-level check compares aggregate pool token deltas with ERC20 transfers to/from the transaction sender. Its result is reported even if they differ. This check does not establish wallet cost basis.
- Block hashes are checked during ingestion and the cutoff is re-read before publication. This bounded exporter is not a persistent reorg-aware indexer.

## Research corrections

`TokenLaunched` emits `finalPositionRecipient` as the third indexed argument, not the creator. In the current deployment this is a FeeSplitter. Labelling that address as creator would collapse unrelated launches into the same identity. The UI therefore exposes the launch transaction sender with a clear qualification.

The current LiquidityLauncher emits `TokenCreated(address indexed tokenAddress)`. Do not reuse a different factory's richer token-created event signature for that launcher. Contract version and emitter must always be part of decoding.

The public RPC returned 36 instant launches from blocks 62,520,000 through 62,620,000 during the initial probe. Each strategy query completed in under one second. This does not imply that full historical collection, token metadata, or per-swap block resolution has the same throughput.

## First published sample

The successful collector run captured 8 of 41 discovered instant launches and 115 swaps, covering discovery blocks 62,526,262 through 62,626,261. It took about 9 seconds and 174 RPC requests after timestamp reads were batched four at a time. This measures a deliberately small recent sample, not a full-history backfill. The receipt reconciliation matched exactly.

An earlier 12-pool attempt used sequential block reads and was stopped while resolving the final pool. It did not publish a partial dataset.

## What remains

This is real data in a bounded snapshot. It is not continuous streaming, complete chain coverage, or a verified trader leaderboard. The existing Pools/Traders/Creators views still use the separate synthetic snapshot.

For real wallet rankings, collect transfers and complete inventory history, distinguish transaction senders from actual swap beneficiaries, exclude unsupported attribution and unknown basis, then reconcile multiple wallets. Native ETH gas/fees and auction entry costs need their own treatment. Holders, reserve-based liquidity, USD prices, and crowd launches remain unavailable in the real-data view.

Next ingestion step: use Envio HyperSync for bulk history plus RPC for state reads and independent receipt checks. Its Robinhood endpoint is listed officially and its height endpoint responds, but authenticated queries need an API token. No paid plan has been selected. A persistent Railway worker and Postgres can be added to this same repo when continuous indexing is ready.

## Sources

- [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)
- [Liquidity Launchpad deployments](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments)
- [InstantLaunchStrategy source at the deployment commit](https://github.com/Uniswap/liquidity-launcher/blob/dd8769cd45c0e9450e928513ee129b0af74f7f32/src/strategies/InstantLaunchStrategy.sol)
- [LiquidityLauncher interface at the deployment commit](https://github.com/Uniswap/liquidity-launcher/blob/dd8769cd45c0e9450e928513ee129b0af74f7f32/src/interfaces/ILiquidityLauncher.sol)
- [PoolManager event interface](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)
- [Robinhood Chain connection settings](https://docs.robinhood.com/chain/connecting/)
- [HyperSync networks](https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks)
- [HyperSync tokens](https://docs.envio.dev/docs/HyperSync/api-tokens)

## Hosting

The private GitHub repository is `eddy-guo/pools-info`. Main deploys to the Vercel project `pools-info`, with the Next.js preset and `apps/web` root. The default deployment succeeded and the public site was checked at https://pools-info.vercel.app.

No second backend repo is required. Add `poolsinfo.com` in Vercel's domain settings after purchase and apply the records shown there. Metadata uses `SITE_URL` if set, otherwise Vercel's production-domain environment variable; local development falls back to localhost.
