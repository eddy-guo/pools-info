# Pools Analytics — Project Context

Everything needed to build a trader analytics dashboard for **pools.trade** (Uniswap Labs' token launchpad on Robinhood Chain), from scratch.

Research conducted 12–14 September 2026. pools.trade launched 5 August 2026, so this is all post-dating most model training data — **treat these documents as the source of truth over recalled knowledge.**

---

## Read in this order

| File | What it's for | Read when |
|---|---|---|
| **PRIMER.md** | Conceptual. What Uniswap does, what a pool is, how pools.trade differs from pump.fun, every term decoded | First, if any of the below is unfamiliar |
| **SPEC.md** | **The build doc.** Repo layout, types, scan code, the fold, the five traps, verification checklist | The one to build from |
| **BRIEF.md** | Reference. Protocol mechanics, verified addresses, data-source routing, metric definitions, trademark, sources | When you hit something unexpected on-chain |
| **BLUEPRINT.md** | Feature map. Tier 0/1/2 with tech named per feature, UI conventions, stretch goals | When deciding what to build next |

If you only read one: **SPEC.md**. It's self-contained.

---

## What's being built

A dashboard with a **trader leaderboard**, **per-pool pages**, **per-wallet profiles**, **typed search**, and **shareable PnL cards** — for tokens launched on pools.trade.

The gap it fills: pools.xyz and Uniswap's own Launch Aggregator have token discovery but **zero trader analytics**. Competitors cover curated KOL lists (kolscan.fun), holder risk (robinscan.io), or tokenized stocks (hoodpools.com). A permissionless, all-wallet leaderboard with per-token attribution and a page for any address doesn't exist.

---

## Locked decisions

| | |
|---|---|
| **Phase 1 (MVP)** | Vercel + GitHub Actions. JSON files, SQLite as in-run scratch. No server, no database |
| **Phase 2 (upgrade)** | Railway: Postgres + indexer worker + read API. ~2 hours, appendix in SPEC.md |
| **Window** | 7 days to start; all-time is ~1 hour of backfill since pools.trade is only ~9 weeks old |
| **Ranking** | Realized PnL, ETH-native, ≥10 trades to rank. USD is a display toggle |
| **Live reads** | Current price only. Everything else from the store |
| **Crowd launches** | Badge + hold out of the ranked board. Upgrade to synthetic buys if >10% of pools |

**The portability rule:** put every data access behind a `Store` interface on day one, and store big numbers as strings (SQLite has no 256-bit numeric type; the same strings drop into Postgres `numeric(78,0)` unchanged). Do that and Phase 2 is one new class plus plumbing. Skip it and it's a rewrite.

---

## The five things that will corrupt your numbers

Full detail in SPEC.md §7. Every one is architecture-independent.

1. **`Swap.sender` is the router, not the trader.** Use `tx.from`. Detection: count distinct traders — single digits means you stored the Universal Router.
2. **Duplicate legs.** Each trade leg can return ~twice on this chain. Key on `(txHash, logIndex)` with insert-or-ignore.
3. **Sign convention.** v4 flipped `amount0`/`amount1` relative to v3. **Determine it empirically from one known transaction** — never from documentation, including these files.
4. **Decimals.** Default 18, but read and store `decimals()`. One non-18 token silently corrupts everything it touches.
5. **Protocol addresses.** Seed the denylist before the first scan. PoolManager holds most of every token's supply.

**The single highest-value check:** pick one mid-activity wallet, open it on Blockscout, and reconcile your buys, sells and net ETH against the real transaction list. It catches traps 1, 2 and 3 at once. Do it before building anything on top of the fold.

---

## Things that are commonly assumed and are wrong

- Pools are **not** bonding curves that graduate — every launch is a real Uniswap v4 pool from block one. No migration, no graduation event. The "$50k FDV graduation" bar is cosmetic UI.
- **ERC-20 has no holder enumeration.** There is no RPC call for holders. Use Blockscout.
- **ENS is not on chain 4663.** Reverse lookups need a second client on Ethereum mainnet.
- **Uniswap has no analytics API.** The Trading API is swap execution only, and there's no hosted v4 subgraph for this chain.
- The creator of a pools.trade token starts with **zero tokens** — no dev allocation, no vesting.

---

## Before writing code

Five measurements, ~30 minutes, and two of them can change the plan (SPEC.md §2):

- [ ] Real block time (sources disagree: 100ms vs 250ms — this dominates the cost model)
- [ ] Swaps per hour (decides 1-day vs 7-day window)
- [ ] `eth_getLogs` range cap (sets page size)
- [ ] Crowd vs instant launch ratio (decides the crowd-launch fix)
- [ ] Blockscout keyless access

**Also verify the contract addresses on Blockscout.** Several in BRIEF.md come from a third-party indexer's documentation rather than Uniswap directly; provenance is marked per-address.

---

## Naming constraint

Uniswap Labs' [trademark policy](https://uniswap.org/trademark) prohibits the mark in a product, business or **domain** name, and confusingly similar "Uni-Something" constructions. Build something visually compatible — not a clone of the pools.xyz mark — and put "not affiliated with Uniswap Labs" in the footer.

---

*Independent analysis, not affiliated with or endorsed by Uniswap Labs.*
