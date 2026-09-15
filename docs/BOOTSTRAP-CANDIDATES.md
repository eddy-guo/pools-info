# Launch discovery candidates

Observed on15September2026 through the public [Pools homepage](https://pools.xyz/).
Its batched `curve.listLaunches` requests used `sortBy` values `trending`, `volume`
and `fdv`. Each returned100 records as a plain array, without a pagination cursor.
Their union contained193 distinct pool IDs:161 with `launchpadId` equal to
`uniswap-bonding-curve`, and32 equal to `uniswap-cca`.

These are discovery hints, not an exhaustive or verified catalog. The procedure's
name does not establish that every returned launch is Instant. Preserve the CCA
candidates for a separate verifier; never assign them Instant launch facts or PnL.

## Saved evidence

- `data/registry/pools-launch-candidates-2026-09-15.json` keeps only pool/token/
  creator identities, creation-time hints, launchpad labels and observed sort lists.
  It deliberately excludes descriptions, images, API prices, volumes and balances.
  `verified:false` and `exhaustive:false` are explicit. No runtime imports this file.
- `data/registry/prologue-candidate-proof.json` contains the existing RPC catalog
  collector's complete evidence for one candidate. No browser session or RPC URL
  is included. This proof is not automatically imported into production.

## Verified experiment

PROLOGUE's API creation-time hint was2026-08-17T16:52:13Z. A read-only binary search
over block timestamps found the first block at or after that second. The existing
`collectCatalog` verifier then examined blocks38994650..38994681 and verified:

- Pool `0x8651e656738064177752a395dbde2b2a9e3fc469edc2a9212e6060c0990bb7eb`
- Token `0xb9972ca7188e511174947e3936a5315ac7073277`
- Creator `0x240b7e8fcfdb38c94c0b8733a4a50f28a4c99fa8`
- Launch block38994659 and timestamp1786985533
- Transaction `0x421c9f5b02412645661089c4857003a6e7a6a0c55a390a447079494096077bed`

The pool, token, creator and timestamp matched the candidate. Verification used40
RPC calls, with one-request batches and1second pacing. It verified only the32-block
range, not the intervening history. An exact-token production explore query returned
HTTP200 with total0, confirming that this candidate fills a real catalog gap.

## Next implementation

Build a bounded candidate verifier around this proven lookup path. Treat timestamps
only as locators: wrong or imprecise hints must fail verification, never create a
launch. Validate canonical cutoff, receipts, deployed strategy/launcher and PoolKey
using the existing collector, then require exact candidate identity agreement.
Persist per-candidate progress and evidence so restarts do not repeat successful work.

Promotion into the database still needs explicit provenance and reorg reconciliation.
Do not advance the broad discovery cursor across the gaps between candidates. Do
not naively insert overlapping discovery batches or silently ignore identity conflicts.
After promotion, the normal per-pool history and accounting workers must populate
trades, holders and PnL; knowing a launch does not supply its financial history.

This can prioritize prominent missing pools without first completing the full launch
scan. It does not replace versioned exhaustive discovery. The public endpoint has
not been established as a supported third-party API contract; the saved hints allow
verification without putting an undocumented API in the production request path.
