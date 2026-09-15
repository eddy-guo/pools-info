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

## Implemented verifier

`packages/chain/src/launch-candidate.ts` now exposes `verifyLaunchCandidate`.
It validates the candidate and chain, locates a confirmed timestamp range, invokes
`collectCatalog`, and requires exact pool/token/creator/time agreement. Unsupported
CCA candidates fail before RPC work. Missing receipts, identity conflicts and changed
canonical cutoff hashes fail closed.

From the repository root, verify one saved candidate:

```sh
node --env-file-if-exists=.env.local --import tsx scripts/verify-launch-candidate.ts 0x8651e656738064177752a395dbde2b2a9e3fc469edc2a9212e6060c0990bb7eb
```

This reads the existing ignored `.env.local` RPC configuration, uses one-second
pacing and a 100-request budget, and atomically writes evidence under ignored
`.data/bootstrap/<pool-id>.json`. It makes no database changes. A fresh real run
verified PROLOGUE in 41 RPC calls at block 38994659. The earlier captured experiment
used 40 calls. No new service or key is required.

Validation: three focused verifier tests, full unit suite (128 passed, six skipped
across two suites), all 30 isolated Postgres tests and all workspace typechecks passed.
The skipped unit cases are database-gated; the separate database suite ran them.

## Next implementation

A bounded serial runner now exists:

```sh
node --import tsx scripts/verify-launch-candidates.ts --plan 1
node --env-file-if-exists=.env.local --import tsx scripts/verify-launch-candidates.ts --limit 1
```

Both modes accept a limit from 1 to 5. Plan mode makes no RPC calls. Run mode skips
matching saved evidence snapshots, processes the selected candidates serially, and
stops at the first failure to limit provider usage. Each candidate retains the
single-candidate verifier's 100-request budget. Failure records live beside evidence
as `<pool-id>.failed.json`; rerunning retries that candidate, and a successful retry
removes its failure marker. Neither mode imports data or advances database cursors.

A local exclusive `batch.lock` prevents concurrent batch commands. Normal exit and
SIGINT/SIGTERM release it after the child exits. A hard crash may leave a stale lock:
check its recorded PID and confirm no batch/child remains active before removing it.
The individual one-candidate command still explicitly re-verifies even a saved pool.

Skipped snapshots are historical verification results, not fresh canonical claims.
The runner checks registry revision, candidate identity and evidence presence to
resume collection. Database promotion must independently revalidate canonical
hashes and full evidence; it cannot treat this skip check as import authorization.
The runner reads only the committed snapshot of candidates, not a continuously
updated or exhaustive launch source.

Validation: script typecheck, real one-candidate run (42 calls), restart plan showing
four saved snapshots and a different next candidate, invalid-limit rejection,
concurrent-lock rejection, and an isolated wrong-chain endpoint proving failure
recording, stop-on-first-failure and lock cleanup. A separate SIGTERM check confirmed
that interruption waits for the child to exit and releases the lock.
The fixed 32-block search window can reject imprecise timestamp hints or unusually
many blocks sharing a timestamp. That is a safe rejection, not evidence of no launch.

Promotion into the database still needs explicit provenance and reorg reconciliation.
Do not advance the broad discovery cursor across the gaps between candidates. Do
not naively insert overlapping discovery batches or silently ignore identity conflicts.
After promotion, the normal per-pool history and accounting workers must populate
trades, holders and PnL; knowing a launch does not supply its financial history.

This can prioritize prominent missing pools without first completing the full launch
scan. It does not replace versioned exhaustive discovery. The public endpoint has
not been established as a supported third-party API contract; the saved hints allow
verification without putting an undocumented API in the production request path.

## Additional verified import cases

Two more saved candidates were verified through the CLI on 2026-09-15, each in
41 RPC calls. Full public chain evidence is committed under
`data/registry/candidate-proofs/<pool-id>.json`; no RPC URL or browser session
material is included. These are verification-time snapshots and must be canonically
revalidated before import, not trusted indefinitely.

- CHARTY: pool `0x037ccba86d253cc20cf7db69f90efedc2d2087d95715a69d994ad8381d860f72`, launch block 62805658.
- Maxi: pool `0x4c98e53cdaf264aea36ea794898982509651a75bd2fd75121eccec3ec15e20c1`, launch block 55314563.

Before verification, exact-token production queries returned HTTP 200 with total 1
for CHARTY (the first case) and total 0 for the second case. Use the first to test
identity-preserving overlap with an existing pool, and the second to test creating
a missing historical launch. Neither verification changed production data or advanced
any discovery cursor. These observations prove two launch cases only, not complete
catalog coverage or financial history.
