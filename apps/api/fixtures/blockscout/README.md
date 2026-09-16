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
