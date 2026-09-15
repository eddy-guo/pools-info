# Verified Robinhood Instant deployment registry

`packages/chain/src/deployments.ts` defines `robinhood-instant-v2`. Its source is
Uniswap's public SDK deployment registry pinned to revision
[`2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f`](https://github.com/Uniswap/sdks/blob/2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f/sdks/liquidity-launcher-sdk/src/addresses.ts).
All 12 listed Robinhood Instant strategies were checked using the existing
Alchemy RPC on chain 4663 at block 63243824. The recorded values are in
[data/registry/robinhood-instant-v2.json](../data/registry/robinhood-instant-v2.json).
This is a pinned, reviewed registry, not automatic trust in changing upstream code.

## Generations

| Generation             | Fees-on deployment block | Fees-off deployment block | Tick spacing | Launcher |
| ---------------------- | -----------------------: | ------------------------: | -----------: | -------- |
| c3f9506                |                 22754669 |                  22754669 |           60 | Original |
| 8e40a35                |                 23385219 |                  23385219 |           60 | Original |
| 3e05da8                |                 23618250 |                  23618250 |           60 | Original |
| v3.1.1                 |                 28080860 |                  28080860 |           60 | Interim  |
| August 5 full redeploy |                 28519960 |                  28519981 |           25 | Re-mined |
| v3.3.0                 |                 57982785 |                  57983002 |           25 | Re-mined |

- Original launcher: `0x00004c4ccc709ef590f7c81102c0689f0263d4e9`.
- Interim launcher: `0x7a6c474b4dcd35b72203d2b569eafe4c9b5c768e`.
- Re-mined launcher: `0x0000ffffbe8efe702c8703ae3477ff5de3d319c0`.

These mappings came from each strategy's `launcher()` getter, not a broad list
of interchangeable allowed launchers. Receipt evidence must match the launcher
for the emitting strategy. Historical pools remain valid after a new strategy
ships. The original implementation followed only the August 5 pair.

## Evidence and validation

For every strategy, verification read nonempty runtime bytecode and recorded its
Keccak256 hash, then checked `launcher`, `poolManager`, `feeSplitter`,
`beneficiaryVault`, `TICK_SPACING`, `initialTick`, `MIN_LAUNCH_TICK` and `LP_FEE`.
The getters match the pinned official SDK: fee 2500, the common verified manager,
zero beneficiary vault for fees-off, and the expected per-generation splitter
and tick settings. An archival `eth_getCode` binary search found the exact first
block with code, with no code at the immediately preceding block. No explorer or
paid indexing API supplied these results.

The event ABI is the published `TokenLaunched` shape, also present in the
[deployed August source](https://github.com/Uniswap/liquidity-launcher/blob/dd8769cd45c0e9450e928513ee129b0af74f7f32/src/strategies/InstantLaunchStrategy.sol).
The v3.3 source label in the SDK is `1c59049`; verification here uses its public
SDK deployment record plus actual runtime/getter/event evidence, not a claim of
independently reproducing the v3.3 compiler output.

Launch decoding checks the emitting strategy, native currency0, matching token,
zero hooks, generation-specific fee/tick spacing and permanent position
recipient, and recomputes the full PoolKey hash. Collection rejects launches
before the strategy's verified deployment block. Matching successful receipt
logs and canonical headers remain mandatory. Snapshot exporters check only the
strategies actually represented at their cutoff and compare their runtime hashes;
later deployments must not make an earlier historical capture fail.

## Boundaries and historical coverage

The registry covers all Robinhood Instant entries in the pinned SDK revision.
It does not make the whole product registry exhaustive: Crowd/LBP creation,
auctions, migration and failed auctions have different lifecycle evidence and
remain unsupported. Arc and other chains, arbitrary custom strategies, and
unrelated Uniswap pools are not admitted. A matching pool shape alone does not
prove Pools membership.

Old discovery checkpoints searched the original two strategies only. Appending
registry entries does not retroactively verify their earlier ranges. Preserve
those checkpoints and record a distinct registry revision and coverage for a
rescan; do not silently relabel old history or destructively reset it. A full
scan from the earliest verified block spans roughly 40.5 million blocks at this
verification cutoff and is costly under a 10-block logs limit. This change adds
no automatic historical reset or expanded unbounded scan.

## Reproduced omission and positive checks

An official pools.xyz listing supplied only a token/timestamp discovery hint for
POOLS (`0x385b36ff682ab4c76e7c37a66b96aabc466471d5`). Alchemy independently located
and verified its launch at block 23467030, transaction
`0xfbe305aa19b8c92d7a2c3577d71f102f8355ba9066d1b77f327ba46844bbe3b7`.
The emitting strategy is the historical 8e40a35 fees-on deployment
`0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2`, with tick spacing 60 and the original
launcher. The original two-entry registry rejects this real launch. The expanded
collector accepts its matching PoolKey, canonical header and launcher receipt,
and verifies 16 swaps in the first 10 blocks. The complete bounded proof is in
[data/registry/omitted-launch-proof.json](../data/registry/omitted-launch-proof.json),
and a regression test replays the actual raw logs, headers and receipts.

A separate contemporary check verified IPO at block 63244530, transaction
`0xf62531e72314986fdeb3ad41ab47eb5eb6404ef065038e02cd470304fec80d7e`, plus one
initial swap. It still used the original August 5 fees-on strategy. This confirms
backward compatibility and also limits the diagnosis: missing recent activity
cannot be attributed solely to missing v3.3 deployments. Cursor lag and launches
outside the scanned window remain separate issues. The latest 1000-block v3.3
probe returned no launches; it does not establish that v3.3 has never been used.

The website API was a research hint only. No application, collector or read API
now depends on pools.xyz responses, their moderation flags, prices or statistics.
All persisted proof and new registry validation use the existing Alchemy RPC.
