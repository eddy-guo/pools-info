# Core fixtures

`pooled-swap-70274936.json` is the recorded transaction of the pooled-sell
rule (docs/AGGREGATE-LEDGER.md, "Pooled swaps"; the figures audit's item H1):
`0x3ce590c1d1b3f775f17e3267f13f46a9a7cf52cb7d49f7fa985d2ecacd107387` in block
70,274,936 (2026-09-23 05:47:43Z), in which 147 wallets' Credits Strategy (CS)
tokens move to the batch-sell contract `0xbefe1731277769ba8e4f7e05bbfc1ef4715424f7`
(the transaction's `to`) and are sold in one PoolManager swap of
695,318,196.60 CS for 6.000424 ETH. The sender is one of the contributors.
Read on 29 Sep 2026 with `eth_getTransactionReceipt` and
`eth_getTransactionByHash` from the keyless public RPC
`https://rpc.mainnet.chain.robinhood.com` (no key, no quota); the 150 logs
are kept in full (149 CS `Transfer` legs, one `Swap`), the Swap log decoded as
`packages/chain` decodes one (`amount0 < 0` is a buy, `ethWei = |amount0|`,
`tokenRaw = |amount1|`, `tick` an `int24`). The explorer's own logs answer,
which the audit had cached, was paginated at 50 legs, which is why the audit
report says "about 50 wallets". `packages/core/src/ledger-pooled-fixture.test.ts`
folds it under both rules.
