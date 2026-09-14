# Feature Map

What gets built, in what order, with the technology named for every piece — including the UI.

---

## Two pipelines, wildly different costs

Everything sits on one of two data tracks. They're **independent**, so you can ship the first while the second is still broken.

```
TRACK A · cheap                                    ~20 min of requests
  Initialize logs ──────────────► pool table ────► Screener
  + tx.from, block.ts             ~10k rows        Pool pages
                                                   (demoable on its own)

TRACK B · the expensive one
  Swap logs ──► the fold ──────► position ───────► Leaderboard
  millions      1 resolve trader  per wallet       Wallet pages
  of rows       2 dedupe legs     × token          PnL cards
                3 avg-cost accrual                 (all from one table)

SIDE INPUTS
  Blockscout ─ holders, every 30m ─────────────────► Pool pages
  labels.json ─ feeds the fold AND every surface ──► build this FIRST
```

**Track A is an afternoon; Track B is the project.** Pools number in the ten thousands, swaps in the millions — that asymmetry is the shape of the whole build.

---

## Tier 0 — the thing you send

Nine features, in build order. Nothing here is optional.

### 0. `labels.json` + exclusion denylist — 20 min
A hand-written map of `address → label`. Two jobs: name known traders, and tag protocol addresses so they never appear as people. Also the denylist the fold and every concentration metric read from.

- **Contains:** PoolManager, Universal Router, FeeSplitter, both launchers, all four strategies, CCA auctions, `0x0`
- **Tech:** a JSON file in the repo
- **Why first:** skip it and your top trader is a router — the most visible possible bug

### 1. Pool scan — Track A — ~1 hr
Scan `Initialize` from PoolManager (and `TokenLaunched` from both launchpads) across all history. Pull block timestamp and `tx.from`. One row per pool.

- **Data:** `eth_getLogs` · `eth_getBlockByNumber` · `eth_getTransactionByHash` · `eth_call` for name/symbol/decimals
- **Tech:** Node + TypeScript + **viem**, Alchemy free key
- **Note:** key on `poolId`, not token. Index both launchers — tickSpacing 25 and 60

### 2. Swap scan + the fold — Track B — 2–3 hr
The heart of it. Stream `Swap` logs, resolve each to a real wallet, fold into a running position per wallet-token pair. Discard each log after folding — storage is bounded by wallet-token pairs, not trade count.

- **Data:** `eth_getLogs`, or **Envio HyperSync** (`robinhood.hypersync.xyz`) which returns tx fields alongside logs
- **Traps:** router attribution · duplicate legs · v4 sign convention · non-18 decimals · excluded addresses. **Budget 20 min each**

### 3. Screener / landing — 1–1.5 hr
The Dexscreener half. Dense sortable table of every pool: price, FDV, liquidity, volume, trades, age, creator. Filter presets, URL-synced so a filtered view is shareable.

- **Tech:** **TanStack Table v8** for sort/filter, **TanStack Virtual** past a few hundred rows, **nuqs** for URL state
- **UI:** sticky header, row hover, tabular numerals, subscript-zero price notation

### 4. Pool profile pages — 1–1.5 hr
One statically generated page per pool. Creation facts, live price and liquidity, chart, holders, and **per-pool top traders — which is free**, because it's the position table with one extra `WHERE`.

- **Tech:** Next.js `generateStaticParams`, **lightweight-charts** (TradingView)
- **Shows:** mode badge (instant vs crowd), creator with ENS, raw *and* adjusted top-10 concentration

### 5. Leaderboard — 1 hr
The reason anyone shares the site. Rank by realized PnL in ETH with a USD toggle.

- **Columns:** rank · wallet · realized PnL · ROI · W/L record · trades · volume · avg hold · last trade
- **Tech:** TanStack Table — same component as the screener, different columns
- **Gates:** minimum 10 trades; anti-gaming filters exposed as toggles, not hidden

### 6. Wallet profile pages — 1 hr
A route for any address, whether or not it's ranked. Summary stats, positions held, trade history. **This page doesn't exist anywhere today.**

- **Route:** `/wallet/[address]` — pre-render the top few hundred, client-load the tail
- **Tech:** Next.js SSG + client fallback, **viem** `getEnsName` on mainnet, identicon for unnamed wallets

### 7. PnL share cards — 1 hr
An image per wallet served as that page's OG image. Post the link anywhere and it unfurls as a card showing rank, realized PnL, record, best trade. **Every user becomes a distribution channel.**

- **Route:** `/wallet/[address]/opengraph-image.tsx`
- **Tech:** **`next/og` ImageResponse** — JSX to PNG. Needs a self-hosted font file; no external CSS
- **Design:** 1200×630. Big signed PnL number, rank, W/L, wallet identity, wordmark. Legible at thumbnail size
- **Also:** a visible share button that copies the URL, plus a Twitter intent link

> **One constraint:** with `output: 'export'` dynamic OG generation won't run. Either deploy on Vercel without static export, or pre-generate cards for the top few hundred wallets at build time. **Decide before you start** — it's the one place the static choice actually costs you something.

### 8. Typed search — 1 hr
Your clearest visible win over theirs. One input, results grouped into labelled sections — Tokens, Wallets, Transactions — each row carrying enough context to pick.

- **Tech:** **fuse.js** over a shipped JSON index for names; plain prefix matching for addresses; **cmdk** for the palette UI
- **Handles:** token name/symbol · partial address · full address · 66-char tx hash · `name.eth`
- **Size:** keep the client index to names + addresses only, under ~2 MB gzipped

---

## How the surfaces connect

The cross-linking is the product. Four pages that each dead-end is a report; four that loop into each other is something people browse.

```
Screener ──pick a pool──► Pool page ◄─────────────┐
                              │                    │
                     who traded this pool    what else they hold
                              ▼                    │
Leaderboard ──pick a trader──► Wallet page ────────┘
                                   │
                                shares
                                   ▼
                              PnL card ──► posted to social
                                   └──new visitors arrive here──► Wallet page
```

Both directions of the pool ↔ wallet pair come from the same position table, so they cost nothing extra once the fold works. **Build the links as you build each page**, not as a pass at the end — they're the difference between a dashboard and a toy. The share card is the only arrow that points outward and comes back.

---

## Tier 1 — what's missing from the original scope

Each is under an hour, and collectively they're the difference between "weekend project" and "product."

| Feature | Why it matters | Tech | Time |
|---|---|---|---|
| **Timeframe tabs** 24h/7d/30d/all | Table stakes — every competitor has them. Also how you ship a 7-day board without it reading as incomplete: grey out "All" as coming soon | Precompute one aggregate per window | 20 min |
| **Freshness stamp** | You're serving a cache. "Updated 14m ago" turns a weakness into a trust signal; hiding it gets you called out | `date-fns` from a build timestamp | 10 min |
| **Live trade feed** | The texture that makes it feel alive, and the FOMO surface. Free once swaps are indexed | `recent-trades.json`, client poll 10s | 30 min |
| **Methodology page** | Nobody in this space publishes their PnL formula. To protocol engineers this is the most senior thing on the site | One static page | 20 min |
| **Adjusted concentration** | PoolManager holds most of every token's supply. Raw top-10 is meaningless; showing both proves you know where v4 liquidity lives | Holder list minus denylist | 20 min |
| **Skeleton + empty states** | The biggest tell of an unfinished project. A wallet with no trades needs a designed answer, not a blank table | shadcn `Skeleton`; write real empty copy | 30 min |
| **Mobile layout** | Screeners get opened on phones constantly. Collapse rows into stacked cards rather than horizontal scroll | Tailwind breakpoints | 45 min |
| **Dark mode default** | pools.xyz is near-black `#131313`. A light-only trading dashboard looks out of place | Tailwind `dark:` + CSS variables | 20 min |
| **Number formatting** | Memecoin prices look like `0.0000000124`. Getting this right is a real craft signal | One shared formatter module | 30 min |

---

## UI details that carry credibility

You said UI is your easy part, so this is just the domain conventions — what a trading dashboard is judged on that a generic dashboard isn't.

**Numbers**
- **Subscript-zero notation for tiny prices.** `0.0000000124` → `0.0₈124`. Dexscreener, GMGN and Photon all do this; without it every price column is an unreadable smear of zeros. **Highest-ratio detail on the list.**
- `font-variant-numeric: tabular-nums` on every numeric column, so digits align and columns stop jittering on update.
- **PnL always signed and coloured** — `+2.41 ETH` green, `−0.88 ETH` red, never a bare number. Keep semantic green/red separate from your brand accent.
- Abbreviate magnitudes (`$1.2M`, `4.3K`) but show full precision on hover.
- **ETH primary, USD secondary.** Your accounting is native in ETH; a toggle is honest, a silent conversion isn't.

**Identity**
- Truncate as `0x8f3a…b21c` — both ends, never just the prefix; prefixes collide visually.
- A deterministic identicon per address so unnamed rows stay distinguishable.
- Copy button and explorer link on every address, everywhere. Trivially cheap, immediately noticed when missing.
- Label chips visually distinct from ENS names, so nobody confuses your annotation with an on-chain fact.

**Tables**
- Sticky header, dense rows (~36–40px), hover highlight, entire row clickable.
- Sort state in the URL so a sorted view is shareable.
- Rank column pinned left; highlight the connected wallet's row and pin it into view if off-screen.

**Virtualize vs paginate**
- **Screener** (thousands of pools) → TanStack Virtual. Continuous scroll is right for browsing.
- **Leaderboard** → paginate, top 100 per page. Nobody scrolls to rank 4,000, and pagination gives clean shareable URLs.

---

## Stack summary

**Frontend:** Next.js 15 App Router · TypeScript · Tailwind · shadcn/ui · TanStack Table + Virtual · lightweight-charts · cmdk · nuqs · fuse.js · date-fns · `next/og`

**Pipeline:** Node + TypeScript · viem · Envio HyperSync (optional) · SQLite during the run · JSON output

**Ops:** GitHub Actions cron every 30 min · Vercel · Blockscout REST · Chainlink for ETH/USD · one Ethereum mainnet RPC for ENS

---

## Tier 2 — only if Saturday goes well

Ranked by signal to the audience, not by effort. **Pick at most one.**

**1. CCA auction explorer**
Chart the clearing-price path block by block across a crowd launch. Bid ladder at each price tick, release schedule, fill rates, oversubscription, partial fills, refund outcomes for failed auctions.
*Why it lands:* the CCA is Uniswap's own novel mechanism — they published research and a dedicated site for it. **Nobody has visualized one.** Every competitor is doing commodity memecoin PnL. This says you read their contracts, not their marketing.

**2. Crowd vs Instant: does TWAP bidding actually reduce sniping?**
Empirical comparison across both modes: sniper share of supply in the first N blocks, bundler cluster counts, 24h holder retention, price drawdown from peak, share of launches that round-trip to zero.
*Why it lands:* Uniswap's blog *asserts* that TWAP bids mitigate bundling. Nobody has tested it. Arriving with a measured answer to a claim the company makes about its own product is a systems-design conversation you get to lead.

**3. Locked-liquidity floor tracker**
LP fees autocompound into a position that can never be withdrawn, so every pool has a liquidity floor that only rises. Chart ETH accrued per day, implied fee APR on locked liquidity, cumulative value permanently locked.
*Why it lands:* economically unique to pools.trade and completely unindexed. Reframes memecoin launches as a protocol-owned-liquidity story — which is the flattering framing, and it's true.

**4. Creator fee-rights secondary market**
The 0.05% creator fee claim is a transferable ERC-721. Track transfers, the fee stream each has earned, implied valuations at sale.
*Why it lands:* a novel asset class hiding in their own periphery contracts that nobody has noticed.

**5. Honest concentration and risk scoring**
Raw top-10, adjusted top-10 excluding protocol addresses, Gini, and a transparent 0–100 risk score with every input shown.
*Why it lands:* robinscan already does this, so it's table stakes — but getting the exclusion right proves you understand where v4 liquidity lives, and getting it wrong makes every number absurd.

**6. Creator pages / launch-quality score**
Track record per creator: launches, median outcome, repeat-rug detection, whether they opted into creator fees, whether they bought their own launch.
*Why it lands:* directly actionable, and the data is free once launches are indexed.

**7. Public JSON API**
Expose indexed pools, trades and leaderboard as documented endpoints. Hoodpools ships raw JSON and it's part of why it reads as infrastructure.
*Why it lands:* positions the project as something Uniswap could absorb or point at, rather than a page.

> **The discipline that matters most:** seven shallow features read as generated. Tier 0 done properly plus *one* Tier 2 item executed fully reads as a person with judgment. Say in the README which items you cut and why — deliberate omissions are evidence of taste; silent ones look like running out of time.

---

*Independent analysis, not affiliated with or endorsed by Uniswap Labs.*
