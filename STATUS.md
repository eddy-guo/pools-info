# Status - 15 Sep 2026, current settling pass

## HyperSync history backfill: built and tested, not run (16 Sep, 02:25 UTC live check)

The complete tier-2 swap history is to come from Envio HyperSync on its free
tier into the existing `swaps:broad:v1` stream and tables, with a
transaction-shaped evidence variant beside the receipt-shaped one
(`docs/HYPERSYNC-BACKFILL.md`). The transport, the broad collector and
verifier, the tier-3 Transfer collector and the bounded `pnpm hypersync:plan`
and `pnpm hypersync:run` commands are on `fm/pools-hypersync-history-p3`. A
bounded live check (two height reads, seven small queries over 20 blocks)
recorded the wire shape as fixtures; the backfill itself has not been run and
waits for the captain's word. The indexer stays stopped; nothing touches
Alchemy or Railway.

## Resumed goal handoff: tier-2 CI blocker

The validated production baseline is **b985105** (full CI **34966065169 passed**).
Its API was verified live: launch sorting covers the discovered catalog; volume
sorting returns 488 measured pools, with 8 rows at offset 480 and no missing
values. Liquidity has no published comparable values. The 7-day verified board
has 367 wallets, 25 actual rows per page, with evidence labels.

Candidate **6138ed9** is preserved on **wip/tier2-serving-candidate**, pushed to
origin. Its local 115k-swap/52k-pool complete reads improved from 2,939ms to
1,026/862/860ms (cold/warm 7-day/All), retaining all 11,500 fixture wallets.
The expensive work was SQL numeric normalization on every row; validation stays
integer-exact, while normalization now runs only for cross-source comparisons.
Source tests also found and fixed a real bug where changing a duplicate's pool
could hide a conflict behind eligibility filtering. Both directions now reject
it. Mixed accounting, pre-window basis and canonical rewind are covered.

Local candidate validation: `pnpm check` passed; final lint/build passed;
**103 Postgres checks passed with zero skips**; **102 browser tests passed with
no retries**. However CI **34968386636**, job **104378294611**, failed the scale
test with PostgreSQL **57014: canceling statement due to statement timeout** at
`tier2-read.ts:143` (initial coverage/metadata query), called from
`accounting-read.ts:366`. The other 102 DB checks passed. This is a different
environment failure from the earlier local per-row bottleneck, not permission
to increase the 3-second statement or 2.8-second accounting budgets.

**Candidate acceptance remains blocked by CI.** The public API currently returns
HTTP 200 with 367 verified-only wallets and no tier-2 coverage field. The Railway
commit status reports success despite the failed CI, so do not assume the CI
result alone proves which revision was or was not released. The candidate
runtime is reverted from main to the validated baseline; the feature and tests
remain safely on the candidate branch. Next work must reproduce/profile this
CI PostgreSQL query plan and establish sufficient margin before deploying and
visually verifying actual tier-2 rows. No further infrastructure/product work
was substituted. No sweep, coverage job, schema, billing change, cursor reset or
new worktree was started. The full goal remains incomplete.

## Current priority and blocker

The user requested a ranked deep scheduler, launch-first screener with metric-only
sorts, explicit coverage tiers, and measured first-paint layout stability. No new
sweep, new coverage job, billing change or worktree was started for this pass.

Scheduler commits **fed7758** and **93a0cb8** are on main. The latter fixes the
initial overdue override: waiting age is weighted 64/16/4/1 for ranks <=500,
<=2,000, <=10,000 and the remainder. Within a band the oldest attempt goes first.
A 40k aged-backlog test proves sustained high-band preference and lower-band
progress. Source identity, exact wei, compatible range grouping, writer lock and
reorg rules are preserved. Full CI **34963571241 passed** at 93a0cb8.

**Tier-2 ranking: CI blocker reproduced and fixed on `fm/pools-tier2-serve-p1`.**
The 57014 statement timeout at `tier2-read.ts:143` was PostgreSQL JIT: on the
Debian `postgres:17` image (LLVM present, `pg_jit_available()` true) the
candidate's coverage statement had an estimated cost of 753,250, far above
`jit_optimize_above_cost`, and compiling it took 2,951 / 2,868 / 2,900 ms per
request in CI run 35047485541, against 159 ms with `jit=off`. Every Homebrew
Postgres on the development machine lacks LLVM, so no local run could show it.
A second, smaller cause surfaced once JIT was off: the cursor statement sorted
every canonical row on text keys in an external merge under the stock 4 MB
`work_mem`, and the same code measured 1,285 ms on one runner and 2,257 ms on
another (run 35049292470). The read preamble now sets `SET LOCAL jit = off` (a
regression test checks the transaction settings on any build), the coverage
statement carries only the CTEs it reads with the catalog looked up per active
pool (estimated cost 94,041), and the cursor statement streams evidence one
book at a time in byte order, each book's copies read through the pool history
indexes and sorted in memory, so the ledger's grouping order costs one bounded
sort per pool instead of a whole-history sort; the fold verifies that order and
fails closed. Measured complete 115k-swap/52k-pool reads (cold, warm 7d, warm
All): CI run 35053090850 on Debian 17.11 with JIT available under the full
parallel `test:db` 1,096 / 969 / 941 ms; local Postgres 17.11 (port 5417,
stock container settings, no JIT) 951 / 813 / 621 ms and Postgres 18.6 (port
5418) 559 / 517 / 527 ms under the full `test:db`, 114 database checks passing
with zero skips on each. The 3,000 ms statement timeout and the 2,800 ms
accounting budget are unchanged. Deployment and visual verification of tier-2
rows follow the merge decision.

Read-only production measurements:
- At 11:26:57 UTC: 488 deep pools, 574 pools with observed volume in the requested
  trailing filter; deep pools account for **16.0908%** of stored observed volume.
- Top 400 account for **99.1837%** and top 500 **99.8360%** of that stored volume.
- At 11:28:11 UTC: 388,815 contiguous retained recent blocks; top 500 density
  **23.5233%**, up-to-2,000 measured set density **23.5356%** (only 575 rankable).
- At 10 blocks/sec and the measured densities, 14-day block receipts alone would
  be ~56.9M CU; logs plus those receipts ~57.6M CU, before other calls/workers.
- **89.34% of recent observed swaps were unregistered at collection.** Unmeasured
  pools are not zero-volume pools. These shares cannot establish whole-market
  coverage or the true global top500/top2000. No spend was authorized by them.
- Evidence: `docs/evidence/ranked-observed-volume-2026-09-15.json`.

Alchemy's account-wide cap was set and visibly verified at **50M CU** per the
user's choice. Earlier Phase A ETA at 10:59 was ~7h and 20-23M additional account
CU; that is a dated observation, not a fresh estimate.

Only main and `.pools-info-market-rollups` remain as worktrees. The four redundant
worktrees were removed and their two helper app tasks archived. The old heartbeat
is paused. Market WIP e7d0058 is still unmerged; its bounded 52,031-row fixture
passed with 828.1ms serving latency and 521 pages/52,031 unique IDs.

Frontend validation is complete independently of the blocked Tier-2 path.
Lint, typecheck, unit tests and production build passed; the final full browser
suite passed **102/102 with no retries**. All six tested routes
on desktop/mobile (12 cases) record CLS 0 with unchanged sentinel geometry,
including on-demand pool success/error. Exact measurements are saved in
`docs/evidence/layout-2026-09-15/measurements.json`. Four approximate route loading components
are deleted; real nullable elements retain their nodes and pending texture.
The text ramp is applied and paired screenshots are saved in
`docs/evidence/layout-2026-09-15/`. Do not call the whole requested project done.

---


## Priority update: consolidate, measure, then widen the leaderboard

The latest user instruction supersedes the earlier Phase B sequencing below:
1. Consolidate the existing worktrees before starting anything else.
2. Report the distinct-block fraction of registry-pool swaps and projected CU
   for full history and a trailing 14-day window, with writes disabled.
3. Add explicitly flagged tier-2 swap/initiator ranking with a trailing default;
   retain tier-3 Transfer-backed verification as a badge. Preserve exact wei,
   the realized/basis identity, basis across windows, and canonical reconciliation.

Task 1 is consolidated locally. Merge **5f89d4b** brings `wt/block-receipts`
(`b1f3173`) into main, including migrations 010/011, broad collection/persistence,
dated token units, pool-detail serving, block-receipt transport and the refreshed
snapshot precedence fix. Git reported no conflicts in the actual current tree.
The six anticipated conflict files and supervisor were reviewed against both
parents: main's discovery-first scheduling, writer lock, sticky rate-limit stop,
sibling drain and clean non-restarting service exit remain intact. Phase B is
still disabled by default; no historical writer or production configuration was
changed for consolidation.

Rollup edits were saved on existing `wt/market-rollups` as WIP **3f1dbdd**
(24 files at the actual snapshot). They were rebased onto the merged main with
an identical patch, verified by `git range-diff`. Migration 012 and the broad
explore/rollup work remain on that one WIP branch, not main. Its 52k-pool fixture
still needs bounded seed batches and serving-latency verification before landing.
The duplicate `wt/broad-reads` branch was deleted as requested.

The detached phase-b, broad-reads, token-units and block-receipts worktrees are
now redundant and may be closed. Their directories were left in place for the
user. Only main and market-rollups need to remain. Do not create more worktrees.
All workers are idle after the merge review; the 15-minute coordination heartbeat
is paused during consolidation. The saved UI stash is unchanged.

Validation of the merged code: `pnpm check` passed; the real local Postgres
suite passed **85/85, zero skips**; the complete desktop/mobile browser suite
passed **90/90, no retries**. The identical code parent `b1f3173` also passed full
GitHub CI **34958739524**, including both container builds and smoke checks.
Task 2 is reported in `docs/PHASE-B-PREFLIGHT.md`: the saved 100-block
registry-subset sample contains swaps in 60 blocks (60%). At that sample rate,
block receipts alone imply 486M CU for the original full span or 145M CU for
14 days at 10 blocks/sec; the complete collector shape implies 1.65B / 493M CU.
These are density scenarios, not approved budgets or representative forecasts.
The retained sample was recounted without new RPC or DB calls. No backfill
was activated. Task 3 implementation is next. No full-history Phase B
activation is authorized by a merge.


## Operational update: 10:21 UTC - 22,439 pools and measured Phase B costs

At **10:18:50.334 UTC**, Luna verified v2 cursor **29,527,168**, exact indexed
pools **22,439**, factory images **19,038**, v2-source pools **22,138**, overlap
**0**, and `/ready` true. The cursor advanced 252,500 blocks since the prior
10:06:17.555 sample: **335.65 blocks/sec** over 752.779 seconds. Its saved hash
is `0xe507824afe1bf992e1cab4aa59669f61ec5f5df4c9c02602fcda1524d26ec4b2`,
indexed at 10:18:44.403 UTC. V1 remains unchanged, including its timestamp.
Phase A is incomplete and the v1/v2 overlap region is still ahead.

The same Railway deployment remains Active. Discovery committed 2,500 blocks
with 39 launches/38 images at 10:18:50, using 27 HTTP requests/170 logical calls.
Recent lag was 128 at 10:18:54; 136 of 157 observed swaps were unregistered.
Analytics was publishing. No classified throttle/error/identity conflict or
stop appeared in the inspected log window. Alchemy usage refreshed around
10:19 was **7,824,026 CU**, up 716,936 since the 10:06 observation, across all
workers. Its last-hour All errors filter returned no request logs around 10:21.

Token units through **ba86346** passed full CI **34955981383**. Sol's serving
increment is **f40f0fd**, cherry-picked with an identical tree as **e377eec** on
the real prerequisite chain and pushed to `phase-b-persistence`. It preserves
dated units across quiet ranges and existing published deep accounting on
direct pool links. Sol passed 76 database tests with zero skips and 10 actual
desktop/mobile page cases; Luna independently reviewed SQL/core boundaries
without finding an actionable defect. CI **34957093365** is running. No Phase B
code has been merged into main or deployed.

Read-only workload probes now establish that Phase B has substantial variable
cost beyond log requests: sampled 1,000-block windows had 661-870 distinct log
blocks, each requiring a header under the current evidence policy. See
[PHASE-B-PREFLIGHT.md](docs/PHASE-B-PREFLIGHT.md) for exact counts, per-sample
bounds and the successfully tested historical `eth_getBlockReceipts` capability.
The Phase A estimate is not a Phase B budget. Full historical Phase B cost and
storage remain unverified, and green CI alone does not authorize that workload.
No billing or provider configuration was changed.

Sol's next bounded assignment is optional, default-off block receipt collection
in `.pools-info-block-receipts`, based on e377eec, using mocks/local Postgres
only. It must produce the identical retained selected receipt evidence, preserve
all validation, bound HTTP response bytes/counts, and respect the method's
500-CU throughput weight. Root owns integration and live measurement. Luna is
available for bounded checks after completing the latest progress sample.
The 15-minute heartbeat remains active; the UI stash is unchanged.

## Operational update: 10:07 UTC - 17,752 pools, Phase B still isolated

Luna independently measured the public status API at these exact timestamps:

| Metric | 10:05:22.188 UTC | 10:06:17.555 UTC |
| --- | ---: | ---: |
| v2 cursor | 29,249,668 | 29,274,668 |
| indexed pools | 17,464 | 17,752 |
| factory images | 14,265 | 14,539 |
| pools with v2 evidence | 17,163 | 17,451 |
| v1/v2 overlap | 0 | 0 |

The interval is 25,000 blocks / 55.367 seconds, **451.5 blocks/sec**.
Images cover **81.90% of the current discovered set**, not a final fraction.
V1 remains 62,923,934 with its original hash and 07:26:44.328 UTC timestamp.
`/ready` returned HTTP 200 at 10:06:26 UTC. Phase A is still incomplete; the
overlap region above 62,625,935 has not yet been tested in production.

Railway deployment `246355c8-4a9f-49e9-a8ae-5006d78e96dd` remains Active.
At 10:06:35 a 2,500-block discovery batch added 41 pools and 40 images with
30 HTTP requests / 178 logical calls. The 1,000-block RPC log cap is unchanged.
Recent lag at 10:06:34 was **128 blocks**, the confirmation buffer; 191 of
228 observed swaps were still unregistered. Analytics was publishing alongside
it. No classified throttling, error, stop or identity conflict was present in
the inspected bounded deployment log window. Alchemy's last-hour All errors
filter returned no request logs around 10:04. Refreshed account-wide usage
around 10:06 was **7,107,090 CU**, versus 6,444,538 around 09:55 and 5,394,638
around 09:38. These totals include all workers, not just discovery.

The default-off broad worker at **649b985** passed full CI **34954298767**.
Dated token-unit evidence is now committed through **ba86346** and backed up
on `phase-b-persistence`; root passed `pnpm check` and **75 database tests,
zero skips**. CI **34955981383** is running. One failed expectation had omitted
migration 011 from the migration lifecycle test; it is fixed, and the previously
blocked lifecycle subtests now execute. Neither increment is merged or deployed.
Read-only Alchemy probes accepted canonical hash-pinned `decimals()` and
`totalSupply()` at blocks 63,566,573 and 38,994,681, with final header checks.
This verifies those samples and provider capability, not every historical token.

Sol is working in `.pools-info-broad-reads` on the existing pool-detail path.
Its full-history SQL aggregation fixture covers 21,001 canonical events while
bounding returned trades and candles. Six desktop/mobile page cases passed
before root found one further issue: requiring token units at the global scan
tip would blank inactive tokens after an unrelated range advances. Sol is
reproducing and fixing this using the latest surviving dated unit observation,
with its own block/hash/time disclosed separately from the market cutoff.
Missing or conflicting units stay unavailable; broad data never supplies PnL.
Final combined validation and commit are still pending. Luna has returned to
bounded checks and is reviewing only the new token-unit evidence increment.

The existing **15-minute heartbeat** remains active. Root retains production
changes and integration. Phase B activation remains gated on Phase A completion;
its historical request volume and total CU remain unmeasured. The UI stash
`f56d87fb7c83fcdf0bffbd1c16458ed7f3adee2f` remains untouched.

## Operational update: 09:40 UTC - launch-dense ranges, persistence CI passed

Independent Luna samples at 09:38:09.540 and 09:39:00.300 UTC measured:

| Metric | First sample | Second sample |
| --- | ---: | ---: |
| v2 cursor | 28,789,668 | 28,802,168 |
| indexed pools | 6,442 | 6,816 |
| factory images | 3,911 | 4,216 |
| pools with v2 evidence | 6,141 | 6,515 |
| v1/v2 overlap | 0 | 0 |

That is **246.3 blocks/sec** over 50.760 seconds, or **644.9 blocks/sec**
since the 09:25:53.024 sample. The count increased by 5,422 pools over that
longer interval. V1's cursor and timestamp remain unchanged; readiness is true.
The scan reached launch-dense history: at 09:32:53 it reduced atomic batches
from 5,000 to 2,500 blocks. At 09:38:22 a 2,500-block batch committed 77 launches
and 64 images with 43 HTTP requests / 321 logical calls. This is additional
launch evidence work, not evidence of throttling. No full-run ETA is asserted.

Railway remains Active. Recent lag at 09:38:29 was **128 blocks**; 282 of 330
observed swaps in that batch were still unregistered. The refreshed Alchemy
total around 09:38 was **5,394,638 CU**, up 848,010 since the 09:22 observation,
across all workers. Its last-hour All errors filter again returned no request
logs around 09:39. No source identity conflicts surfaced in inspected logs.

Persistence commit **23c9d34** passed full CI **34952527444**, including
**82 browser tests**, both container builds, and container migrate/status/API
smoke checks. It remains isolated on `phase-b-persistence`, not in production.
Sol is still finishing the disabled broad worker and its local tests. Its
logical method counters exclude transport retries and are not billed CU totals.
The collector's variable cost includes headers for every observed log block and
receipts for each distinct registered transaction; Phase B still needs measured
historical workload data. Preserve the current evidence validation when measuring.

## Operational update: 09:28 UTC - discovery advancing, Phase B prepared separately

At **09:25:53 UTC**, the production API reported **1,394 indexed pools**,
**601 factory images**, **1,093 pools with v2 evidence**, and v2 cursor
**28,294,668**. At 09:20:50 the cursor was 27,284,668: 1,010,000 blocks in
302.464 seconds, about **3,339 blocks/sec** for that interval. V1 remains
62,923,934, with zero v1/v2 source overlap so far. The overlap region above
62,625,935 has not been reached; its production reconciliation is still unproven.

Railway deployment `246355c8-4a9f-49e9-a8ae-5006d78e96dd` remains Active.
Recent logs at 09:22:44 showed **128 blocks of lag**, the configured confirmation
buffer. Most observed swaps were still unregistered (74 of 96 in that batch).
Alchemy showed **4,546,628 CU total** around 09:22, up 435,410 from the prior
4,111,218 observation. Its refreshed last-hour All errors filter returned no
request logs around 09:24. These are bounded observations, not a claim that
future requests cannot be throttled. All-worker usage remains combined.

Sol completed isolated Phase B persistence at **23c9d34**, backed up on GitHub
branch **phase-b-persistence**. It is **not merged into main or deployed**.
Root independently passed `pnpm check`, all **53 database tests with zero skips**,
and a 5,000-range discovery-dependency rewind fixture (2.7 seconds, no dangling
batches/manifests/cursor). CI **34952527444** is running for that branch.
The worktree is `/Users/eddyguo/Desktop/Work/Projects/.pools-info-phase-b`.

Sol's next active assignment in that same worktree is the **disabled-by-default
broad worker integration**, with local Postgres and mocked chain transport only.
Do not duplicate this assignment or activate Phase B before Phase A completes.
Luna finished a read-only API integration map; implementation must use Sol's
normalized broad schema, not Luna's alternative suggestion to reuse raw events.
Broad market statistics must never enter deep PnL or holder accounting.

The Phase A 7.8M CU estimate is not a Phase B estimate. Broad historical receipt
volume still needs measurement before making runtime or total-use claims.
Main production remains on Phase A; no competing writer or billing change.

## Operational update: 09:11 UTC - Phase A resumed with revised estimate approved

**The user approved resuming discovery with the corrected roughly 7.8M CU
estimate, plus ongoing recent/deep/analytics usage. The earlier budget gate is
cleared.** Railway `INDEXER_DISCOVERY_V2_ENABLED` is back to **1**. Active
indexer deployment `246355c8-4a9f-49e9-a8ae-5006d78e96dd` runs commit `b641930`.
The four other requested values remain 1000/1000/250/10.

Independent Luna samples at 09:09:41 and 09:10:46 showed v2 advancing
24,694,668 -> 24,964,668, about **4,183 blocks/sec** in a sparse interval.
The latter exact counts were **625 indexed pools**, **324 v2 pools** and
**192 factory images**. V1 stayed at **62,923,934**, timestamp 07:26:44.328 UTC.
The original 410 baseline was a blended recent/historical catalog count, not
this exact table count. Recent lag reached **3,837 blocks** at 09:09:46.

Alchemy's refreshed account-wide total at about 09:11 was **4,111,218 CU**,
versus 2,188,684 at initial startup. It includes all three workers. The earlier
2.4M estimate counted log queries only; the corrected model includes metadata
reads, receipts, headers and checkpoint checks. See `docs/PHASE-A-RUN.md`.
No retry loop was established. New code logs every detected 429 and stops all
workers cleanly after sustained throttling, without automatic failure restart.

The user requested Astra coordination with Sol/Luna workers. Reuse these tasks:

- Sol, `Verify Phase A discovery correctness`: `01a0a453-d8d3-71b1-bc60-0a0d86a4c31e`.
- Luna, `Verify Phase A progress metrics`: `01a0a454-161b-7931-bd37-68cebdf6186b`.

The existing heartbeat is now **Pools Info coordination**, active every
**15 minutes**, id `phase-a-discovery-progress`. It checks worker progress,
verifies evidence, and assigns bounded follow-ups. The coordinator retains
production changes and integration. Current priority remains Phase A completion,
then Phase B global swap persistence, then product work. No competing writer.

Commits `25a8dc4` and `b641930` are pushed and CI `34949572780` passed all checks.
The API exposes exact counts and the operational scheduling/stop changes are
live. UI work remains safely stashed at
`f56d87fb7c83fcdf0bffbd1c16458ed7f3adee2f`.

---

Freshest document in the repo. Read before `PLAN.md` / `HANDOFF.md` / `DESIGN-DELTA.md`.

---

## What changed tonight

**The RPC range limit is gone.** The user upgraded the existing Alchemy account to Pay As You Go. Verified:

```
scripts/check-rpc-range.ts →
{ "chainId": 4663, "requestedBlocks": 1000,
  "acceptsRequestedRange": true, "returnedLogs": 4 }
```

1,000-block `eth_getLogs` is accepted. The ceiling above 1,000 was not probed — 1,000 is sufficient and verified; tune upward later if worthwhile, but do not block on it.

### Why this was the whole blocker

`eth_getLogs` is billed at **60 CU per request, not per block.** So the range limit, not the quota, governed cost:

| Range | Requests for full scan | CU | % of 30M monthly |
|---|---|---|---|
| 10 (previous) | 4,052,859 | 243M | **810%** |
| **1,000 (now)** | **40,529** | **2.4M** | **8%** |
| 10,000 | 4,053 | 243K | 0.8% |

Scan range: block 22,754,669 (earliest verified deployment) → ~63,283,256 (head) = 40,528,587 blocks.
At 1,000-block ranges and 250ms pacing: **~2.8 hours**.

At the old 10-block limit the worker moved 10 blocks/second while the chain produced ~10 blocks/second — net progress toward any backfill was approximately zero. That is why nothing was ever going to work, regardless of code quality.

---

## Configuration

Five variables, set in **both** places:

```
INDEXER_LOG_RANGE_BLOCKS=1000
RECENT_LOG_RANGE_BLOCKS=1000
INDEXER_DISCOVERY_V2_ENABLED=1
RPC_MIN_INTERVAL_MS=250
RPC_MAX_BATCH_SIZE=10
```

- `.env.local` — **set** ✅
- Railway indexer service (`zestful-fulfillment` / Production / `d41596b3-6c74-4f96-a0fe-b6655c98ba95`) — **deploying as of 08:34 UTC**, needs confirmation

**`.env.local` only affects local runs.** The production worker reads Railway's environment. This distinction cost several hours tonight — the local file was set, the sweep didn't move, and the cause wasn't obvious. Verify the Railway side explicitly by checking that `discovered` log lines show a `from`/`to` gap of ~1,000 blocks rather than ~10.

Three workers share one Alchemy account. Start at 250ms and watch for 429s across historical, analytics **and** recent — not just the sweep.

**Known abort:** set `INDEXER_DISCOVERY_V2_ENABLED=0` and redeploy. v2 has its own cursor; stopping and resuming loses nothing.

---

## Baseline at 08:34 UTC — measure against these

```
catalogPools          410
processedPools        301
qualifyingTraders     315
recent lag            65,113 blocks / 6,614 seconds   (stale, and widening)
service               healthy, all 5 endpoints 200
PnL consistency       leaderboard == profile, exact match
```

Target: **~52,404 pools.**

That figure is the measured FeeSplitter ERC-721 balance at block 63241342 — i.e. locked LP positions, so instant launches, and only if crowd launches route positions to the same contract (unverified). **A materially different final count is a finding to report and explain, not automatically a bug.**

Rate check: 267 → 410 over roughly three hours is `discovery:v1` creeping at the chain tip. A real v2 historical sweep should add **thousands per hour**. If the count is rising by tens, the sweep is not running.

The recent lag *doubled* over the same period (33k → 65k blocks). With 1,000-block ranges it should close quickly. If it keeps widening after the Railway deploy, the variables did not apply.

---

## The failure pattern to avoid

Over three hours this evening, roughly 19 commits landed — token metadata, image proxy, theme tokens, search dedupe, watchlists, follows, trade PnL cards. All good work.

**Coverage did not move.** The range check went unrun for hours because it was framed as gating one workstream, so everything else proceeded around it.

**If something blocks the primary objective, report it as blocked and stop.** Routing to easier unblocked work produces a lot of commits and no progress on the goal. "Blocked" is a valid and wanted outcome; silent substitution is not.

Priority order is not negotiable tonight:

1. Confirm Railway env applied, sweep advancing
2. Phase A complete (~52,404 pools)
3. Phase B — global `Swap` sweep
4. Everything else

---

## Design context — already extracted, do not redo

`DESIGN-DELTA.md` holds the full analysis from the user's Claude Design export (`design/poolsinfo.html`). Structure, five-step text ramp, type scale, radii and implementation order are correct.

**Stale in that document:** the accent. It reads `#fc72ff` (pink); the user is switching to lime and will supply a fresh export. That is a single-token change — the design file uses `--ac: {{ accent }}` as a template variable, so nothing else in the theme needs revisiting.

Root cause already fixed: Tailwind v4 was imported with no `@theme` block, so all 566 classNames resolved to Tailwind's stock palette rather than the design tokens. `@theme static` is now in place and body type dropped 14px → 13px.

---

## Two-tier coverage — the reason it is split

Full-fidelity PnL needs manager `Swap` logs **and** per-token `Transfer` logs (transfers are how tokens acquired without a purchase are detected — the zero-cost-basis case). Swaps come from one address and sweep cheaply. Transfers are emitted by ~52,404 separate token contracts and **cannot be swept by address in one filter.**

- **Broad tier** — all pools, discovery + manager swaps, `supported: false` with an explicit flag. Serves screener, pool pages, price, volume, search, creators.
- **Deep tier** — existing per-pool streams with Transfer evidence, scheduled by liquidity rank. Serves verified PnL, holders, leaderboard.

No schema change; this maps onto the existing `supported` / `flags` columns. The per-pool machinery becomes the deep tier rather than being replaced — surface it as a feature on pool pages ("verified birth-contiguous history").

---

## Report in the morning

- Final `indexed_pools` count, and how it compares to 52,404
- What fraction carry an `image_url` from factory metadata — **if most tokens have no image, the generated fallback is the site's dominant visual identity and deserves real design rather than placeholder treatment**
- Whether the recent feed closed its lag once registry coverage improved (most of its "unregistered swaps" were pools discovery had never seen)
- Actual CU consumed vs the 2.4M estimate — materially above means something is retrying in a loop
- Any `pool_launch_sources` identity conflicts from the v1/v2 overlap above block 62625935. That reconciliation has only been exercised in tests; report conflicts rather than suppressing them

---

## Unchanged constraints

Do not: reset or mutate the `discovery:v1` cursor · add LBP/CCA addresses to the Instant decoder · invent synthetic buys for crowd launches without clearing-price evidence · prune raw evidence on a timer before a tested retention design · hotlink unvalidated token image URLs · use the Uniswap wordmark or put "Uniswap"/"Uni-" in any product or domain name.

Keep: integer-exact wei · the DB-enforced `realized_wei = eth_wei - disposed_cost_wei` identity · the supported/excluded XOR invariant · basis carried across window boundaries · `transaction_sender` is not the beneficiary · content-hashed batch evidence · reorg reconciliation · the writer lock.
