# Analytics validation for the saved-data rollout

This is a dated capture, not a current-chain or whole-wallet completeness claim.

- Pool: PEPE / `0xfb666aa663e2368def11a9fe82862190c40bf903d83ae9f343bcd38e7719e602`.
- Coverage: launch block 62,625,935 through block 62,693,798, 2026-09-14T09:14:57+00:00.
- Evidence: 1,477 swaps, 1,517 token transfers and 1,477 transaction receipts.
- 361 observed wallets, 341 with supported/reconciled inventory and PnL, 50 qualifying at the default 10-trade gate.
- A separate Python integer average-cost calculation reproduced all 341 supported wallet realized totals and cutoff inventories exactly.
- Top qualifying wallet in this pool: `0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1`, 11 swaps, realized `11471084300772102` wei (`0.011471084300772102 ETH`). Its inventory and on-chain balance are both zero at the cutoff.
- The separate Postgres pilot reconstructed the evidence in 152 seconds using 153 HTTP requests: 50 ranked wallets and 173 holders excluding infrastructure. Full token-birth coverage and supply reconciliation passed. The actual read API returned the same top wallet, rank and profit.
- Unsupported positions retain unavailable profit and explicit exclusions. No 100-row list is fabricated.

The committed compressed evidence is in `data/analytics/pepe-capture.json.gz`. Its uncompressed SHA-256 is `54dddd7bc195c1fda8517482cfe04b7ede9f679321d3a20a969c1b57223f841b`. The worker reconstructs the seed from raw evidence and rechecks canonical cutoff, token birth and archival balances before publishing it to Postgres.

The public Robinhood RPC provided the log history. Alchemy provided archival contract state and receipt reads. Existing cached historical headers were reused, with the capture cutoff hash rechecked. No new API key was needed.

For a visual sanity check after deployment, open the leaderboard with All observed and the 10-swap gate, follow the top wallet, then download its PNG. Profit, rank and window should agree. Each page names the available coverage; a pool awaiting processing must show missing metrics rather than zero values.
