# Trader board without own launches and contracts: before and after

Measured on a copy of the 27 Sep 2026 12:01Z production backup (ledger cursor 73,922,448), Postgres 18.6, migrated through 025, read through the api's own reader with `MARKET_SOURCE=ledger` (`limit=100`, `minTrades=10`). Before is main; after is this change with the contract census run once against the explorer (4 addresses read, 3 contracts).

Reasons: **own-only** trades nothing but tokens it launched (its `launch_sender`); **mixed** has other positions too, and without its own launches it falls out of the top 100 or under the 10-trade floor; **contract** has deployed code that is not an EIP-7702 delegation designator. No other wallet leaves any board. Every wallet that enters has no position in its own launches and is not a contract, and its row is its wallet page summary unchanged; the order of unaffected wallets is unchanged on every board.

| Board        | Total before -> after | Leave | own-only | mixed | contract | other | Unaffected wallets on both, figures identical |
| ------------ | --------------------- | ----- | -------- | ----- | -------- | ----- | --------------------------------------------- |
| 1h/realized  | 0 -> 0                | 0     | 0        | 0     | 0        | 0     | 0 of 0, order kept                            |
| 1h/net       | 0 -> 0                | 0     | 0        | 0     | 0        | 0     | 0 of 0, order kept                            |
| 6h/realized  | 100 -> 100            | 3     | 1        | 0     | 2        | 0     | 97 of 97, order kept                          |
| 6h/net       | 100 -> 100            | 4     | 1        | 0     | 3        | 0     | 96 of 96, order kept                          |
| 24h/realized | 100 -> 100            | 6     | 4        | 0     | 2        | 0     | 94 of 94, order kept                          |
| 24h/net      | 100 -> 100            | 6     | 4        | 0     | 2        | 0     | 94 of 94, order kept                          |
| 7d/realized  | 100 -> 100            | 43    | 43       | 0     | 0        | 0     | 57 of 57, order kept                          |
| 7d/net       | 100 -> 100            | 43    | 43       | 0     | 0        | 0     | 57 of 57, order kept                          |
| 30d/realized | 100 -> 100            | 42    | 41       | 0     | 1        | 0     | 58 of 58, order kept                          |
| 30d/net      | 100 -> 100            | 42    | 41       | 0     | 1        | 0     | 58 of 58, order kept                          |
| All/realized | 100 -> 100            | 45    | 42       | 2     | 1        | 0     | 55 of 55, order kept                          |
| All/net      | 100 -> 100            | 46    | 43       | 2     | 1        | 0     | 54 of 54, order kept                          |

## 6h/realized: 3 leave

| Rank before | Wallet                                       | Realized (ETH) | Supported trades | Why                                   |
| ----------- | -------------------------------------------- | -------------- | ---------------- | ------------------------------------- |
| 1           | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072        | 71               | trades only its own launches          |
| 5           | `0x91f99c026126f60a35c4306cb288388848b48faf` | 0.0075         | 18               | contract (eth_getCode: deployed code) |
| 11          | `0x2be87ad70cf11ea294d7c42044b5b8277a3e4874` | 0.0000         | 28               | contract (eth_getCode: deployed code) |

## 6h/net: 4 leave

| Rank before | Wallet                                       | Net (ETH) | Supported trades | Why                                   |
| ----------- | -------------------------------------------- | --------- | ---------------- | ------------------------------------- |
| 1           | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072   | 71               | trades only its own launches          |
| 2           | `0xb19e4456e26181897aaf08e76f09691a27d8cf47` | 0.5063    | 33               | contract (eth_getCode: deployed code) |
| 3           | `0x91f99c026126f60a35c4306cb288388848b48faf` | 0.2567    | 18               | contract (eth_getCode: deployed code) |
| 14          | `0x2be87ad70cf11ea294d7c42044b5b8277a3e4874` | -0.0000   | 28               | contract (eth_getCode: deployed code) |

## 24h/realized: 6 leave

| Rank before | Wallet                                       | Realized (ETH) | Supported trades | Why                                   |
| ----------- | -------------------------------------------- | -------------- | ---------------- | ------------------------------------- |
| 1           | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184        | 88               | trades only its own launches          |
| 2           | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072        | 71               | trades only its own launches          |
| 3           | `0xd7703edb063f57c2f68060f23e7448a60de76db2` | 15.3562        | 36               | trades only its own launches          |
| 7           | `0x91f99c026126f60a35c4306cb288388848b48faf` | 0.0267         | 93               | contract (eth_getCode: deployed code) |
| 25          | `0x2be87ad70cf11ea294d7c42044b5b8277a3e4874` | 0.0000         | 79               | contract (eth_getCode: deployed code) |
| 37          | `0x5ba26c8f90a0144ecd323752e5335ca5858ac261` | -0.0000        | 10               | trades only its own launches          |

## 24h/net: 6 leave

| Rank before | Wallet                                       | Net (ETH) | Supported trades | Why                                   |
| ----------- | -------------------------------------------- | --------- | ---------------- | ------------------------------------- |
| 1           | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184   | 88               | trades only its own launches          |
| 2           | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072   | 71               | trades only its own launches          |
| 3           | `0xd7703edb063f57c2f68060f23e7448a60de76db2` | 15.3562   | 36               | trades only its own launches          |
| 8           | `0x91f99c026126f60a35c4306cb288388848b48faf` | 0.0267    | 93               | contract (eth_getCode: deployed code) |
| 19          | `0x5ba26c8f90a0144ecd323752e5335ca5858ac261` | 0.0021    | 10               | trades only its own launches          |
| 31          | `0x2be87ad70cf11ea294d7c42044b5b8277a3e4874` | -0.0001   | 79               | contract (eth_getCode: deployed code) |

## 7d/realized: 43 leave

| Rank before | Wallet                                       | Realized (ETH) | Supported trades | Why                          |
| ----------- | -------------------------------------------- | -------------- | ---------------- | ---------------------------- |
| 1           | `0xe8b8bc6f30ccd9fa067391824ab2049fbfbb687e` | 98.0468        | 174              | trades only its own launches |
| 2           | `0x4ac05a46ff6373d2fc822f714b669b158a235a43` | 84.2155        | 172              | trades only its own launches |
| 3           | `0x16e81de56bcb3a84460a87a60bca1643f5c70a02` | 70.2521        | 111              | trades only its own launches |
| 4           | `0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5` | 65.1243        | 150              | trades only its own launches |
| 5           | `0xb9decac251a2e769f5ae7c2154798f6cd940807d` | 57.8099        | 121              | trades only its own launches |
| 6           | `0xb1aa919a0ed5dce0554b20ec77a6b447397cde96` | 43.4702        | 99               | trades only its own launches |
| 7           | `0xe15c13d67c308349998ff2dc4cd8b471b814fb84` | 42.3354        | 82               | trades only its own launches |
| 8           | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184        | 88               | trades only its own launches |
| 9           | `0x9a6fac9f71102bedd38f7786aa02c7157c5e6cb7` | 38.2933        | 79               | trades only its own launches |
| 10          | `0x12fb0d73ce3696cf17e27914b7c8264937fd6d96` | 37.8456        | 86               | trades only its own launches |
| 11          | `0xb2e0506228c4cf50abc768d499f01bb3f10ab466` | 37.0347        | 70               | trades only its own launches |
| 12          | `0x221d82793a6e8e9e57b07e08117da5c5ec114380` | 36.0963        | 70               | trades only its own launches |
| 13          | `0x19e7718f5901aebd77086537f8273bd0a11fdb84` | 36.0151        | 53               | trades only its own launches |
| 14          | `0x65a0901f4495a591b5438731729a73e92a724128` | 32.9767        | 56               | trades only its own launches |
| 15          | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072        | 71               | trades only its own launches |
| 16          | `0xacfae3b5d8732eb5a5ce8e9c30b424e1572438e2` | 27.6947        | 53               | trades only its own launches |
| 17          | `0x1a9f79aa78398c47c757cf617804536f2976ec7c` | 26.3876        | 47               | trades only its own launches |
| 18          | `0x06c114ca805d98f46e0c758f2fbf10734fb3de73` | 26.0156        | 38               | trades only its own launches |
| 19          | `0x6d1d46d7cdf2d46ca6108c6d469d1c273067400e` | 23.6028        | 37               | trades only its own launches |
| 20          | `0xb3c9cf93ec4eff830d01766681052607040c53b1` | 19.6466        | 68               | trades only its own launches |
| 21          | `0x03298f5a6b833258af7c748e61b8fe115e19a465` | 18.9765        | 27               | trades only its own launches |
| 22          | `0xfa674ca0259ab709063fa5404c4ae7156f90696c` | 16.5235        | 62               | trades only its own launches |
| 23          | `0xd7703edb063f57c2f68060f23e7448a60de76db2` | 15.3562        | 36               | trades only its own launches |
| 24          | `0x5d8cf07463e16d2fd3b0faedbe442e7a9d872325` | 14.9449        | 28               | trades only its own launches |
| 25          | `0x73e1310c44d68c3f038d7182b2572e486977312e` | 14.5879        | 37               | trades only its own launches |
| 26          | `0x0c552fe54de18e405d430379897e9042625d86ae` | 14.3785        | 33               | trades only its own launches |
| 27          | `0x894fabb5131ab603744440384db9aecf49f968d1` | 13.3213        | 31               | trades only its own launches |
| 29          | `0x678f5365aff9570d3ee63355239b755da9e5654b` | 12.4530        | 26               | trades only its own launches |
| 30          | `0x79412fd662f93165ede471df0cf9f150ebe79797` | 10.8582        | 25               | trades only its own launches |
| 31          | `0x419e2ad920edbbd649d4b4bcc4d5143bafbba116` | 10.3229        | 13               | trades only its own launches |
| 32          | `0xdd5e3f5fa353933dc7f39c1911fd8743f5c3a0ae` | 9.7456         | 40               | trades only its own launches |
| 33          | `0x519492639049bf5d36abecca46dc8b8cef9a993d` | 9.4537         | 19               | trades only its own launches |
| 35          | `0xb760aeff92639b7f895c46954002d0aca5cc6ae8` | 9.3623         | 16               | trades only its own launches |
| 36          | `0x4634f82c9973e93ea3a44393f933fa26c8551449` | 9.3552         | 13               | trades only its own launches |
| 37          | `0x7413b0ee68fe78c95a472f7cffde7400efcbf1ca` | 8.7091         | 14               | trades only its own launches |
| 38          | `0xfc1b3d7c1587c9a14573b1881741f70b8d2b8d00` | 7.2413         | 32               | trades only its own launches |
| 39          | `0x3f45b6029dc5730634f637b2988799e46c4b07f7` | 7.0855         | 17               | trades only its own launches |
| 44          | `0x401a1af0e088f9c0b207df1809eca98e0ec225f8` | 5.3466         | 12               | trades only its own launches |
| 46          | `0x74438e56eb502fa9bb07212a24f319b43ec14239` | 5.0020         | 20               | trades only its own launches |
| 48          | `0xfa7d509356d9a2503c3ac0a657901edeb468128f` | 4.2647         | 12               | trades only its own launches |
| 51          | `0xa304c1bae48f19b292dbb7e0d0763e0a968ed63b` | 3.6682         | 14               | trades only its own launches |
| 68          | `0xc489e1e00883f56dd4328d05ca7f43465f107be0` | 1.7239         | 10               | trades only its own launches |
| 79          | `0x7155f10b19b04f43f6d4ab87e1945bd65b7c9f6b` | 1.1771         | 26               | trades only its own launches |

## 7d/net: 43 leave

| Rank before | Wallet                                       | Net (ETH) | Supported trades | Why                          |
| ----------- | -------------------------------------------- | --------- | ---------------- | ---------------------------- |
| 1           | `0xe8b8bc6f30ccd9fa067391824ab2049fbfbb687e` | 98.0468   | 174              | trades only its own launches |
| 2           | `0x4ac05a46ff6373d2fc822f714b669b158a235a43` | 84.2155   | 172              | trades only its own launches |
| 3           | `0x16e81de56bcb3a84460a87a60bca1643f5c70a02` | 70.2521   | 111              | trades only its own launches |
| 4           | `0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5` | 65.1243   | 150              | trades only its own launches |
| 5           | `0xb9decac251a2e769f5ae7c2154798f6cd940807d` | 57.8099   | 121              | trades only its own launches |
| 6           | `0xb1aa919a0ed5dce0554b20ec77a6b447397cde96` | 43.4702   | 99               | trades only its own launches |
| 7           | `0xe15c13d67c308349998ff2dc4cd8b471b814fb84` | 42.3354   | 82               | trades only its own launches |
| 8           | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184   | 88               | trades only its own launches |
| 9           | `0x9a6fac9f71102bedd38f7786aa02c7157c5e6cb7` | 38.2933   | 79               | trades only its own launches |
| 10          | `0x12fb0d73ce3696cf17e27914b7c8264937fd6d96` | 37.8456   | 86               | trades only its own launches |
| 11          | `0xb2e0506228c4cf50abc768d499f01bb3f10ab466` | 37.0347   | 70               | trades only its own launches |
| 12          | `0x221d82793a6e8e9e57b07e08117da5c5ec114380` | 36.0963   | 70               | trades only its own launches |
| 13          | `0x19e7718f5901aebd77086537f8273bd0a11fdb84` | 36.0151   | 53               | trades only its own launches |
| 14          | `0x65a0901f4495a591b5438731729a73e92a724128` | 32.9767   | 56               | trades only its own launches |
| 15          | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072   | 71               | trades only its own launches |
| 16          | `0xacfae3b5d8732eb5a5ce8e9c30b424e1572438e2` | 27.6947   | 53               | trades only its own launches |
| 17          | `0x1a9f79aa78398c47c757cf617804536f2976ec7c` | 26.3876   | 47               | trades only its own launches |
| 18          | `0x06c114ca805d98f46e0c758f2fbf10734fb3de73` | 26.0156   | 38               | trades only its own launches |
| 19          | `0x6d1d46d7cdf2d46ca6108c6d469d1c273067400e` | 23.6028   | 37               | trades only its own launches |
| 21          | `0xb3c9cf93ec4eff830d01766681052607040c53b1` | 19.6466   | 68               | trades only its own launches |
| 22          | `0x03298f5a6b833258af7c748e61b8fe115e19a465` | 18.9765   | 27               | trades only its own launches |
| 23          | `0xfa674ca0259ab709063fa5404c4ae7156f90696c` | 16.5235   | 62               | trades only its own launches |
| 24          | `0xd7703edb063f57c2f68060f23e7448a60de76db2` | 15.3562   | 36               | trades only its own launches |
| 25          | `0x5d8cf07463e16d2fd3b0faedbe442e7a9d872325` | 14.9449   | 28               | trades only its own launches |
| 26          | `0x73e1310c44d68c3f038d7182b2572e486977312e` | 14.5879   | 37               | trades only its own launches |
| 27          | `0x0c552fe54de18e405d430379897e9042625d86ae` | 14.3785   | 33               | trades only its own launches |
| 28          | `0x894fabb5131ab603744440384db9aecf49f968d1` | 13.3213   | 31               | trades only its own launches |
| 30          | `0x678f5365aff9570d3ee63355239b755da9e5654b` | 12.4530   | 26               | trades only its own launches |
| 31          | `0x79412fd662f93165ede471df0cf9f150ebe79797` | 10.8582   | 25               | trades only its own launches |
| 32          | `0x419e2ad920edbbd649d4b4bcc4d5143bafbba116` | 10.3229   | 13               | trades only its own launches |
| 33          | `0xdd5e3f5fa353933dc7f39c1911fd8743f5c3a0ae` | 9.7456    | 40               | trades only its own launches |
| 34          | `0x519492639049bf5d36abecca46dc8b8cef9a993d` | 9.4537    | 19               | trades only its own launches |
| 36          | `0xb760aeff92639b7f895c46954002d0aca5cc6ae8` | 9.3623    | 16               | trades only its own launches |
| 37          | `0x4634f82c9973e93ea3a44393f933fa26c8551449` | 9.3552    | 13               | trades only its own launches |
| 38          | `0x7413b0ee68fe78c95a472f7cffde7400efcbf1ca` | 8.7091    | 14               | trades only its own launches |
| 39          | `0xfc1b3d7c1587c9a14573b1881741f70b8d2b8d00` | 7.2413    | 32               | trades only its own launches |
| 40          | `0x3f45b6029dc5730634f637b2988799e46c4b07f7` | 7.0855    | 17               | trades only its own launches |
| 45          | `0x401a1af0e088f9c0b207df1809eca98e0ec225f8` | 5.3466    | 12               | trades only its own launches |
| 47          | `0x74438e56eb502fa9bb07212a24f319b43ec14239` | 5.0020    | 20               | trades only its own launches |
| 48          | `0xfa7d509356d9a2503c3ac0a657901edeb468128f` | 4.2647    | 12               | trades only its own launches |
| 51          | `0xa304c1bae48f19b292dbb7e0d0763e0a968ed63b` | 3.6682    | 14               | trades only its own launches |
| 69          | `0xc489e1e00883f56dd4328d05ca7f43465f107be0` | 1.7239    | 10               | trades only its own launches |
| 81          | `0x7155f10b19b04f43f6d4ab87e1945bd65b7c9f6b` | 1.1771    | 26               | trades only its own launches |

## 30d/realized: 42 leave

| Rank before | Wallet                                       | Realized (ETH) | Supported trades | Why                                   |
| ----------- | -------------------------------------------- | -------------- | ---------------- | ------------------------------------- |
| 1           | `0x62cc49d34520f821f851f7f7073e8d6e4184675c` | 138.3625       | 157              | trades only its own launches          |
| 2           | `0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388` | 107.2704       | 157              | trades only its own launches          |
| 3           | `0xe8b8bc6f30ccd9fa067391824ab2049fbfbb687e` | 98.0468        | 174              | trades only its own launches          |
| 4           | `0x3012f89c46f6878bb111fd4f18649c38f114a61a` | 96.3811        | 146              | trades only its own launches          |
| 5           | `0x4ac05a46ff6373d2fc822f714b669b158a235a43` | 84.2155        | 172              | trades only its own launches          |
| 6           | `0x16e81de56bcb3a84460a87a60bca1643f5c70a02` | 70.2521        | 111              | trades only its own launches          |
| 7           | `0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5` | 65.1243        | 150              | trades only its own launches          |
| 9           | `0xb11f1fda8a563ee6f5093538e95443e2d7bbdd4f` | 59.4251        | 79               | trades only its own launches          |
| 10          | `0xb9decac251a2e769f5ae7c2154798f6cd940807d` | 57.8099        | 121              | trades only its own launches          |
| 12          | `0x8bbb4f1e2d01ce6b1fd77263078ea09346659e7d` | 43.7536        | 131              | trades only its own launches          |
| 13          | `0xb1aa919a0ed5dce0554b20ec77a6b447397cde96` | 43.4702        | 99               | trades only its own launches          |
| 14          | `0x1a792164459249483e814d2920ca9286722a86ed` | 43.0505        | 62               | trades only its own launches          |
| 15          | `0xe15c13d67c308349998ff2dc4cd8b471b814fb84` | 42.3354        | 82               | trades only its own launches          |
| 16          | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184        | 88               | trades only its own launches          |
| 17          | `0x06c114ca805d98f46e0c758f2fbf10734fb3de73` | 41.8063        | 63               | trades only its own launches          |
| 20          | `0x9a6fac9f71102bedd38f7786aa02c7157c5e6cb7` | 38.2933        | 79               | trades only its own launches          |
| 21          | `0x53c5422bff41fdc2a602069eb8c72784b8da8596` | 37.9244        | 69               | trades only its own launches          |
| 22          | `0x12fb0d73ce3696cf17e27914b7c8264937fd6d96` | 37.8456        | 86               | trades only its own launches          |
| 25          | `0xb2e0506228c4cf50abc768d499f01bb3f10ab466` | 37.0347        | 70               | trades only its own launches          |
| 26          | `0x221d82793a6e8e9e57b07e08117da5c5ec114380` | 36.0963        | 70               | trades only its own launches          |
| 27          | `0x19e7718f5901aebd77086537f8273bd0a11fdb84` | 36.0151        | 53               | trades only its own launches          |
| 30          | `0x182df343197d6c6989e31d370ae7248a08c06e90` | 34.8967        | 24               | trades only its own launches          |
| 33          | `0x65a0901f4495a591b5438731729a73e92a724128` | 32.9767        | 56               | trades only its own launches          |
| 34          | `0xf062690609383cfb979016015bbbed906aab15aa` | 32.7054        | 41               | trades only its own launches          |
| 36          | `0x153628801f9fc3e5fe82cda6c0e500f03c76e801` | 32.1384        | 131              | trades only its own launches          |
| 39          | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072        | 71               | trades only its own launches          |
| 48          | `0xacfae3b5d8732eb5a5ce8e9c30b424e1572438e2` | 27.6947        | 53               | trades only its own launches          |
| 50          | `0x91f99c026126f60a35c4306cb288388848b48faf` | 27.0460        | 22217            | contract (eth_getCode: deployed code) |
| 51          | `0x1a9f79aa78398c47c757cf617804536f2976ec7c` | 26.3876        | 47               | trades only its own launches          |
| 65          | `0x6d1d46d7cdf2d46ca6108c6d469d1c273067400e` | 23.6028        | 37               | trades only its own launches          |
| 68          | `0xe0054adf91633cb4ae2384f9d4f06a7b96df2028` | 23.3906        | 10               | trades only its own launches          |
| 70          | `0xb3c9cf93ec4eff830d01766681052607040c53b1` | 22.9423        | 106              | trades only its own launches          |
| 73          | `0x493b9655fbf61b3c3d3f134d3ce011b77c0b3dde` | 22.3486        | 46               | trades only its own launches          |
| 81          | `0x7ddad581c32f8931074fa01608f0c2ec2804b331` | 20.1355        | 20               | trades only its own launches          |
| 82          | `0xf13dbc903b160bc3da127b499bcd0199ba879014` | 20.0552        | 43               | trades only its own launches          |
| 84          | `0xe6b56f0719c7c3cdddbfaf9e0bded5ca71ece7b5` | 19.6867        | 23               | trades only its own launches          |
| 91          | `0x4d887e0591ec8665f7d2b9b0bd27b090646721f1` | 19.0448        | 26               | trades only its own launches          |
| 92          | `0x03298f5a6b833258af7c748e61b8fe115e19a465` | 18.9765        | 27               | trades only its own launches          |
| 93          | `0x1944ae80789195bd84ae55704406895b31f0ae6d` | 18.9695        | 16               | trades only its own launches          |
| 95          | `0x4b5d8b68c292b139884aa24449e0cb96ca765694` | 18.7078        | 14               | trades only its own launches          |
| 97          | `0x7e2c3c6c1817a19fe886fe6df707044d4fb5ee5c` | 18.3889        | 28               | trades only its own launches          |
| 100         | `0xa5f945a1184745b5ce665c0f180c0339b83fe19b` | 18.1550        | 35               | trades only its own launches          |

## 30d/net: 42 leave

| Rank before | Wallet                                       | Net (ETH) | Supported trades | Why                                   |
| ----------- | -------------------------------------------- | --------- | ---------------- | ------------------------------------- |
| 1           | `0x62cc49d34520f821f851f7f7073e8d6e4184675c` | 138.3625  | 157              | trades only its own launches          |
| 2           | `0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388` | 107.2704  | 157              | trades only its own launches          |
| 3           | `0xe8b8bc6f30ccd9fa067391824ab2049fbfbb687e` | 98.0468   | 174              | trades only its own launches          |
| 4           | `0x3012f89c46f6878bb111fd4f18649c38f114a61a` | 96.3811   | 146              | trades only its own launches          |
| 5           | `0x4ac05a46ff6373d2fc822f714b669b158a235a43` | 84.2155   | 172              | trades only its own launches          |
| 6           | `0x16e81de56bcb3a84460a87a60bca1643f5c70a02` | 70.2521   | 111              | trades only its own launches          |
| 7           | `0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5` | 65.1243   | 150              | trades only its own launches          |
| 9           | `0xb11f1fda8a563ee6f5093538e95443e2d7bbdd4f` | 59.4251   | 79               | trades only its own launches          |
| 10          | `0xb9decac251a2e769f5ae7c2154798f6cd940807d` | 57.8099   | 121              | trades only its own launches          |
| 12          | `0x8bbb4f1e2d01ce6b1fd77263078ea09346659e7d` | 43.7536   | 131              | trades only its own launches          |
| 13          | `0xb1aa919a0ed5dce0554b20ec77a6b447397cde96` | 43.4702   | 99               | trades only its own launches          |
| 14          | `0x1a792164459249483e814d2920ca9286722a86ed` | 43.0505   | 62               | trades only its own launches          |
| 15          | `0xe15c13d67c308349998ff2dc4cd8b471b814fb84` | 42.3354   | 82               | trades only its own launches          |
| 16          | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184   | 88               | trades only its own launches          |
| 17          | `0x06c114ca805d98f46e0c758f2fbf10734fb3de73` | 41.8063   | 63               | trades only its own launches          |
| 20          | `0x9a6fac9f71102bedd38f7786aa02c7157c5e6cb7` | 38.2933   | 79               | trades only its own launches          |
| 21          | `0x53c5422bff41fdc2a602069eb8c72784b8da8596` | 37.9244   | 69               | trades only its own launches          |
| 22          | `0x12fb0d73ce3696cf17e27914b7c8264937fd6d96` | 37.8456   | 86               | trades only its own launches          |
| 24          | `0xb2e0506228c4cf50abc768d499f01bb3f10ab466` | 37.0347   | 70               | trades only its own launches          |
| 25          | `0x221d82793a6e8e9e57b07e08117da5c5ec114380` | 36.0963   | 70               | trades only its own launches          |
| 26          | `0x19e7718f5901aebd77086537f8273bd0a11fdb84` | 36.0151   | 53               | trades only its own launches          |
| 29          | `0x182df343197d6c6989e31d370ae7248a08c06e90` | 34.8967   | 24               | trades only its own launches          |
| 33          | `0x65a0901f4495a591b5438731729a73e92a724128` | 32.9767   | 56               | trades only its own launches          |
| 34          | `0xf062690609383cfb979016015bbbed906aab15aa` | 32.7054   | 41               | trades only its own launches          |
| 36          | `0x153628801f9fc3e5fe82cda6c0e500f03c76e801` | 32.1384   | 131              | trades only its own launches          |
| 39          | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072   | 71               | trades only its own launches          |
| 49          | `0xacfae3b5d8732eb5a5ce8e9c30b424e1572438e2` | 27.6947   | 53               | trades only its own launches          |
| 50          | `0x91f99c026126f60a35c4306cb288388848b48faf` | 27.5239   | 22217            | contract (eth_getCode: deployed code) |
| 52          | `0x1a9f79aa78398c47c757cf617804536f2976ec7c` | 26.3876   | 47               | trades only its own launches          |
| 63          | `0x6d1d46d7cdf2d46ca6108c6d469d1c273067400e` | 23.6028   | 37               | trades only its own launches          |
| 66          | `0xe0054adf91633cb4ae2384f9d4f06a7b96df2028` | 23.3906   | 10               | trades only its own launches          |
| 68          | `0xb3c9cf93ec4eff830d01766681052607040c53b1` | 22.9423   | 106              | trades only its own launches          |
| 71          | `0x493b9655fbf61b3c3d3f134d3ce011b77c0b3dde` | 22.3486   | 46               | trades only its own launches          |
| 81          | `0x7ddad581c32f8931074fa01608f0c2ec2804b331` | 20.1355   | 20               | trades only its own launches          |
| 82          | `0xf13dbc903b160bc3da127b499bcd0199ba879014` | 20.0552   | 43               | trades only its own launches          |
| 84          | `0xe6b56f0719c7c3cdddbfaf9e0bded5ca71ece7b5` | 19.6867   | 23               | trades only its own launches          |
| 90          | `0x4d887e0591ec8665f7d2b9b0bd27b090646721f1` | 19.0448   | 26               | trades only its own launches          |
| 92          | `0x03298f5a6b833258af7c748e61b8fe115e19a465` | 18.9765   | 27               | trades only its own launches          |
| 93          | `0x1944ae80789195bd84ae55704406895b31f0ae6d` | 18.9695   | 16               | trades only its own launches          |
| 95          | `0x4b5d8b68c292b139884aa24449e0cb96ca765694` | 18.7078   | 14               | trades only its own launches          |
| 97          | `0x7e2c3c6c1817a19fe886fe6df707044d4fb5ee5c` | 18.3889   | 28               | trades only its own launches          |
| 100         | `0xa5f945a1184745b5ce665c0f180c0339b83fe19b` | 18.1550   | 35               | trades only its own launches          |

## All/realized: 45 leave

| Rank before | Wallet                                       | Realized (ETH) | Supported trades | Why                                                                              |
| ----------- | -------------------------------------------- | -------------- | ---------------- | -------------------------------------------------------------------------------- |
| 1           | `0x62cc49d34520f821f851f7f7073e8d6e4184675c` | 138.3625       | 157              | trades only its own launches                                                     |
| 2           | `0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388` | 107.2704       | 157              | trades only its own launches                                                     |
| 3           | `0xaeadfdfd5d001a00359d1f5142a273c099b74bec` | 104.0910       | 165              | trades only its own launches                                                     |
| 4           | `0xe8b8bc6f30ccd9fa067391824ab2049fbfbb687e` | 98.0468        | 174              | trades only its own launches                                                     |
| 5           | `0x3012f89c46f6878bb111fd4f18649c38f114a61a` | 96.3811        | 146              | trades only its own launches                                                     |
| 6           | `0x4ac05a46ff6373d2fc822f714b669b158a235a43` | 84.2155        | 172              | trades only its own launches                                                     |
| 7           | `0x16e81de56bcb3a84460a87a60bca1643f5c70a02` | 70.2521        | 111              | trades only its own launches                                                     |
| 8           | `0xbf319f6ddb0e696b469f6b104fab3fced5cdcfd7` | 67.3188        | 132              | trades only its own launches                                                     |
| 10          | `0x5af2f44ef5714233890efca9c350514749e2b72b` | 66.0544        | 436              | own launches removed; the rest falls out of the top 100 or under the trade floor |
| 11          | `0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5` | 65.1243        | 150              | trades only its own launches                                                     |
| 12          | `0x153628801f9fc3e5fe82cda6c0e500f03c76e801` | 61.7117        | 198              | trades only its own launches                                                     |
| 14          | `0xb11f1fda8a563ee6f5093538e95443e2d7bbdd4f` | 59.4251        | 79               | trades only its own launches                                                     |
| 15          | `0xb9decac251a2e769f5ae7c2154798f6cd940807d` | 57.8099        | 121              | trades only its own launches                                                     |
| 17          | `0x8bbb4f1e2d01ce6b1fd77263078ea09346659e7d` | 43.7536        | 131              | trades only its own launches                                                     |
| 19          | `0xb1aa919a0ed5dce0554b20ec77a6b447397cde96` | 43.4702        | 99               | trades only its own launches                                                     |
| 20          | `0x1a792164459249483e814d2920ca9286722a86ed` | 43.0505        | 62               | trades only its own launches                                                     |
| 22          | `0xe15c13d67c308349998ff2dc4cd8b471b814fb84` | 42.3354        | 82               | trades only its own launches                                                     |
| 23          | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184        | 88               | trades only its own launches                                                     |
| 24          | `0x06c114ca805d98f46e0c758f2fbf10734fb3de73` | 41.8063        | 63               | trades only its own launches                                                     |
| 25          | `0x9f0fde15a851aaf09eae6d86daeabcc1216027c1` | 39.6090        | 109              | trades only its own launches                                                     |
| 27          | `0x9a6fac9f71102bedd38f7786aa02c7157c5e6cb7` | 38.2933        | 79               | trades only its own launches                                                     |
| 28          | `0x53c5422bff41fdc2a602069eb8c72784b8da8596` | 37.9244        | 69               | trades only its own launches                                                     |
| 29          | `0x12fb0d73ce3696cf17e27914b7c8264937fd6d96` | 37.8456        | 86               | trades only its own launches                                                     |
| 31          | `0x91f99c026126f60a35c4306cb288388848b48faf` | 37.4948        | 44992            | contract (eth_getCode: deployed code)                                            |
| 32          | `0xb2e0506228c4cf50abc768d499f01bb3f10ab466` | 37.0347        | 70               | trades only its own launches                                                     |
| 34          | `0x221d82793a6e8e9e57b07e08117da5c5ec114380` | 36.0963        | 70               | trades only its own launches                                                     |
| 35          | `0x19e7718f5901aebd77086537f8273bd0a11fdb84` | 36.0151        | 53               | trades only its own launches                                                     |
| 39          | `0x182df343197d6c6989e31d370ae7248a08c06e90` | 34.8967        | 24               | trades only its own launches                                                     |
| 40          | `0x0fe81d93253b2a7a547c30eb3595a3bf1238807f` | 34.1690        | 177              | trades only its own launches                                                     |
| 41          | `0x65a0901f4495a591b5438731729a73e92a724128` | 32.9767        | 56               | trades only its own launches                                                     |
| 42          | `0xf062690609383cfb979016015bbbed906aab15aa` | 32.7054        | 41               | trades only its own launches                                                     |
| 46          | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072        | 71               | trades only its own launches                                                     |
| 50          | `0xa62ddadcb71599a0d70d26698877205dade41133` | 29.4769        | 250              | trades only its own launches                                                     |
| 59          | `0xacfae3b5d8732eb5a5ce8e9c30b424e1572438e2` | 27.6947        | 53               | trades only its own launches                                                     |
| 61          | `0x1a9f79aa78398c47c757cf617804536f2976ec7c` | 26.3876        | 47               | trades only its own launches                                                     |
| 74          | `0x6d1d46d7cdf2d46ca6108c6d469d1c273067400e` | 23.6028        | 37               | trades only its own launches                                                     |
| 76          | `0xe0054adf91633cb4ae2384f9d4f06a7b96df2028` | 23.3906        | 10               | trades only its own launches                                                     |
| 78          | `0xb3c9cf93ec4eff830d01766681052607040c53b1` | 22.9423        | 106              | trades only its own launches                                                     |
| 81          | `0x493b9655fbf61b3c3d3f134d3ce011b77c0b3dde` | 22.3486        | 46               | trades only its own launches                                                     |
| 85          | `0x68d1a4f5b0fe50072b5b887b68787cd06d25f129` | 21.0439        | 567              | own launches removed; the rest falls out of the top 100 or under the trade floor |
| 89          | `0x7ddad581c32f8931074fa01608f0c2ec2804b331` | 20.1355        | 20               | trades only its own launches                                                     |
| 90          | `0xf13dbc903b160bc3da127b499bcd0199ba879014` | 20.0552        | 43               | trades only its own launches                                                     |
| 94          | `0xe6b56f0719c7c3cdddbfaf9e0bded5ca71ece7b5` | 19.6867        | 23               | trades only its own launches                                                     |
| 99          | `0x4d887e0591ec8665f7d2b9b0bd27b090646721f1` | 19.0448        | 26               | trades only its own launches                                                     |
| 100         | `0x03298f5a6b833258af7c748e61b8fe115e19a465` | 18.9765        | 27               | trades only its own launches                                                     |

## All/net: 46 leave

| Rank before | Wallet                                       | Net (ETH) | Supported trades | Why                                                                              |
| ----------- | -------------------------------------------- | --------- | ---------------- | -------------------------------------------------------------------------------- |
| 1           | `0x62cc49d34520f821f851f7f7073e8d6e4184675c` | 138.3625  | 157              | trades only its own launches                                                     |
| 2           | `0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388` | 107.2704  | 157              | trades only its own launches                                                     |
| 3           | `0xaeadfdfd5d001a00359d1f5142a273c099b74bec` | 104.0910  | 165              | trades only its own launches                                                     |
| 4           | `0xe8b8bc6f30ccd9fa067391824ab2049fbfbb687e` | 98.0468   | 174              | trades only its own launches                                                     |
| 5           | `0x3012f89c46f6878bb111fd4f18649c38f114a61a` | 96.3811   | 146              | trades only its own launches                                                     |
| 6           | `0x4ac05a46ff6373d2fc822f714b669b158a235a43` | 84.2155   | 172              | trades only its own launches                                                     |
| 7           | `0x16e81de56bcb3a84460a87a60bca1643f5c70a02` | 70.2521   | 111              | trades only its own launches                                                     |
| 8           | `0xbf319f6ddb0e696b469f6b104fab3fced5cdcfd7` | 67.3188   | 132              | trades only its own launches                                                     |
| 9           | `0x5af2f44ef5714233890efca9c350514749e2b72b` | 66.0544   | 436              | own launches removed; the rest falls out of the top 100 or under the trade floor |
| 10          | `0x0224e37d9fbd646b1462fa52dff6ffa761ae9cb5` | 65.1243   | 150              | trades only its own launches                                                     |
| 12          | `0x153628801f9fc3e5fe82cda6c0e500f03c76e801` | 61.7117   | 198              | trades only its own launches                                                     |
| 14          | `0xb11f1fda8a563ee6f5093538e95443e2d7bbdd4f` | 59.4251   | 79               | trades only its own launches                                                     |
| 15          | `0xb9decac251a2e769f5ae7c2154798f6cd940807d` | 57.8099   | 121              | trades only its own launches                                                     |
| 17          | `0x8bbb4f1e2d01ce6b1fd77263078ea09346659e7d` | 43.7536   | 131              | trades only its own launches                                                     |
| 19          | `0xb1aa919a0ed5dce0554b20ec77a6b447397cde96` | 43.4702   | 99               | trades only its own launches                                                     |
| 20          | `0x1a792164459249483e814d2920ca9286722a86ed` | 43.0505   | 62               | trades only its own launches                                                     |
| 21          | `0xe15c13d67c308349998ff2dc4cd8b471b814fb84` | 42.3354   | 82               | trades only its own launches                                                     |
| 22          | `0xc5e27c1579ff44d13d607f8d3f0b7e59888e0cbc` | 42.2184   | 88               | trades only its own launches                                                     |
| 23          | `0x06c114ca805d98f46e0c758f2fbf10734fb3de73` | 41.8063   | 63               | trades only its own launches                                                     |
| 24          | `0x9f0fde15a851aaf09eae6d86daeabcc1216027c1` | 39.6090   | 109              | trades only its own launches                                                     |
| 26          | `0x9a6fac9f71102bedd38f7786aa02c7157c5e6cb7` | 38.2933   | 79               | trades only its own launches                                                     |
| 27          | `0x53c5422bff41fdc2a602069eb8c72784b8da8596` | 37.9244   | 69               | trades only its own launches                                                     |
| 28          | `0x12fb0d73ce3696cf17e27914b7c8264937fd6d96` | 37.8456   | 86               | trades only its own launches                                                     |
| 30          | `0x91f99c026126f60a35c4306cb288388848b48faf` | 37.4948   | 44992            | contract (eth_getCode: deployed code)                                            |
| 31          | `0xb2e0506228c4cf50abc768d499f01bb3f10ab466` | 37.0347   | 70               | trades only its own launches                                                     |
| 33          | `0x221d82793a6e8e9e57b07e08117da5c5ec114380` | 36.0963   | 70               | trades only its own launches                                                     |
| 34          | `0x19e7718f5901aebd77086537f8273bd0a11fdb84` | 36.0151   | 53               | trades only its own launches                                                     |
| 38          | `0x182df343197d6c6989e31d370ae7248a08c06e90` | 34.8967   | 24               | trades only its own launches                                                     |
| 39          | `0x0fe81d93253b2a7a547c30eb3595a3bf1238807f` | 34.1690   | 177              | trades only its own launches                                                     |
| 40          | `0x65a0901f4495a591b5438731729a73e92a724128` | 32.9767   | 56               | trades only its own launches                                                     |
| 41          | `0xf062690609383cfb979016015bbbed906aab15aa` | 32.7054   | 41               | trades only its own launches                                                     |
| 45          | `0x982a565a6d00ada7b9564d80ef2f1c5a33ed0d7e` | 30.8072   | 71               | trades only its own launches                                                     |
| 49          | `0xa62ddadcb71599a0d70d26698877205dade41133` | 29.4769   | 250              | trades only its own launches                                                     |
| 58          | `0xacfae3b5d8732eb5a5ce8e9c30b424e1572438e2` | 27.6947   | 53               | trades only its own launches                                                     |
| 60          | `0x1a9f79aa78398c47c757cf617804536f2976ec7c` | 26.3876   | 47               | trades only its own launches                                                     |
| 73          | `0x6d1d46d7cdf2d46ca6108c6d469d1c273067400e` | 23.6028   | 37               | trades only its own launches                                                     |
| 75          | `0xe0054adf91633cb4ae2384f9d4f06a7b96df2028` | 23.3906   | 10               | trades only its own launches                                                     |
| 77          | `0xb3c9cf93ec4eff830d01766681052607040c53b1` | 22.9423   | 106              | trades only its own launches                                                     |
| 80          | `0x493b9655fbf61b3c3d3f134d3ce011b77c0b3dde` | 22.3486   | 46               | trades only its own launches                                                     |
| 84          | `0x68d1a4f5b0fe50072b5b887b68787cd06d25f129` | 21.0439   | 567              | own launches removed; the rest falls out of the top 100 or under the trade floor |
| 88          | `0x7ddad581c32f8931074fa01608f0c2ec2804b331` | 20.1355   | 20               | trades only its own launches                                                     |
| 89          | `0xf13dbc903b160bc3da127b499bcd0199ba879014` | 20.0552   | 43               | trades only its own launches                                                     |
| 93          | `0xe6b56f0719c7c3cdddbfaf9e0bded5ca71ece7b5` | 19.6867   | 23               | trades only its own launches                                                     |
| 98          | `0x4d887e0591ec8665f7d2b9b0bd27b090646721f1` | 19.0448   | 26               | trades only its own launches                                                     |
| 99          | `0x03298f5a6b833258af7c748e61b8fe115e19a465` | 18.9765   | 27               | trades only its own launches                                                     |
| 100         | `0x1944ae80789195bd84ae55704406895b31f0ae6d` | 18.9695   | 16               | trades only its own launches                                                     |
