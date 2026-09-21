# TERMINATOR supply reconciliation - 21 September 2026

**Finding for firstmate: Pools Info's 1 billion supply and 18 decimals are correct for this token at the named chain block. No product code fix, response change, backfill or migration is warranted.** The chain also records an initial mint of exactly 1 billion. pools.xyz's approximately $48,744 FDV cannot equal its simultaneously served price times either the initial or current total supply. Its implied approximately 6.97 billion supply is not the chain's supply. This identifies the external FDV/price inconsistency; it does not establish whether their private implementation uses a wrong supply, a separate price source, or stale inputs.

Task: `pools-terminator-supply-t1`. This is a dated, token-specific addendum to the firstmate home's `data/pools-truth-recheck-s9/report.md`. Its original findings remain historical observations. The scope excludes the separate quiet-price investigation.

## Identity and reproduced public discrepancy

- Chain: Robinhood Chain, JSON-RPC chain ID **4663** (`0x1237`).
- Token: `0xf99a8228f9f4000cf501c9cb1ab8d3534485cad9`.
- Pool: `0xbfcd32a7fe6522e0f3ac58db24c931d247d24d842674040569afd2e98018a994`.
- [Pools Info page](https://www.poolsinfo.com/pool/0xbfcd32a7fe6522e0f3ac58db24c931d247d24d842674040569afd2e98018a994/) and [pools.xyz page](https://pools.xyz/t/robinhood/0xf99a8228f9f4000cf501c9cb1ab8d3534485cad9).

The original report's pair gave $6,989.97 versus $48,744.29. Before chain investigation, a fresh public API/browser pair reproduced the discrepancy. Raw URLs, response bodies, statuses and client request times are in [current-pair.json](evidence/terminator-supply-2026-09-21/current-pair.json); the original token's complete comparison row is preserved in [historical-pair.json](evidence/terminator-supply-2026-09-21/historical-pair.json).

| Measure                    | Pools Info                                     | pools.xyz                           |
| -------------------------- | ---------------------------------------------- | ----------------------------------- |
| Request started, UTC       | 2026-09-21 15:43:24.546                        | 2026-09-21 15:43:24.811             |
| HTTP status                | 200                                            | 200                                 |
| Price, ETH per whole token | 0.000000002557502070                           | 0.0000000025563888965447133         |
| Price, USD                 | 0.00000700434600670215, normalized at our rate | 0.000006998671790648079, served     |
| FDV, ETH                   | 2.557502070                                    | Not supplied                        |
| FDV, USD                   | 7004.34600670215, normalized at our rate       | 48744.28670695654, served           |
| Decimals                   | 18                                             | Not exposed by this launch response |

The request starts are **265 ms apart**; the ETH-denominated token prices differ by **+0.0435447618%** (ours/theirs minus one). Our Coinbase ETH/USD response is **2738.745**, as of **15:43:07.434Z**. Our pool response has cutoff block **68,912,877**, hash `0x3b7b51938b2ccb69421a9539be87860e8b183b2b2dfe44e9ff776218ffe84d16`, timestamp **15:42:17Z**. These are observation times and backend cutoffs, not a claim of simultaneous backend sampling.

The real UI was checked in the isolated `CHROME_DEVTOOLS_AXI_SESSION=pools-terminator-supply-t1`. Pools Info initially displayed **2.5575 ETH** FDV; switching its existing unit control to USD displayed **$7,004.35** at 15:44:10Z. pools.xyz displayed **$48.7K** FDV beside **$0.000006999** price at 15:44:57Z. Its introductory overlay was dismissed for the final screenshot. These later UI observations corroborate rendering, while the table uses the closer API pair. Both screenshots were visually inspected: [ours](evidence/terminator-supply-2026-09-21/poolsinfo-usd.png), [theirs](evidence/terminator-supply-2026-09-21/pools-xyz-clear.png). Text and timestamps are retained alongside them.

## Chain is the supply arbiter

Exactly **11 bounded read-only JSON-RPC requests**, 15:43:27.054-15:43:27.768Z, went to the credential-free public endpoint `https://rpc.mainnet.chain.robinhood.com`. No Alchemy or HyperSync request, log-range scan, collector, indexer, production database connection or write was made. The initial and final header reads have the same hash. Full requests and responses, including calldata and ABI replies, are in [chain.json](evidence/terminator-supply-2026-09-21/chain.json).

**State block:** **68,913,551** (`0x41b898f`), timestamp **2026-09-21 15:43:26 UTC**, hash **`0x9e914584459379d14baf06b6de400cdb82546710015c6cbb446b698587e5a8e3`**. Every state read used this explicit block number, not a moving `latest` tag. The receipt is separately pinned by its transaction hash.

| RPC ID | Method / target                                                           | Result                                                                                               |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1      | `eth_chainId`                                                             | `0x1237` = 4663                                                                                      |
| 2, 11  | `eth_getBlockByNumber`, initial latest and final named block              | Same block hash above                                                                                |
| 3      | `eth_call`, token `totalSupply()` (`0x18160ddd`)                          | `1000000000000000000000000000` raw                                                                   |
| 4      | `eth_call`, token `decimals()` (`0x313ce567`)                             | 18                                                                                                   |
| 5      | `eth_call`, canonical Multicall3 `aggregate3`, token `totalSupply()`      | Successful member, identical raw word; real repository reader decodes `1000000000000000000000000000` |
| 6      | `eth_call`, canonical Multicall3 `aggregate3`, token `decimals()`         | Successful member, identical 18                                                                      |
| 7      | `eth_getCode`, token                                                      | 7,154 bytes, retained; no claim of source verification                                               |
| 8      | `eth_call`, token `balanceOf(0x0000000000000000000000000000000000000000)` | 0 raw                                                                                                |
| 9      | `eth_call`, token `balanceOf(0x000000000000000000000000000000000000dead)` | 17,786 raw                                                                                           |
| 10     | `eth_getTransactionReceipt`, launch transaction below                     | Successful receipt at block 68,428,500                                                               |

Multicall3 address: `0xca11bde05977b3631167028862be2a173976ca11`.

Supply ABI word, direct and aggregate member:

```text
0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000
```

Decimals ABI word, direct and aggregate member:

```text
0x0000000000000000000000000000000000000000000000000000000000000012
```

### Initial, current, burned and circulating supply

The [launch transaction](https://robinhoodchain.blockscout.com/tx/0xc5781ef671e213d78666e0083a2a40fa961251e08a62bcaff568bf283c5decb2), at block **68,428,500**, contains this token's `Transfer` at log index **15** (`0xf`): from zero to launcher `0x0000ffffbe8efe702c8703ae3477ff5de3d319c0`, value **10^27 raw**. The same amount then moves through the launch strategy and PositionManager to PoolManager. These subsequent transfers are movements of the minted tokens, not additional mints.

At log index **25**, PoolManager returns **17,786 raw** to the strategy; at index **26** the strategy transfers that dust to `0x...dead`. The current dead-address balance is exactly that amount. This is a transfer to a burn address, not a `totalSupply()` reduction: current total supply remains **10^27 raw**, exactly equal to the launch mint. The zero-address balance is zero.

```text
Initial minted supply = current totalSupply / 10^18 = 1,000,000,000 tokens
Dead-address dust = 17,786 / 10^18 = 0.000000000000017786 tokens
Total less zero/dead balances = 999,999,999.999999999999982214 tokens
```

The last line is an explicitly defined subtraction, not a measured circulating-supply figure. Other circulation definitions may exclude locked or protocol holdings; such exclusions reduce supply and cannot make it approximately 6.97 billion. No holder enumeration or full lifetime transfer replay was needed or performed. Initial/current equality establishes no net supply increase between those observations, not a claim that no intermediate mint and burn ever occurred. It is enough to reject both an initially larger mint and a currently larger total supply as explanations for this FDV gap.

## Deployed-main implementation trace and disconfirmation

The deployed main revision was rechecked via gh-axi at **`0a01f4b5c9b60bfd86aa0b0299f67713692c991a`**. GitHub reports successful Vercel, API and ledger-tip deployment statuses for that SHA: [retained status](evidence/terminator-supply-2026-09-21/main-deploy-status.txt). This is deployment-status evidence; the public pool API does not itself expose a build SHA.

- [`packages/chain/src/hypersync-ledger.ts`](../packages/chain/src/hypersync-ledger.ts), `readLaunchMetadata`, requests name, symbol, decimals and totalSupply in schema-2 field order. It guards chain ID and pins a fresh public RPC block. `launchPools` decodes decimals with the ERC-20 ABI and supply with `BigInt`, preserving the raw amount as a decimal string. No assumed billion is substituted.
- [`packages/chain/src/multicall.ts`](../packages/chain/src/multicall.ts), `readContracts`, decodes aggregate members by request position and preserves raw results. Failed members are reread individually. This investigation called the real `readTokenSupplies` and `readContracts` implementations for this token, then compared them with independent direct calls at the same block.
- [`packages/chain/src/token-supply.ts`](../packages/chain/src/token-supply.ts) also requires a complete ABI word and uses `BigInt(word).toString()`. An unreadable supply is null, not zero or a fixed default.
- [`packages/db/src/index.ts`](../packages/db/src/index.ts), launch persistence, validates uint256 supply and its block together and stores `token_total_supply_raw` with `token_supply_block`. The optional manual reader's persistence in [`packages/db/src/token-supply.ts`](../packages/db/src/token-supply.ts) preserves strings/numeric and prevents an older observation replacing a newer one. Neither writer was executed here.
- [`apps/api/src/ledger-market.ts`](../apps/api/src/ledger-market.ts), `ledgerPool` and `readLedgerMarket`, reads stored supply as text and computes `BigInt(priceWei) * BigInt(supplyRaw) / 10n ** BigInt(decimals)`. Missing supply/decimals stays null. Both retained Pools Info FDVs exactly reproduce this formula with the independently measured supply.

The preferred explanation to try to disprove was that our fixed-looking 1 billion came from a bad Multicall decode, an assumed decimal count, or an obsolete pre-mint value. **Direct calls disprove the first two; current totalSupply and the launch receipt disprove a net mint-based gap.** The dead-address observation also rules out burn subtraction at the magnitude needed. These checks do not simply rely on the two websites agreeing about price.

## Exact FDV arithmetic

All on-chain quantities below are integers; no raw supply or wei value was converted through a JavaScript floating-point number.

```text
supplyRaw = 1000000000000000000000000000
decimals  = 18
priceWei  = 2557502070
fdvWei    = floor(priceWei * supplyRaw / 10^decimals)
          = 2557502070000000000
fdvETH    = 2.557502070
fdvUSD    = 2.557502070 * 2738.745
          = 7004.34600670215
```

Using pools.xyz's own same-response USD price and the chain supply:

```text
0.000006998671790648079 * 1,000,000,000 = 6998.671790648079 USD
48744.28670695654 / 0.000006998671790648079
  = approximately 6,964,791,058.2248928658 implied tokens
  = approximately 6.9647910582 times the chain supply
```

The quotient is an inference from their returned decimal numbers, not a supply field they exposed. At 1 billion tokens, their FDV would require **$0.00004874428670695654** per token, about 6.965 times their simultaneous quote. Decimal scaling errors would introduce powers of ten, not this factor. Initial versus current supply and the observed burned dust do not reconcile it. The external FDV is therefore inconsistent with its own quote and chain supply; its internal source remains unproven.

## Evidence verification and delivery

Run the offline verifier from the repository root:

```sh
node --import tsx docs/evidence/terminator-supply-2026-09-21/verify.mjs
```

It replays the exact recorded aggregate requests through the real repository decoder, compares direct/aggregate supply and decimals, checks the unchanged header, launch mint and dead-address dust, verifies both retained Pools Info FDV products, and checks SHA-256 hashes for the retained evidence. It makes no network or database call. This is evidence verification, not an invented product regression fix.

No runtime, accounting, database, API shape or UI code is changed. Integer-exact wei, realized = proceeds minus disposed cost, supported/excluded XOR, cross-window basis, initiator attribution, content-hashed batches, reorg reconciliation, writer lock and `discovery:v1` are untouched. No production action is required by this finding.

Delivery stops at the documentation/evidence commit for firstmate's no-mistakes gate. Full `pnpm check`, Postgres 17/18 database suites and browser suites are not claimed as run here; they remain required before any push under the delivery contract. No push or merge was performed.
