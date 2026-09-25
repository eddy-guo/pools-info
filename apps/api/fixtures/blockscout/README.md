# Recorded Blockscout PRO API responses

Recorded on 2026-09-15 from `https://api.blockscout.com/4663/api/v2` for the
wallet `0x42a68318a6d78644870d3a37ec9e708e3ea904f5` (top leaderboard wallet at
the time) with a free-tier key, nine billed calls in total (230 credits of the
100,000 daily allowance). Pages are trimmed to a handful of representative items
with their original `next_page_params`; the item objects are unmodified. No
fixture carries key material, and no test makes a network call.

| File                          | Request                                                          | Status |
| ----------------------------- | ---------------------------------------------------------------- | ------ |
| `transactions-page1.json`     | `/addresses/{wallet}/transactions`                               | 200    |
| `transactions-page2.json`     | same, with page 1's `next_page_params` as query parameters       | 200    |
| `transactions-last-page.json` | `/addresses/0x…deadbeef/transactions` (`next_page_params: null`) | 200    |
| `token-transfers-page1.json`  | `/addresses/{wallet}/token-transfers`                            | 200    |
| `token-transfers-page2.json`  | same, with page 1's `next_page_params`                           | 200    |
| `token-transfers-empty.json`  | an address the explorer has never seen                           | 200    |
| `error-401.json`              | an invalid key                                                   | 401    |
| `error-402.json`              | no `Authorization` header                                        | 402    |

Every 200 carried `x-credits-remaining`; the 401 and 402 did not. The live
`https://api.blockscout.com/api/json/config` price table on the same day:
`default` 20 credits, `token-transfers` and `logs` 30, `internal-transactions` 40.

## Trades

Recorded on 2026-09-25 from the same host for the wallet
`0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388` (first on the 7d board that day, a
launcher selling its own launches) with the same free-tier key, trimmed the
same way:

| File                | Request                                                              | Status |
| ------------------- | -------------------------------------------------------------------- | ------ |
| `trades-page1.json` | `/addresses/{wallet}/token-transfers?type=ERC-20`                    | 200    |
| `trades-page2.json` | same, with page 1's `next_page_params` (`block_number`, `index`) too | 200    |

Page 1 keeps two spoofed-token address-poisoning logs (a token named with
invisible characters to pass for ETH, sent "from" the wallet to lookalike
addresses), a sell into the PoolManager through the Universal Router
(`0x3593564c`, `execute`), and the launch transaction's buy out of the
PoolManager; 10 of that page's 50 rows were poisoning logs. The whole page
answered in 1.8 s and page 2 in 2.0 s, and both were all ERC-20. The config
table that day also priced `advanced-filters` at 50 credits; its wallet and
PoolManager filter answered in 13-18 s, past the client's timeout.
