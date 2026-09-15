# Status - 15 Sep 2026, 10:21 UTC

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
