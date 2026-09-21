# Data experience and infrastructure

14 September 2026. User priority: real, responsive search, charts, trade history and a live feed. Account features remain visible UI placeholders; do not spend further implementation time on authentication/profile editing. Preserve every product route and future copy trading.

## How the app works

The browser starts with a committed, real public-chain snapshot. Vercel server functions refresh public data and cache successful responses. Once loaded, filtering, chart changes and trade pagination happen in the browser. They do not need a new RPC call for every click. Missing public wallet analytics can load separately; no wallet connection is required to read an address.

A public-chain database is separate from an account database. No user accounts are persisted. A durable public-chain index can become necessary for comprehensive, continuously updated analytics even with no accounts. Current coverage is explicitly a recent sample, not all protocol history. Vercel caching is not that index.

## Implemented

- Search uses a replaceable `SearchProvider` contract: typed groups, name/symbol fuzzy matching, exact address/hash handling, keyboard navigation and cancellation of stale results. It includes current markets, retained audited markets and a generated catalog of 80 verified launches. The catalog stores metadata and launch references, not invented prices or trader metrics. Unknown addresses open public wallet routes or the explorer; they are not assumed to be verified tokens or creators. Unknown hashes open the explorer. No fabricated profiles/rankings.
- ENS names resolve on Ethereum through `/api/ens/`, using PublicNode by default. `ETHEREUM_RPC_URL` can replace it. Standard Ethereum address records are used to open that address on Robinhood; no claim of a Robinhood-specific ENS record. Onchain resolution only, with ENS normalization; offchain resolver failures are reported, not converted into nonexistent wallets. Successful resolution is cached for five minutes. This is a new public RPC dependency, disclosed to Eddy; no key is required initially.
- TradingView Lightweight Charts 5.2 renders local observed spot OHLC with volume in a separate resizable pane. Candle intervals 1s/1m/5m/1h/4h/24h are separate from visible ranges 5m/1h/6h/24h/1W/All. Price/FDV uses the same observations; FDV multiplies by captured contract total supply. No USD conversion source is configured. Pan/zoom/crosshair do not imply more historical data was fetched. Empty time buckets do not invent trades. Keep TradingView attribution: the library's on-chart logo is off (`attributionLogo: false` in `candles.tsx`) and its licence's notice line and link live in the site footer (`.footer-credit` in `shell.tsx`), asserted by `tests/e2e/shell.spec.ts`.
- Trade history paginates loaded data at 20 events per page. E2E verifies 140 events across seven pages with no extra market RPC requests. This proves navigation behavior, not full-history availability for all tokens.
- `/api/trades/` reads only requested pool IDs from the Uniswap v4 PoolManager. It checks the latest 1,000 blocks ending 128 blocks behind L2 head, returns at most 50 recent events, verifies block/receipt agreement, and explicitly labels receipt `from` as transaction sender, not proven buyer/beneficiary. Sender is not used for PnL. This generic endpoint returns signed currency0/currency1 deltas; the UI maps them to ETH/token only for its already-verified native-ETH pools.
- The feed polls 15 seconds after each completed request, pauses while hidden, supports pause/retry, coalesces identical concurrent requests, and shares successful server results for 10 seconds. Overlapping windows are deduplicated and replaced on recheck. It retains up to 100 events locally, displays 12, and flags provider delays/truncation. This is polling, not WebSocket delivery or a complete lossless event stream. The 128-block lag is not an L1-finality claim. Reorgs older than the overlapping window require a future durable replay/reconciliation process.
- Account controls remain preview-only. No wallet signatures, trade submission, profile writes, or account-synced watchlists.

## Reference-site inspection

Inspected [Pools PEPE](https://pools.xyz/t/robinhood/0x4636E0604cD1D0f638A6512C1c32E1CD25E2af02) using Chrome UI and its observed requests.

- The chart DOM contains `tv-lightweight-charts` and layered canvas panes.
- Its menu offers 1S, 1M, 5M, 1H, 4H, 24H candle intervals and Price/FDV display modes. The volume-summary window is a separate control.
- `prices.getOhlc` returns `{time, open, high, low, close}` records. Changing to 4H triggered `prices.getOhlc,prices.getVolume` with `resolution: FOUR_HOUR`, chainId 4663, token address and startTimeMs. The captured request took approximately 631ms; this is one observation, not a benchmark.
- `activity.getTradeHistory` returned a batch containing 100 trades and a `truncated` flag. After paging, another observed request included `pages: 6` and took approximately 896ms. UI pages can use already-fetched trades while further batches load. Do not assume the internal database/hosting implementation from browser requests alone.
- Their browser calls their own prepared-data API. It does not directly reconstruct all history from raw RPC for every page click. These endpoints remain research references, not our runtime dependencies.

## Live checks

- Local ENS `vitalik.eth` resolved to `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`.
- Local recent-feed response at block 62,686,484 contained a real WIRE sell: tx `0xdfff3768b2c2550d8b0d2b4a62947eeb5e5348a1d396e82f67b64b1e9bbffc76`, block 62,685,752, currency0 delta 3,725,641,948,379,226 wei. The request completed in about 7.9 seconds. Historical evidence only, not a current market quote.
- Production bulk refresh verified after the discovery/batching optimization: HTTP 200, cutoff 62,688,534, 37 HTTP requests and 3.3 seconds of collection. ENS and the recent-feed endpoint also returned real HTTP 200 results in production. These are individual checks, not latency guarantees.
- The verified launch catalog captured 80 pools over blocks 62,589,878 through 62,689,877 with 33 HTTP requests. Its coverage does not imply complete protocol history.
- PEPE token `0x4636E0604cD1D0f638A6512C1c32E1CD25E2af02` captured 1,477 swaps with 185 HTTP requests in 102.8 seconds. The saved API response then loaded locally in 8.5ms; history spans 74 browser pages at 20 events each. This capture is real historical data, not a live price claim.

## Public catalog and captured histories

`pnpm catalog:chain` now extends a small public launch catalog. It verifies the previous checkpoint hash, rechecks a 128-block overlap and records any coverage gaps. Each run scans at most 100,000 blocks and 250 launches; the current bundled catalog is capped at 2,000 pools before partitioning is required. Run it deliberately and commit the generated output; no scheduled collector has been provisioned.

`pnpm snapshot:pool <token-address-or-pool-id>` captures one catalog pool with paced RPC requests. `POOL_INCLUDE_ACCOUNTING=1` adds receipt/transfer/balance verification. Output is published atomically only after the collector succeeds, under `data/pools/`; raw evidence stays under ignored `.data/pools/`. Captured pool histories are served immediately, while explicit refreshes try the bounded live collector. Refresh failures retain the visible capture. The live feed has its own newer cutoff and does not rewrite the historical chart. These files persist public chain data, not accounts. They ship with the deployment; they are not durable runtime writes in Vercel.

Next, partition histories and wallet summaries as coverage grows, retain explicit block coverage and incomplete accounting flags. A future hosted index or Pools backend can implement the same read interfaces. Neither Railway nor Postgres has been provisioned.

The deeper PEPE accounting capture failed with HTTP 429 both before and after request pacing. The successful market-only capture remained intact; no partial trader audit was published. This does not prevent existing audited sample wallets/cards from working. It does mean full PEPE PnL is not captured yet. A market-only recapture is blocked from overwriting an existing accounting capture; request accounting explicitly to replace one.

Free public RPC has rate limits and variable latency. Larger coverage and concurrent visitors may require a provider key or shared hosted index. Disclose those integrations before setup. Uniswap is a set of contracts on Robinhood Chain here, not a second chain to monitor.


## Alchemy endpoint validation and holder groundwork

The locally configured Alchemy endpoint was verified against Robinhood mainnet (4663): historical block reads, historical totalSupply matching the existing PEPE capture, and historical Transfer logs. The configured free tier rejected a 10,000-block eth_getLogs query and advertised a maximum 10-block range. Do not describe this account as automatically providing higher throughput than the public endpoint.

The RPC client now learns that advertised range limit and batches small nonoverlapping ranges while retaining the same overall timeout/request budget. A real 100-block PEPE transfer query returned 11 events using two HTTP requests (one rejected capability probe and one successful batch). Batching reduces HTTP overhead, not the number of billable RPC calls. Large backfills still need measured quotas and resumable storage.

The new pure holder ledger reconstructs exact raw balances from canonical Transfer events, handles mint/burn and duplicate replay, labels supplied infrastructure separately, and requires token-birth coverage plus supply reconciliation before marking its output complete. This is accounting groundwork, not yet a connected holder API, persistent indexer or scheduled 30-minute preload.
