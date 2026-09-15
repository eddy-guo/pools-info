# pools-info — Handoff

Code review of the existing repo, September 15 2026. Read this before changing anything.

**Verdict: the architecture is sound. Three specific blockers stop it reaching whole-chain coverage, and all three are fixable without discarding work.**

Companion docs (background, protocol mechanics, metric definitions) live in `../docs/` — `README.md`, `SPEC.md`, `BRIEF.md`, `PRIMER.md`, `BLUEPRINT.md`.

---

## Current state

Monorepo, ~20k lines, deployed on Railway (Postgres + 2 services).

```
packages/core     accounting, analytics, candles, holders, search, formatting
packages/chain    rpc, events, discovery, collector, pool-events, recent-events, ens
packages/db       migrations 001–004, client
apps/indexer      main.ts (discovery + per-pool streams), analytics-main, recent-main, service
apps/api          reader, live-read, analytics-read, catalog-read
apps/web          next.js — screener, pool, traders, wallet, creators, methodology, cards
```

Two parallel collection systems:

| System | Tables | Scope |
|---|---|---|
| **Indexed** | `indexer_streams`, `indexer_batches`, `indexed_pools`, `indexed_events` | Birth-contiguous per-pool history. Deep, verifiable, **O(pools × blocks)** |
| **Recent** | `recent_streams`, `recent_batches`, `recent_pools`, `recent_swaps` | Global sweep of a recent window. Shallow, **O(blocks)** |

---

## Blocker 1 — RPC throughput. This is the decisive one.

**File:** `apps/indexer/src/main.ts`, `rpc()`

```js
minIntervalMs: 1000,    // 1 request/second
maxBatchSize: 2,
logRangeBlocks: integer("INDEXER_LOG_RANGE_BLOCKS", 10, 1, 10000),
```

**10 blocks/request × 1 request/second = 10 blocks/second.**

At ~100ms block time the chain produces ~10 blocks/second. **The indexer runs at exactly chain speed — net progress toward a backfill is approximately zero.** If block time is actually 250ms you gain ~6 blocks/s, which still puts 58M blocks at ~110 days.

**The seam already exists** in the same function:

```js
process.env.INDEXER_LOG_RPC_URL
  ? withLogRpc(state, new Rpc(process.env.INDEXER_LOG_RPC_URL, {
      ...limits,
      logRangeBlocks: integer("INDEXER_LOG_RANGE_BLOCKS", 1000, 1, 10000),
    }))
  : state
```

1000 blocks/request → ~100× chain speed → full history in roughly **16 hours**.

### Fix
Point `INDEXER_LOG_RPC_URL` at one of:

1. **Envio HyperSync** — `https://robinhood.hypersync.xyz` (free, purpose-built for high-block-rate chains, and **returns transaction fields alongside logs**, which also removes the per-swap `tx.from` lookup)
2. A paid RPC tier with 10k-block `eth_getLogs` (Alchemy paid, Chainstack, dRPC)

Also revisit `minIntervalMs: 1000` — with a real provider that throttle is the binding constraint, not the range cap.

**Config change, not a rewrite. Do this first; everything else is downstream.**

---

## Blocker 2 — collection topology

**File:** `apps/indexer/src/main.ts`, `main()` loop

```js
const poolsPerCycle = integer("INDEXER_POOLS_PER_CYCLE", 2, 1, 20);
// ...
for (let i = 0; i < poolsPerCycle && !stopping; i++) {
  pool = await nextPool(db);
  await runBatch(db, pool, batch, pool.token);
}
```

Per-pool streams, rotated 2 per cycle on a 15s poll. With ~300k pools (see *Scale* below), touching each **once** takes ~26 days — and each pool then needs backfilling from its own launch block to head.

This model produces excellent birth-contiguous evidence for individual pools. **It will never cover the chain.**

### The scalable collector already exists

**File:** `apps/indexer/src/recent-worker.ts`, `prepareRecentCycleRpc()`

```js
const logs = await rpc.logs(
  [contracts.manager, ...contracts.strategies],
  [[swapTopic, launchTopic]],
  from, to,
);
```

One sweep, both event types, filtered by poolId in memory. **O(blocks), not O(pools × blocks).** It's simply scoped to a recent window.

### Fix
Promote this collector to a historical backfill with its own durable cursor, writing into aggregate tables. Keep per-pool streams as an **on-demand deep-dive** for a single pool (they're genuinely good for that), not as the path to coverage.

---

## Blocker 3 — coverage gap in the contract list

**File:** `packages/chain/src/events.ts`

```js
strategies: [
  "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
  "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
],
```

Only the two August `InstantLaunchStrategy` addresses. Missing:

| Missing | Address | Consequence |
|---|---|---|
| July launcher | `0x00004c4ccc709ef590f7c81102c0689f0263d4e9` | July-era pools invisible. **Uses `tickSpacing 60`, not 25** |
| July strategies | `0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2`, `0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491` | same |
| LBPStrategy (crowd) | `0x05d552391067389EE44fec3924157ed33F976000` | **All crowd launches invisible** |
| CCA factory | `0x000000001F26a0044BaA66024e7b6599c61963F8` | Auction phase invisible |

Note: the July addresses come from a third-party indexer's docs, not Uniswap directly — **verify on Blockscout before relying on them.** The August ones and LBPStrategy are from Uniswap's official deployments page.

Crowd launches also carry a correctness issue documented in `../docs/SPEC.md` §9: auction participants acquire tokens via `claimTokens()`, not a swap, so their cost basis is absent from swap data **permanently, even after graduation.** Flag them (`crowd_entry`) and hold them out of ranked PnL, or insert synthetic buys from the final clearing price.

---

## Scale — revised upward

Published figures (sources disagree ~2×, treat as order-of-magnitude):

- pools.trade day one: **10,506** launches (The Defiant) or ~6,000 (Entropy Advisors), Aug 5
- Cumulative by Aug 6 16:40 UTC: **23,248**
- Share of chain launches: **~40%**; chain-wide 16,000–22,600/day
- **Estimate today: ~250,000–350,000 tokens**

Implications:
- `pool` table ~300k rows — fine for Postgres, **too large to ship as JSON to a browser.** Screener must be server-paginated.
- Swaps plausibly **20–40M** — do not retain all raw rows. Fold into `position` / `daily_flow` and keep raw swaps on a rolling 7–14 day window.
- Holder crawling needs a high liquidity floor; even the top 1% is 3,000 pools.
- Most tokens are dead. Default the screener to a liquidity/volume floor.

**Verify directly** — one call, and it's the most direct proxy that exists (every instant launch locks an LP NFT at FeeSplitter):

```bash
cast call 0x58daec3116aae6D93017bAAea7749052E8a04fA7 \
  "balanceOf(address)(uint256)" \
  0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

Caveat: won't count un-graduated or refunded crowd auctions, and it's unverified whether crowd launches route positions to the same contract.

---

## Fix plan, in order

| # | Task | Est. |
|---|---|---|
| 1 | Measure real block time + swaps/hour (two `cast` calls) | 30 min |
| 2 | Point `INDEXER_LOG_RPC_URL` at HyperSync or paid RPC; retune `minIntervalMs` | 1–3 hr |
| 3 | Add missing launcher/strategy addresses; handle `tickSpacing 60` | 30 min |
| 4 | Promote the global sweep to historical backfill with durable cursor | 3–5 hr |
| 5 | `position` / `daily_flow` aggregate tables + recompute (check what `analytics.ts` already covers) | 3–4 hr |
| 6 | Search indexes on `indexed_pools` (trigram on name/symbol, prefix on token) + trader addresses | 1–2 hr |
| 7 | Backfill run | hours, unattended |

**Total ~1.5–2 days.** Nothing existing gets discarded.

---

## Do not change — these are correct and non-obvious

- **Reorg reconciliation** (`main.ts::reconcile`, `recent-worker.ts::reconcile`) — walks checkpoints back to a matching ancestor. Plus `head - 128` lag. Correct.
- **Writer lock** (`waitForWriter`) handling Railway's rolling-deploy container overlap. Most people ship this bug.
- **poolId recomputed from the PoolKey and verified** against the emitted id in `decodeLaunch` — rigorous, keep it.
- **`transaction_sender` commented as not the beneficiary** (migration 001). Trap 1 is understood; don't let anyone "simplify" this into a PnL join.
- **Evidence model** — content-hashed batches with FKs from events. More rigorous than typical.
- **Adaptive batch shrinking** (`recent-budget.ts`) on budget errors.
- **Honest coverage disclaimers** in schema comments.

---

## Search — scope decision

| Search | Do it? |
|---|---|
| Tokens by name/symbol/address | **Yes.** 300k rows, trigram + prefix index |
| Wallets by address prefix | **Yes.** Prefix index on hex text |
| Transactions by hash | **No.** Would need all ~30M tx hashes retained (~1.5GB) to answer worse than Blockscout. Detect a 66-char hash and redirect to `robinhoodchain.blockscout.com/tx/{hash}` |

You're building analytics, not an explorer. Punting tx search is correct.

---

## Unverified — check before relying on

1. **Real block time** — 100ms vs 250ms. Dominates every estimate here.
2. **July launcher + strategy addresses** — third-party sourced.
3. **Whether crowd launches route LP positions to `FeeSplitter`** — affects the pool-count proxy above.
4. **Actual swaps/hour** — determines retention window and storage.
5. **Whether `analytics.ts` (730 lines) already implements position/daily_flow aggregation** — read it before writing step 5.

---

## Two Railway services

Should be: **one web service** (the API — always-on, holds a Postgres pool) and **one worker** (the indexer — no HTTP, runs for hours without a request timeout).

If both currently serve HTTP, fix that before the backfill. A multi-hour backfill cannot live inside an HTTP handler.
