# Plan — full coverage of Pools launches

Target: all ~52,404 Pools launches (measured: FeeSplitter ERC-721 balance at block 63241342).
Current: ~267 catalog / ~236 processed. **0.5%.**

---

## The gate

One decision blocks everything. It is not an implementation problem.

| eth_getLogs range | Requests for full scan | CU @ 60/req | vs 30M free/month |
|---|---|---|---|
| **10 blocks (today)** | 4,052,859 | 243,171,540 | **810%** |
| 1,000 blocks | 40,529 | 2,431,740 | 8% |
| 10,000 blocks | 4,053 | 243,180 | **0.8%** |

Scan range = block 22,754,669 (earliest verified deployment) → ~63,283,256 (head) = 40,528,587 blocks.

**60 CU is charged per request, not per block.** So unlocking the range doesn't buy more quota — it collapses consumption by three orders of magnitude. The full historical scan becomes nearly free even against the free tier's CU budget.

**Action: upgrade the existing Alchemy account to Pay As You Go, then immediately verify:**

```sh
node --env-file-if-exists=.env.local --import tsx scripts/check-rpc-range.ts
```

Today it exits 2 with `advertisedBlockLimit: 10`. If it exits 0 after upgrading, the plan below is hours of work. If the range does *not* improve, fall back to QuickNode or Chainstack (both document 10k-block `eth_getLogs`), or integrate Envio HyperSync as a separate client — it is **not** a JSON-RPC URL and cannot be pasted into `INDEXER_LOG_RPC_URL`.

---

## Two tiers — this is the key design decision

Full-fidelity PnL needs **both** manager `Swap` logs *and* per-token `Transfer` logs (transfers are how you detect tokens acquired without a purchase — the zero-cost-basis case). Swaps come from one address and sweep cheaply. Transfers are emitted by 52,404 separate token contracts and **cannot** be swept by address in one filter.

So don't try to give all 52k pools full evidence. Split it:

| Tier | Scope | Evidence | Serves |
|---|---|---|---|
| **Broad** | **All ~52k pools** | Discovery + manager swaps | Screener, pool pages, price, volume, trade counts, search, creators |
| **Deep** | Top N by liquidity/volume | + Transfer evidence, holders | Verified PnL, leaderboard, wallet profiles |

This maps onto the schema you already have: deep-tier positions are `supported: true`; broad-tier ones carry `supported: false` with an explicit flag. **No schema change, no weakening of the evidence model.** The existing per-pool stream machinery becomes the deep tier.

Pick the cutoff by liquidity or volume — start around the top 1,000–2,000 pools and raise it as throughput allows. Most of the 52k are dead tokens nobody will open.

---

## Phases

### Phase A — discover all launches *(minutes of runtime)*
Sweep `TokenLaunched` across all 12 verified strategies, block 22,754,669 → head.
One topic, multiple addresses, ~4,053 requests at 10k range.
Needs a **versioned discovery stream** — `discovery:v1` started at 62625935 and only recognised 2 strategies, so its cursor cannot be reused. Add `discovery:v2` with its own durable cursor and start block; do not reset or mutate v1.
→ `indexed_pools` goes from ~267 to ~52,404.

### Phase B — broad swap coverage *(hours of runtime)*
One chronological sweep of PoolManager `Swap`, filtered in memory against the known poolId set. O(blocks), not O(pools × blocks).
Codex already built the pieces: `collectPoolEventGroup` and `commitPoolGroup`. They cap at 200 pools / 2,000 blocks — for whole-market this needs a single global range cursor rather than per-pool cursors that happen to align.
→ Every pool gets price, volume, trade counts.

### Phase C — deep tier *(ongoing)*
Existing per-pool streams, scheduled by liquidity rank rather than round-robin. Transfer evidence, holders, full cost basis.
→ Leaderboard and wallet PnL become market-wide for the pools that matter.

### Phase D — recent feed catch-up
Currently ~33k blocks / ~3,400s behind and not gaining. Most of the "unregistered swaps" (841 of 901 in one sampled batch) are pools not yet in the registry — Phase A largely fixes this by itself.

---

## Manual — you

1. **Upgrade Alchemy to PAYG** ← the gate
2. Run `check-rpc-range.ts`, confirm the new limit
3. Set in Railway: `INDEXER_LOG_RANGE_BLOCKS`, `RECENT_LOG_RANGE_BLOCKS`, `RPC_MIN_INTERVAL_MS`, `RPC_MAX_BATCH_SIZE` to the values Codex prepared — **only after** the range check passes
4. Decide the deep-tier cutoff (suggest: top 1,000 by liquidity)
5. Watch Railway volume size during Phase B; raw swap volume is the one thing that could need a storage bump

## Codex — everything else

- `discovery:v2` versioned rescan with durable cursor and overlap provenance
- Global range cursor + whole-market swap sweep wired to the existing group persistence
- Liquidity-ranked scheduling for the deep tier
- Broad-tier positions written as `supported: false` with an explicit flag
- Retention design for `indexed_events.payload` jsonb before Phase B lands
- `DESIGN-DELTA.md` — independent of all the above, can run in parallel

---

## Do not

- Reset or mutate the `discovery:v1` cursor
- Add LBP/CCA addresses to the Instant decoder
- Invent synthetic buys for crowd launches without clearing-price evidence
- Prune raw evidence on a timer before a tested retention design exists
- Apply the tuned pacing config while still on the 300 CU/s free account

---

## Order

**Upgrade → verify range → Phase A → Phase B → Phase C.**

Phase A alone takes you from 0.5% to 100% *discovery* coverage — the screener, search and creator pages all become market-wide before any swap work lands. That's the visible win, and it's minutes of runtime once the gate is open.
