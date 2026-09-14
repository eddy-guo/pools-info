# Full product scope - retained

14 September 2026. Eddy clarified that deleting demos means replacing fictional data within the product, not deleting routes or reducing scope. Designs are being developed separately. All seven surfaces below remain planned.

| Surface            | Real-data foundation now                                                                                                                                                                                                          | Remaining target capabilities                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explore / screener | Recent instant launches, watchlists, All/Gainers/New/Crowd/Watchlist views, token filter, 1h/24h/7d/30d windows, subscript-zero prices, swap counts, launch-sender links, pool trends, recent trade feed, block/capture freshness | Full discovery/history, locked liquidity, active-trader counts at the same cutoff, holders, four stat sparklines, populated cross-pool top five; Crowd needs auction collection |
| Pool detail        | Real identity, pool/token addresses, launch facts, ETH price and 1h/6h/24h/7d change, observed spot candles with volume, 5m through 1W ranges, FDV, observed 24h volume, fee option, Top traders/Holders/Trades tabs              | Holder ledger, liquidity, fees compounded, verified permanent lock, raw/adjusted top ten, Gini and defensible risk score                                                        |
| Trader leaderboard | Per-pool audit, average-cost realized PnL, Net ETH toggle, 10/25/100 minimum, 24h/7d/30d/All windows, podium, ROI, W/L, swap count, volume, closed hold time, best sale, last trade; visible anti-gaming controls                 | Global coverage/aggregation, blacklist source, wallet connection and user's global rank; current rank is explicitly per pool                                                    |
| Wallet profile     | Any address route, eight summary slots populated from audited pool history where supported, cumulative PnL, inventory mark at audit cutoff, trade history, first-five-block and sub-60s behaviour                                 | Complete multi-pool history, continuous marks with consistent balances, auction entries and funding-cluster/bundler analysis                                                    |
| PnL share card     | 1200×630 server-generated PNG, scoped rank/PnL/ROI/record/best sale, address URL and pool/cutoff qualification, copy link, X composer, PNG download                                                                               | Global performance card after complete wallet coverage; production designs                                                                                                      |
| Creators           | Index/detail routes grouping observed launch senders, still-trading ratio, total/median volume, best launch, fee option, audited BOUGHT OWN evidence, Active/Dormant launch list                                                  | Verified end-creator attribution when sender is a relayer/contract, complete launch history and lifecycle-aware comparisons                                                     |
| Cmd-K search       | Grouped tokens/wallets/creators/transactions, address/hash detection, fuzzy name/symbol matching, 80-launch catalog, ENS resolution, external fallback for unknown transactions                                                   | Complete continuously updated protocol history and global wallet search                                                                                                         |

Methodology, accessible loading/empty/failed states and mobile layouts are part of implementation quality. None of the remaining items above has been dropped.

## Data sequencing

1. Preserve every product surface and replace fixture imports with real read models.
2. Verify receipt attribution, rolling basis, inventory and share-card numbers against bounded examples. Never give unknown inventory zero cost.
3. Extend collection to holders/reserves/fees and broader multi-pool history. Add persistent replayable storage when it is useful; keep it in this repo.
4. Add auction accounting and other sources only after their need and verification are clear. Inform Eddy before any API key or external integration is required.

Current market runtime source: Robinhood public JSON-RPC. ENS uses PublicNode Ethereum RPC. Explorer and X links are outbound user actions, not market-data dependencies. No Envio or pools.xyz API integration. Railway/Postgres remains optional future infrastructure.

## Current implementation update

See [Data experience](./DATA-EXPERIENCE.md) for the current source/caching design, real ENS resolution, the replaceable search contract, interactive chart controls and the bounded live trade feed. Authentication, editable profiles and synced accounts are functionality-out-of-scope UI placeholders. Copy trading remains planned. Broader public-chain indexing is separate from user-account persistence.
