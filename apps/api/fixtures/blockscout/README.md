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

## Relayed trades

Recorded on 2026-09-27 from the same host with the same free-tier key, for
three wallets of the 25 Sep 7d board, trimmed the same way (the rows are
unmodified; `next_page_params` is each page's own):

| File                           | Request                                                                                                        | Status |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------ |
| `trades-launchpad-router.json` | `/addresses/0xb96de56c…a83e/token-transfers?type=ERC-20`                                                       | 200    |
| `trades-aggregator.json`       | `/addresses/0x6e7d7a4e…a109/token-transfers?type=ERC-20&block_number=68740347&index=46`                        | 200    |
| `trades-plain-send.json`       | `/addresses/0xb5ba7f32…40d3/token-transfers?type=ERC-20&block_number=62851291&index=280`                       | 200    |
| `swap-logs.json`               | `POST /json-rpc`, `eth_getLogs` of the PoolManager's `Swap` logs of the leg's pool in each relayed leg's block | 200    |

`trades-launchpad-router.json` keeps a spoofed "ETH" token's send to another
address, two sells relayed by the launchpad's router
`0x8876789976decbfcbbbe364623c63652db8c0904` and a buy straight out of the
PoolManager. `trades-aggregator.json` keeps a sell and a buy relayed by the
aggregator `0xcc4c6fa295b24402d9c27efeb35205a32a7d641f`; the sell's block
holds eight swaps of its pool, seven of them other wallets'.
`trades-plain-send.json` keeps a registry token sent to another wallet in a
transaction with no swap, and a direct buy. `swap-logs.json` maps each relayed
leg's block to the filter sent and the logs the gateway returned for it. The
gateway answered 413 "Max batch size is 5" to a larger batch and billed it; a
batch of up to five cost 20 credits, the same as one request, and counted as
one request against the 5 per second.
