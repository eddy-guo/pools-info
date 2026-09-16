# Phase A operating record

Read root `STATUS.md` first for the user's priorities and 08:34 UTC baseline.
The user explicitly approved historical discovery on September 15, 2026.

## Current state: resumed with explicit approval

The user answered **Resume with the revised estimate** after the budget pause.
The estimate is roughly **7.8M CU for discovery**, plus existing workers.
Do not treat the previous 2.4M figure or pending-approval language as current.
Railway's reviewed resume diff was exactly v2 flag **0 -> 1**. Active deployment
`246355c8-4a9f-49e9-a8ae-5006d78e96dd` uses `b641930`. Discovery catch-up now
runs without deep pool work between batches; recent and analytics continue.

Luna independently sampled the API at 09:09:41.553 and 09:10:46.108 UTC:

| Metric | First sample | Second sample |
| --- | ---: | ---: |
| v2 cursor | 24,694,668 | 24,964,668 |
| exact indexed pools | 624 | 625 |
| pools carrying v2 evidence | 323 | 324 |
| pools with factory images | 191 | 192 |
| v1/v2 source overlap | 0 | 0 |

That is 270,000 blocks / 64.555 seconds, about **4,183 blocks/sec** in a sparse
interval. V1 remained at 62,923,934 with its original saved timestamp. Recent
lag was **3,837 blocks** at 09:09:46; most swaps were still unregistered
(2512 / 3039 in that batch), so do not credit registry expansion for the lag
improvement yet. The wider log ranges and pacing preceded broad registry coverage.

The refreshed Alchemy total at about 09:11 was **4,111,218 CU**; the displayed
peak remained 1,467 / 10,000 CU/s. This is an account-wide total, not a per-worker
meter. Compare subsequent reports against this observation and the initial
2,188,684 baseline with the other workers' work disclosed.

Coordination now runs every **15 minutes**, per the user's latest request.
The Astra coordinator reuses Sol task `01a0a453-d8d3-71b1-bc60-0a0d86a4c31e`
for technical review/implementation and Luna task
`01a0a454-161b-7931-bd37-68cebdf6186b` for bounded status sampling. Public
API samples cannot establish 429 counts or provider spend. Root retains
Railway/Alchemy changes and verifies worker results before integration.

## Budget pause history (cleared by the approval above)

The scan initially ran successfully and was paused under the user's explicit
instruction to stop if CU consumption materially exceeds the 2.4M estimate.
The blocker was the incomplete estimate, not evidence of a retry loop.

Alchemy usage rose from 2,188,684 to **3,146,960 CU** around 08:55 UTC, a
**958,276 CU** account-wide delta. Its September 15 method chart showed roughly
39% receipts, 37% headers, 10% getLogs, 8% eth_call and 6% getCode. This includes
all three workers and is not a discovery-only meter. The displayed peak was
1,467 / 10,000 CU/s. The one-hour error filter returned no errors when checked.

The current collector's no-retry Phase A model for 52,404 launches is:

| Work | Approximate CU |
| --- | ---: |
| 40,529 log requests at the approved 1000-block range | 2,431,740 |
| Two name/symbol eth_call reads per launch | 2,725,008 |
| Fixed checkpoint/head reads over about 4053 atomic batches | 567,400 |
| One separate receipt and block header per launch | Up to 2,096,160 |
| Illustrative discovery total | **7,820,308** |

Shared launch transactions/blocks reduce variable evidence reads; launch
count, splitting, retries, reorgs and head growth change the total. This excludes
recent, deep and analytics work. Rates are from Alchemy's official
[compute-unit table](https://www.alchemy.com/docs/reference/compute-unit-costs):
getLogs 60, eth_call 26, receipts/headers 20, blockNumber 10. Batches are billed
per constituent call. The name/symbol calls alone already exceed the original
2.4M figure. `INDEXER_LOG_RPC_URL` was inspected without exposing credentials:
it references `${{indexer.ROBINHOOD_RPC_URL}}`, not a separate free log provider.

Railway's reviewed abort diff was exactly `INDEXER_DISCOVERY_V2_ENABLED: 1 -> 0`.
The redeploy was accepted at 08:59 and is `e7654b27-4a24-4d6c-9141-d970c1d09574`.
It uses commit `b641930`. At **09:03:18 UTC** its runtime logs confirmed
`logRangeBlocks:1000`, `minIntervalMs:250`, `maxBatchSize:10`, writer ownership,
and **`discovery_v2_disabled`**. The API at09:03:50 reported v2 frozen at
**24,284,668** and exact counts: **547 total,145 with factory images,301 v1,
246 v2,0 overlap**. The new recent worker reported lag **12,295** at09:03:45.
The CI run
34949572780 is green, including both Docker builds and runtime smoke checks.

**Flag-off pauses only discovery.** Existing recent and analytics workers stay
enabled, and deep collection resumes when v2 is disabled. Do not call this a
whole-service spending stop. Product work remains paused under STATUS.md.
The saved v1 cursor remains 62,923,934. At08:59:23 v2 was24,034,668. The final paused metrics above supersede that sample.
The user subsequently approved resumption; see the current-state section above.

## Activation

- Railway project: `zestful-fulfillment`, `51279532-d7a4-491e-92db-e30997ed9223`.
- Production environment: `0464eb3f-148d-46a5-9b08-759576f682f1`.
- Indexer service: `d41596b3-6c74-4f96-a0fe-b6655c98ba95`.
- Configuration deployment: `e798bf66-5592-4068-a1f4-a66eacf90be2`.
- The new container acquired the main writer lock at **08:39:52 UTC**.
- `/ready` returned HTTP 200 at **08:41:25 UTC**.

Applied values:

```ini
INDEXER_LOG_RANGE_BLOCKS=1000
RECENT_LOG_RANGE_BLOCKS=1000
INDEXER_DISCOVERY_V2_ENABLED=1
RPC_MIN_INTERVAL_MS=250
RPC_MAX_BATCH_SIZE=10
```

Railway's reviewed deployment diff showed the two log ranges changing from
10000 to 1000, RPC batch size from 4 to 10, and v2 activation from unset to 1.
250ms was already configured and did not create a fifth diff entry. These
values were applied to Railway, not merely the local environment file.

`INDEXER_DISCOVERY_BATCH_BLOCKS` remains its default 10000. This is the atomic
commit range; the RPC client splits it into log requests of at most 1000 blocks.
A `discovered` line with `advanced:10000` therefore does not imply a 10000-block
RPC request. The recent worker separately logged a 1000-block committed batch.

## First verified progress

The public read API confirmed v2's persisted start is **22,754,669**. The new
deployment logs and subsequent API observation showed:

| UTC | v2 committed cursor | Evidence |
| --- | ---: | --- |
| 08:39:54 | 22,774,668 | `discovered`, 10000 blocks committed |
| 08:40:46 | 22,854,668 | `discovered`, 10000 blocks committed |
| 08:41:25 | 22,894,668 | `/v1/status` saved cursor |
| 08:46:19 | 23,264,668 | `/v1/status` saved cursor |

The first two observations measure **80,000 blocks / 52 seconds**, about
**1,538 blocks/sec**. This sparse early interval is not a full-run ETA. It
includes deep pool work between discovery batches; launch-heavy intervals also
need receipts, contract calls and metadata verification. The log-query CU
estimate is not a total for every method and worker.

V1 stayed at **62,923,934**, hash
`0x5d6729bc6b864fd7b271488dd056febd9bba5c71d1828c72d1c380ca8de2724f`,
with its saved timestamp still **07:26:44.328 UTC**. No local writer was started.
After refreshing the Railway page, deployment `e798bf66` explicitly showed
**Active** in its deployment header.

At 08:40:22 the recent worker committed 1000 blocks, observed 2034 swaps,
saved 490 registered swaps and reported 1544 unregistered swaps. Its reported
lag was 59,469 blocks, versus the user's 65,113-block 08:34 baseline. At 08:45:58 it reported lag of 45,797 blocks. Analytics
was publishing alongside it. No rate-limit failure appeared in this inspected
startup interval. Existing internal successful retries are not yet individually
observable, so this is not proof of zero 429 responses.

## Counts and provider use

The user's 08:34 baseline was **410 catalog pools**, **301 processed pools**
and **315 qualifying traders**. Catalog totals combine historical and recent
observations; they must not be called an exact `indexed_pools` table count.
The current public status reports pool streams, not a table count. Exact table
and factory-image counts are being added to the existing operational status
read. The local database URL is private and cannot resolve off Railway; do not
change database networking just to obtain these statistics.

The authenticated Alchemy Usage dashboard was refreshed during startup. It
showed **2,188,684 CU used this month**, **No usage cap**, and a displayed peak
of **588 / 10,000 CU/s**. Use this fresh total for subsequent deltas rather than
assuming the earlier 23.7M-remaining figure describes the upgraded plan's
current counter. The total includes all three workers and dashboard reporting
may lag. No billing settings were changed.

Around 08:50 UTC, Alchemy Request Logs was filtered to **Last hour** and
**All errors** (`time=hour&allErrors=true`). It returned **No request logs found**.
This is provider-dashboard evidence for that selected window, supplementing
the Railway startup logs; it is not a claim about dashboard retention or every
future request.

## Monitoring and abort

The heartbeat `phase-a-discovery-progress` is active as **Pools Info coordination**
every 15 minutes. Preserve the explicit approved runtime configuration; never
assume editing local `.env.local` changes Railway.
Report exact indexed count, factory-image count, v2 cursor and interval speed,
all-worker 429 evidence, recent lag and source identity conflicts. Refresh
Alchemy usage partway through and compare its delta with actual work rather
than treating only `eth_getLogs` as the entire workload.

On sustained throttling, runaway retries, material unexpected consumption or
identity conflicts, set `INDEXER_DISCOVERY_V2_ENABLED=0` on this Railway service
and deploy. Preserve all cursors and evidence. Report the problem immediately;
do not substitute unrelated work. The operational increment described in
[RPC-RATE-LIMIT-STOP.md](RPC-RATE-LIMIT-STOP.md) logs recovered limits and stops
the service after four throttled attempts. If `service_paused_rpc_rate_limit`
has already stopped it, leave it stopped and report; do not restart merely to
change the flag. Confirm the increment's deployment before relying on the guard.

When v2 reaches the confirmed chain cutoff, record the final count and fraction
carrying factory `image_url`. Compare with 52,404 measured FeeSplitter positions
without assuming the counts must be identical. Then proceed to Phase B's
global atomic swap persistence. No LBP/CCA decoder expansion or evidence
pruning is authorized.

## Operational validation

The operational increment passed `pnpm check`, all **44 database tests** with
zero skipped, and **82 desktop/mobile browser tests** on September 15. The
first full DB run exposed an environment-dependent activation test (expected
off while `.env.local` explicitly enabled v2); the test now scopes and restores
its own environment, and the full suite was rerun successfully. No environment
file was changed to make the test pass. Exact counts use normalized columns
and surviving launch-source evidence in `/v1/status.indexedPools`.

The scheduler increment prioritizes v2 historical discovery over deep pool
work until catch-up; recent and analytics remain separate processes. This
removes the several seconds of deep work between discovery commits. New
startup logs report configured `logRangeBlocks`, `minIntervalMs` and
`maxBatchSize`. This section records validated code; confirm its new Railway
deployment and continued cursor movement before claiming it is live.

## Operating notes: idle cost controls

After the historical sweep reached the tip, the idle burn was measured at about
1.19M CU per hour (cost study, 2026-09-16): the live feed 35%, the tier-3 deep
sweeps 34%, analytics 29%, discovery at the tip 2%. Four controls now exist;
their per-cycle effect is proven against the mock transport, and the hourly
figures below are derived from the measured method mix, to be verified from one
hour of the Alchemy hourly series after a captain-approved resume.

- **Live feed cadence.** `RECENT_TIP_POLL_MS` (default 30000) replaces the fixed
  2-second pause after a cycle that reached the confirmed head. Within a cycle
  every canonical header is read once (head, the shared cursor, both boundaries,
  each swap block) and one combined log query serves discovery and swaps; the
  mock cycle dropped from 14 headers and 2 log queries to 5 and 1. Reorg
  reconciliation and the `head - 128` buffer are unchanged.
- **Multicall3.** `MULTICALL3_ADDRESS` (unset = the canonical deployment,
  `0` = off) aggregates name/symbol per launch, decimals/totalSupply per pool
  and balanceOf per trader into one `eth_call` per bounded batch of 200 members,
  with `allowFailure` per member: a failed member is re-read on its own and
  fails exactly as an individual read would. If the address has no code or the
  aggregate call fails, that transport reads individually for the rest of its
  life. The raw aggregate replies are retained as `calls` evidence beside the
  logs, receipts and headers, and expand back to every member for verification.
- **Sender code cache.** `sender_code_observations` (migration 013) keeps one
  `eth_getCode` observation per transaction sender. `SENDER_CODE_RECHECK_BLOCKS`
  (default 1,000,000, about a day) bounds how far an observation may answer
  for; the reuse rule is documented on `senderCodeReusable` in
  `packages/db/src/sender-code.ts`. The accounting rule is unchanged: a sender
  with code at the pool cutoff is flagged `contract_sender`.
- **Deep tier switch.** `INDEXER_DEEP_TIER_ENABLED=0` keeps the tier-3
  per-pool sweeps paused with their cursors intact while discovery, the broad
  range, the live feed and analytics keep running. `pnpm indexer:status` shows
  the value in effect. The default is 1, so nothing changes until it is set on
  Railway; the captain's decision D4 keeps the deep tier off after the resume.

None of these variables is set on Railway by this change, and the indexer stays
stopped until the captain resumes it through the main firstmate.

## Paused product work

Trade-card UI, font, metadata and browser-test work was safely saved in
`stash@{0}`, named `Paused verified trade-card UI for Phase A activation`. Its stable commit
identity is `f56d87fb7c83fcdf0bffbd1c16458ed7f3adee2f`.
Use `git stash apply` with the resolved stash identity when deliberately
resuming it; verify before dropping the stash. No unfinished product files
were pushed during the focus change.
