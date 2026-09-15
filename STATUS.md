# Status — 15 Sep 2026, 08:40 UTC

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
