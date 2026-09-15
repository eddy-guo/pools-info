# Pools-specific indexing scope

Confirmed with Eddy on 14 September 2026: the product targets Pools launches on Robinhood Chain, rather than every token or every Uniswap pool on that chain. This matches the original scope in README.md and SPEC.md under docs.

## Evidence

- Uniswap describes Pools as its Robinhood token launchpad, with Instant and Crowd launch paths: https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain
- The current support page identifies pools.xyz as that launchpad: https://support.uniswap.org/hc/en-us/articles/47943121516685-Launching-and-trading-tokens-on-pools-xyz
- The broader Uniswap Launches product aggregates multiple launchpads. Pools and the Uniswap-wide launch aggregator are different product scopes: https://blog.uniswap.org/launch-aggregator-explore-top-uniswap-launchpads-in-one-place
- Chrome inspection of pools.xyz on 14 September found a site banner stating pools.trade is now pools.xyz. Its homepage requested curve.listLaunches and cca.listAuctions. The inspected responses each contained 100 records on chain 4663; every returned instant-launch record had launchpadId `uniswap-bonding-curve`. The response size is not a total protocol count. These observations establish the visible discovery surfaces, not the complete contents or implementation of the site's private backend.
- The underlying Liquidity Launchpad framework is permissionless and supports custom strategies and existing tokens. The generic framework or a matching pool shape alone does not establish membership in the Pools product: https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/overview

## Membership and collection

1. Maintain a verified deployment registry for Pools launch paths, including applicable historical and current versions, chain, strategy type, ABI and activation blocks. Verify registry entries against official source/deployments and on-chain evidence before using them.
2. Discover launch/auction events from those deployments, verify associated launch transactions and PoolKeys, and store the evidence establishing membership.
3. Index swaps in the resulting pool IDs, regardless of which frontend submitted the trade. Track Transfer events for the discovered token addresses to reconstruct holders, including holders who never traded directly in the original pool.
4. Preserve distinct identities: token `(chainId, tokenAddress)`, pool `(chainId, poolId)`, launch/auction identity, and their relationships. A token can have multiple pools; an auction can exist before any trading pool is created. Failed auctions still belong in launch history.
5. Rank supported trading activity across covered Pools pools. Do not label this as a wallet's whole-chain profit. Transfers or other venues that make cost basis unknown remain explicit exclusions until supported.

On-chain evidence can establish use of a launch path, not whether a person clicked pools.xyz versus called the contracts through another frontend or script. Exact replication of the site's moderation/listing policy would need separate evidence. Preserve launch membership separately from display eligibility.

## Current implementation gap

The collector now has a versioned registry of all 12 Robinhood Instant strategy entries in the pinned official SDK, spanning six generations and three historically mapped launchers. Runtime code, getters and deployment blocks were verified using Alchemy. Historical 60-tick and current 25-tick pools retain their own pool shape, recipient and creator-fee variant. See [DEPLOYMENT-REGISTRY.md](DEPLOYMENT-REGISTRY.md) for the exact source revision and evidence.

Registry support is separate from scanned coverage. Existing discovery cursors searched only the original August 5 pair; their earlier ranges do not become complete for the ten added strategies. A separately tracked rescan is needed to cover those gaps. No destructive reset or automatic full-history rescan is included. Crowd/LBP auctions and migrations remain explicitly unsupported, so the overall product registry is still not exhaustive.

The database and worker should implement this narrower protocol scope. Unrelated Robinhood token deployments, other launchpads and arbitrary Uniswap pools are outside the default catalog. Complete indexing still requires historical backfill, resumable progress, canonical-block reconciliation, holder snapshots and trader accounting; narrowing scope reduces the work but does not remove these requirements.
