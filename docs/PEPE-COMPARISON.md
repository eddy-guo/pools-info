# PEPE comparison with pools.xyz

Checked 14 September 2026, approximately 08:10 UTC. Reference: [Pepe in Hood on pools.xyz](https://pools.xyz/t/robinhood/0x4636E0604cD1D0f638A6512C1c32E1CD25E2af02).

The token, pool ID, launch transaction sender, and launch time agree. The main mismatch is coverage: our published snapshot ends 33 seconds after launch. The newer market includes substantial subsequent buying and selling. ETH prices must not be compared numerically with USD prices.

| Metric | Published snapshot | Fresh RPC check |
| --- | --- | --- |
| Cutoff block | 62,626,261 | 62,655,168 |
| Cutoff UTC | 07:20:52 | 08:09:45 |
| Launch UTC | 07:20:19 | 07:20:19 |
| Buys | 21 | 1,279 |
| Sells | 0 | 198 |
| Total swaps | 21 | 1,477 |
| Gross ETH swap volume | 1.363341998618 | approximately 14.133267208242 |
| Last-swap ETH/token | 0.000000005964868871 | 0.000000002526809281 |
| Token supply | 1 billion | 1 billion |

The fresh RPC logs contain exactly 21 swaps at or before the old cutoff. The newer buy/sell counts exactly match pools.xyz's activity API. The newest transaction is [0x600c...431d](https://robinhoodchain.blockscout.com/tx/0x600cc32ce320b5692146299e17c29c8356566a7797e97b861c37797b4f01431d), at 07:46:27 UTC. The history/state summary used six RPC requests and completed in under one second in this probe.

An additional independent StateView `getSlot0` read at block 62,655,168 returned the same spot price as the last swap, tick 197972, LP fee 2500, and packed protocol fee 1638800. The UI labels the PoolKey fee as LP fee; it is not a claim about total transaction fees or gas.

## Reference-site differences that remain

The observed pools.xyz response quoted approximately 0.000000002522839428 ETH/token, about 0.157% below the contract-state price at our cutoff. Its exact price source/update semantics are not established here.

Its quoted USD price was $0.0000063625060042. Multiplied by the on-chain supply, this gives approximately $6,362.51. The same response reported $20,631.42 FDV. That FDV equals its 07:25 candle close multiplied by supply, but does not reconcile with its current quoted token price. This is a comparison finding, not a diagnosis of its internal caching or valuation logic. We should not copy its aggregates without checking definitions and timestamps.

The page showed 174 holders and USD liquidity; neither has been independently validated in this comparison. Trader leaderboard values also have not been reconciled here.

## Data-source decision

Observed browser requests included `prices.getTokens`, `curve.getLaunchByAddress`, `activity.getTradeHistory`, `activity.getActivityStats`, `activity.getTraderLeaderboard`, and `prices.getOhlc` under pools.xyz's `/api/trpc/`. The sampled GET requests succeeded without a key. They are useful reference inputs; they are not established as a documented, supported third-party API contract and are not integrated into our app.

Keep the preview on public Robinhood RPC. Envio is removed from the baseline, and no new key/account is needed. Keep expensive trader audits separate from market refresh, and make CLI accounting explicitly opt-in. Longer-lived ingestion should preserve progress and fetch new events instead of repeatedly scanning full history.

Raw comparison responses and RPC logs are retained locally in ignored `.data/comparison/`. Production stays on its current deployment while the runtime version is reviewed on a Vercel preview branch.
