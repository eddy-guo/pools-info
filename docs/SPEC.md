# Pools MVP — Build Spec

A trader analytics dashboard for **pools.trade** (Uniswap Labs' token launchpad on Robinhood Chain).
Stack: Vercel + GitHub Actions. No server, no database. Railway upgrade path in the appendix.

---

## 0. Context — what pools.trade actually is

Read this first; several obvious-seeming assumptions are wrong.

- pools.trade is a front end over two public Uniswap repos: [`liquidity-launcher`](https://github.com/Uniswap/liquidity-launcher) and [`continuous-clearing-auction`](https://github.com/Uniswap/continuous-clearing-auction). The source is the documentation.
- **Every launch mints a real Uniswap v4 pool in the same transaction as the token.** No bonding-curve contract, no migration, no graduation event. The "graduation progress" bar in their UI is cosmetic — nothing happens on-chain at $50k FDV.
- Every pool is: native ETH as `currency0`, the token as `currency1`, fee `2500` (= 0.25%, pips not bps), no hooks, 1,000,000,000 supply, 18 decimals.
- The entire supply goes in as **one single-sided, token-only position** spanning `[-160100, initialTick]`, with spot at the upper bound. At t=0 the pool holds 1B tokens and zero ETH.
- **The creator starts with zero tokens.** No dev allocation, no vesting. "Dev holding %" is structurally zero.
- Liquidity is locked permanently — the LP NFT goes to a singleton `FeeSplitter` with no withdrawal function. LP fees autocompound back into the locked position.
- **Every token's largest holder is the v4 PoolManager**, because all liquidity lives in the singleton. Raw top-10 concentration is meaningless without excluding it.
- Two launch modes: **instant** (pool opens immediately) and **crowd** (a ~4h continuous clearing auction runs first, then a pool is built at the final clearing price; if it doesn't raise enough, everyone is refunded and no pool ever exists).

### Chain constraints that change the architecture

- Robinhood Chain is an Arbitrum Orbit L2, chain ID **4663**, ~100ms blocks (**verify** — sources disagree between 100ms and 250ms).
- Sequencer is first-come-first-served, not priority-fee. Don't build gas-war analytics; "same block" is a weak clustering signal.
- `block.number` inside a contract returns an estimated **L1** block number. JSON-RPC returns L2 height. Block timestamps are not strictly increasing — never use timestamp as a unique key.
- Three-stage finality. Soft-confirmed blocks can be reordered by the sequencer before being batched to L1.
- **ENS is not deployed on 4663.** Reverse lookups require a second client pointed at Ethereum mainnet.

---

## 1. Order of work, and where to cut

| Budget | What ships |
|---|---|
| **~3 hr (floor)** | Measure → pool scan → screener + pool pages → **deploy** → 24h leaderboard from one day of swaps. Cut cards, search, wallet pages, holders. |
| **~8 hr (full MVP)** | Add 7-day window, wallet pages, PnL cards, typed search, holders, methodology page, README. |
| **+2 hr** | Railway: Postgres, all-time, any address. See appendix. |

**Build sequence**

1. Measure (§2) — 30 min, two results can change the plan
2. Scaffold — repo, types, `Store` interface, seed `labels.json` (§3–4)
3. Pool scan (§5) → screener + pool pages → **deploy immediately**
4. Swap scan, **one day only** (§6) — small window so you iterate fast
5. The fold (§8) → **reconcile one wallet by hand** (§11) ← the checkpoint everything depends on
6. Leaderboard → wallet pages → cards → search
7. Widen to 7 days, methodology page, README

> **The rule that protects you:** step 3 is independently deployable and has nothing to do with the swap fold. Get a live URL early so that if the fold is still misbehaving at midnight, you still have something to send.

---

## 2. Measure before you build

- [ ] **Block time.** Two blocks 10,000 apart, diff timestamps. Sizes every scan.
- [ ] **Swaps per hour.** Scan one hour of `Swap` logs from PoolManager, count those in pools.trade pools. Decides 1-day vs 7-day window.
- [ ] **`eth_getLogs` caps.** Binary-search the block range until it errors. Sets `PAGE`.
- [ ] **Crowd vs instant ratio.** Count launches by strategy address. If crowd >10%, do the synthetic-buy fix (§9).
- [ ] **Blockscout keyless.** `GET https://robinhoodchain.blockscout.com/api/v2/stats`. If 403, use `api.blockscout.com/4663/api/v2/…` with a free key.

### Constants

```
CHAIN_ID       4663
RPC            https://robinhood-mainnet.g.alchemy.com/v2/<key>
POOL_MANAGER   0x8366a39CC670B4001A1121B8F6A443A643e40951
STATE_VIEW     0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
POSITION_MGR   0x58daec3116aae6D93017bAAea7749052E8a04fA7
UNIVERSAL_RTR  0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99
LAUNCHER_V2    0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0   // Aug, tickSpacing 25
LAUNCHER_V1    0x00004c4ccc709ef590f7c81102c0689f0263d4e9   // Jul, tickSpacing 60
TOKEN_FACTORY  0x000000e200088D55C39a11F609E5F667729ad49b
FEE_SPLITTER   0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf
CCA_FACTORY    0x000000001F26a0044BaA66024e7b6599c61963F8
LP_FEE         2500        // pips = 0.25%
SUPPLY         1_000_000_000e18
```

Verify on Blockscout before trusting — several come from a third-party indexer's docs, not Uniswap directly.

---

## 3. Repo and stack

```
pools-dash/
├─ packages/
│  └─ core/                  // shared by indexer AND web — this is the point
│     ├─ types.ts            // Pool, Swap, Position, LbRow
│     ├─ store.ts            // Store interface
│     ├─ json-store.ts       // MVP impl (sqlite scratch + json out)
│     ├─ fold.ts             // the PnL accounting — pure, testable
│     ├─ price.ts            // sqrtPriceX96 → eth, formatters
│     └─ labels.json         // protocol denylist. seed FIRST
├─ indexer/
│  ├─ scan-pools.ts
│  ├─ scan-swaps.ts
│  ├─ enrich.ts              // holders, ens, eth/usd
│  ├─ emit.ts                // write + upload JSON
│  └─ main.ts
├─ web/                      // next.js app router
└─ .github/workflows/refresh.yml
```

**Dependencies**

```
# indexer
viem  better-sqlite3  p-limit  tsx  @aws-sdk/client-s3   // or @vercel/blob

# web
next  react  @tanstack/react-table  @tanstack/react-virtual
lightweight-charts  cmdk  nuqs  fuse.js  date-fns  tailwindcss
```

**Env**

```
RPC_URL             # alchemy, chain 4663 — GitHub secret, NEVER client-side
MAINNET_RPC_URL     # any ethereum mainnet rpc, for ENS only
BLOCKSCOUT_BASE     # https://robinhoodchain.blockscout.com
R2_* / BLOB_TOKEN   # wherever the JSON lands
```

`packages/core` is imported by both the indexer and the web app so types and formatters can't drift. It's also what makes the Railway upgrade a one-file change — `fold.ts` and `types.ts` move over untouched.

---

## 4. Types and the Store interface

Write this first. It's the seam that makes the upgrade cheap.

```ts
type Hex = `0x${string}`

// Big numbers are STRINGS at rest, BigInt in memory.
// SQLite has no 256-bit numeric type and JSON has no BigInt — this
// convention is portable to Postgres numeric(78,0) with no code change.
interface Pool {
  poolId: Hex; token: Hex
  name: string; symbol: string; decimals: number
  mode: 'instant' | 'crowd'
  tickSpacing: number; launcher: Hex
  creator: Hex; createdBlock: number; createdTs: number; createdTx: Hex
}

interface Swap {
  txHash: Hex; logIndex: number; poolId: Hex
  block: number; ts: number; trader: Hex
  ethDelta: string; tokenDelta: string; sqrtPrice: string   // signed
}

interface Position {
  trader: Hex; poolId: Hex
  qty: string; costEth: string; realizedEth: string
  ethIn: string; ethOut: string
  buys: number; sells: number
  firstBlock: number; lastBlock: number
  flags: string[]
}
```

```ts
interface Store {
  // raw writes
  upsertPools(rows: Pool[]): Promise<void>
  upsertSwaps(rows: Swap[]): Promise<void>
  upsertHolders(poolId: Hex, rows: Holder[]): Promise<void>

  // scan state
  getCursor(s: 'pools'|'swaps'): Promise<number>
  setCursor(s: 'pools'|'swaps', block: number): Promise<void>
  getPoolIds(): Promise<Set<Hex>>
  getExcluded(): Promise<Set<Hex>>

  // derived
  recompute(): Promise<void>

  // reads — SAME SHAPES in MVP and Railway
  pools(q: PoolQuery): Promise<PoolRow[]>
  pool(id: Hex): Promise<PoolDetail>
  leaderboard(w: Window, page: number): Promise<LbRow[]>
  wallet(a: Hex): Promise<WalletDetail>
}
```

> **One hard rule:** no React component ever fetches a JSON file directly. Everything goes through `Store`. Break this and the Railway upgrade means editing twenty files instead of one.

### Seed labels.json before the first scan

```json
{
  "0x8366a39cc670b4001a1121b8f6a443a643e40951": { "label": "v4 PoolManager",   "kind": "protocol" },
  "0x06afba43fd06227fa663b0daecf536f6eaa6bf99": { "label": "Universal Router", "kind": "router"   },
  "0xeff166aaf189323c58dc27ed1206eb2c37faacdf": { "label": "FeeSplitter",      "kind": "protocol" }
}
```

Plus both launchers, all strategies, the CCA factory, the token factory, and `0x0`. Lowercase every key and compare lowercased. Read by the fold (exclusion), the leaderboard (never show a router), and holder concentration.

---

## 5. Pool scan

~10k pools, a few hundred batched requests, minutes. Independently deployable — ship it before anything else.

Let viem derive topic hashes from signatures so a typo fails loudly instead of silently matching nothing.

```
'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'
'TokenLaunched(bytes32,address,address,(address,address,uint24,int24,address))'
'TokenCreated(address,(string,string,string,bytes))'
'AuctionCreated(address,address,uint256,bytes)'
```

```ts
const limit = pLimit(8)              // concurrency. tune to your rate limit.

for (range of pages(await store.getCursor('pools'), tip, PAGE)) {
  const inits = await retry(() => client.getLogs({
    address: POOL_MANAGER, event: Initialize, ...range }))

  // narrow to the pools.trade shape
  const cands = inits.filter(l =>
    l.args.currency0 === zeroAddress &&
    l.args.fee === 2500 &&
    l.args.hooks === zeroAddress)
  if (!cands.length) { await store.setCursor('pools', range.to); continue }

  // confirm + classify from the SAME tx:
  //   TokenLaunched from LAUNCHER_V1/V2 → it IS pools.trade
  //   AuctionCreated for that token     → mode 'crowd', else 'instant'
  const launches = await client.getLogs({
    address: [LAUNCHER_V1, LAUNCHER_V2], event: TokenLaunched, ...range })

  // BATCH. never loop one-at-a-time — that's the difference
  // between minutes and hours.
  const txs  = await batchGetTx(uniq(cands.map(c => c.transactionHash)))
  const blks = await batchGetBlock(uniq(cands.map(c => c.blockNumber)))
  const meta = await client.getLogs({
    address: TOKEN_FACTORY, event: TokenCreated, ...range })
  const decs = await multicall(cands.map(c => ({
    address: c.args.currency1, abi: erc20, functionName: 'decimals' })))

  await store.upsertPools(rows)      // creator = tx.from
  await store.setCursor('pools', range.to)
}
```

**Don't skip the confirmation step.** Robinhood Chain has other v4 pools (PancakeSwap, RobinSwap, hand-made ones). The `currency0=ETH, fee=2500, hooks=0` filter narrows cheaply but isn't exclusive to pools.trade. The `TokenLaunched` cross-check in the same transaction is what makes it definitive.

**Key on `poolId`, not token address.** The July launcher used `tickSpacing 60` and the August one uses `25` — different pool ids for the same parameters. Let `token → pools` be one-to-many.

---

## 6. Swap scan

One chronological sweep. Raw rows only — no accounting here.

```ts
const poolIds  = await store.getPoolIds()      // ~10k, in memory
const excluded = await store.getExcluded()

for (range of pages(await store.getCursor('swaps'), tip - REORG_LAG, PAGE)) {
  const logs = await retry(() => client.getLogs({
    address: POOL_MANAGER, event: Swap, ...range }))

  // only our pools — in memory, free
  const mine = logs.filter(l => poolIds.has(l.args.id))
  if (!mine.length) { await store.setCursor('swaps', range.to); continue }

  // TRAP 1 — trader is tx.from. dedupe hashes first:
  // one tx often emits several swaps.
  const from = await batchGetTxFrom(uniq(mine.map(l => l.transactionHash)))
  const ts   = await batchGetBlockTs(uniq(mine.map(l => l.blockNumber)))

  const rows = mine.map(l => ({
    txHash: l.transactionHash, logIndex: l.logIndex, poolId: l.args.id,
    block: Number(l.blockNumber), ts: ts[l.blockNumber],
    trader: from[l.transactionHash].toLowerCase(),
    ethDelta:   l.args.amount0.toString(),
    tokenDelta: l.args.amount1.toString(),
    sqrtPrice:  l.args.sqrtPriceX96.toString(),
  })).filter(r => !excluded.has(r.trader))         // TRAP 5

  await store.upsertSwaps(rows)                    // TRAP 2 — idempotent
  await store.setCursor('swaps', range.to)
}
```

**Retry with backoff on every RPC call.** You will hit rate limits mid-scan, and a scan that dies at minute 30 without resuming is the worst failure mode in this build. The cursor makes resume free — use it.

**Reorg lag:** scan to `tip − REORG_LAG`, not the tip. The sequencer can reorder soft-confirmed blocks before they're batched to L1. Re-scan the last few minutes each run; idempotent upserts make that free.

### Why v4's singleton matters here

There are no per-pool contract addresses. Every pool's events come from one `PoolManager`, so:

1. You cannot filter by `address` to isolate a pool — filter on `topics[1]`, the pool id.
2. `Initialize` is the **only** event carrying the PoolKey. `Swap` carries an opaque `poolId` only. Index `Initialize` to completion before swaps, or swap logs are undecodable.
3. One chronological sweep gets all 10k pools at once. Never loop over pools making a query each.

---

## 7. The five traps

Architecture-independent, and the reason this is an afternoon and not twenty minutes.

### Trap 1 — `Swap.sender` is the router, not the trader
Use `tx.from`. Dedupe transaction hashes before fetching.
**Detection:** count distinct traders. Single digits means you stored the Universal Router.

### Trap 2 — Duplicate legs
Each leg can return roughly twice on this chain. Key on `(txHash, logIndex)` with insert-or-ignore — that makes the whole scan idempotent, so duplicates and re-runs are equally harmless.
**Detection:** your volume is almost exactly 2× a Dexscreener cross-check.

### Trap 3 — Sign convention: determine it empirically
v4 flipped the `amount0`/`amount1` convention relative to v3. Backwards means every buy and sell on your site is inverted. **Don't trust any blog post, including this spec.**

Open one known swap on Blockscout, see which way tokens actually moved, pin the classifier, then assert the invariant on every row:

```ts
assert(sign(ethDelta) !== sign(tokenDelta))    // always true
const side = tokenDelta > 0n ? 'buy' : 'sell'  // ← VERIFY THIS LINE FIRST
```

### Trap 4 — Decimals
pools.trade mints 18-decimal tokens, so 18 is a safe default — read `decimals()` and store it anyway. One non-18 token silently corrupts every figure it touches and inspection won't find it.

### Trap 5 — Protocol addresses
Filter traders against `labels.json` at insert. Separately exclude the same set from holder concentration — PoolManager holds most of every token's supply.

---

## 8. The fold

Thirty lines. Pure function, no I/O — unit-test it against a hand-made fixture before pointing it at real data.

```ts
// packages/core/fold.ts — pure, testable, moves to Railway untouched
export function fold(swaps: Swap[]): Position {
  let qty = 0n, cost = 0n, realized = 0n
  const flags = new Set<string>()

  for (const s of swaps) {              // MUST be ordered block, then logIndex
    const eth = BigInt(s.ethDelta), tok = BigInt(s.tokenDelta)

    if (isBuy(tok)) {
      qty  += abs(tok)
      cost += abs(eth)
    } else {
      if (qty === 0n) { flags.add('phantom_sell'); continue }  // flag, never guess
      const sold  = min(abs(tok), qty)
      const basis = cost * sold / qty
      realized += abs(eth) - basis
      qty  -= sold
      cost -= basis
    }
  }
  return { qty, costEth: cost, realizedEth: realized, flags: [...flags] }
}
// unrealized = qty * markPrice − cost   (mark from StateView, §10)
```

### A decision to make consciously

**Average-cost accounting is path-dependent and does not compose across rolling windows.** You can't subtract day 8 from a 7-day average-cost basis.

- **All-time board** → `position.realizedEth`, rigorous average cost.
- **Windowed boards** → sums of daily net ETH flow (`ethOut − ethIn`). Composable, and exactly what Dexscreener ships.

Label them differently in the UI — "Realized PnL" vs "Net ETH" — and explain it on the methodology page. That's more honest than competitors, who use net flow everywhere and call it PnL.

Rank on **realized**, not total. Unrealized needs a mark price from a pool that might hold 2 ETH of liquidity — someone sitting on a dead coin's absurd last price would top the board. Show unrealized, don't rank on it.

### Leaderboard — portable SQL, unchanged in Postgres

```sql
SELECT trader,
       SUM(eth_out - eth_in) AS pnl,
       SUM(trades)           AS trades,
       SUM(eth_in + eth_out) AS volume
FROM daily_flow
WHERE day >= :windowStart
  AND pool_id IN (SELECT pool_id FROM pool WHERE mode = 'instant')
GROUP BY trader
HAVING SUM(trades) >= 10
ORDER BY pnl DESC
LIMIT 1000;
```

### Flags — expose as filters, not hidden badges

| Flag | Meaning |
|---|---|
| `didnt_buy` | Received by transfer, never bought → infinite ROI if unfiltered |
| `sold_gt_bought` | Sold more than ever bought |
| `fast_flip` | Buy + sell of one pool within N seconds. Tune N for ~100ms blocks |
| `crowd_entry` | Holds a crowd-launch token with no purchase — basis unknown |

---

## 9. Crowd launches

| Case | Handling |
|---|---|
| **Not graduated** | No pool, no price. Own page layout — progress, clearing price, raised vs threshold. Excluded from PnL, volume, leaderboard |
| **Graduated** | Pool and trading look normal, **but auction entrants still have no purchase in your swap data.** Flag `crowd_entry`, hold out of the ranked board |

The second case is the one people miss. Auction participants got tokens from `claimTokens()`, not a swap — so to a swap-only indexer they appear to have acquired tokens for free, and their PnL is overstated by their entire cost basis. **This persists forever after graduation**; it isn't a pending state that resolves.

- **Fix 1 (20 min, default):** badge + flag + exclude from ranking. Realized PnL from sells is still correct; only the entry is missing.
- **Fix 2 (+45 min), if crowd >10% of active pools:** read each auction's final `ClearingPriceUpdated` and its `TokensClaimed`, insert a synthetic buy of `claimed × clearingPrice`. Exact basis, nobody excluded. Two numbers per auction, not the full auction dataset.

Also: migration liquidity arrives via `ModifyLiquidity`, not a swap. Make sure it never counts as volume or every crowd launch appears to open with a huge print.

---

## 10. Enrichment, output, and the cron

| Job | Source | Notes |
|---|---|---|
| **Holders** | Blockscout `/api/v2/tokens/{token}/holders` | **Only pools above a liquidity floor** — crawling 10k dead tokens every 30 min is thousands of wasted requests. Everything else: lazy on first view, cached 30 min |
| **Price** | `StateView.getSlot0(poolId)` | Multicall hundreds per request. Or use the last swap's `sqrtPrice` — already in your rows |
| **ETH/USD** | Chainlink on 4663 | Read the feed address at runtime, don't hardcode |
| **ENS** | **Ethereum mainnet** UniversalResolver | Separate client. Forward-verify every name. Low hit rate — design the miss state first |

### Price from sqrtPriceX96

```ts
const Q192 = 1n << 192n
const ethPerToken = (sqrtP: bigint, d0 = 18n, d1 = 18n) =>
  (Q192 * 10n ** (18n + d1 - d0)) / (sqrtP * sqrtP)
// square in BigInt BEFORE any float conversion — these are ~1e-10 ETH
// FDV in ETH = ethPerToken * 1e9
```

### Deriving a pool id from a token address

Since every other field is fixed, a token address is enough — no need to wait for `Initialize`:

```ts
import { encodeAbiParameters, keccak256, zeroAddress } from 'viem'

const poolIdFor = (token: Hex, tickSpacing = 25) => keccak256(
  encodeAbiParameters(
    [{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],
    [zeroAddress, token, 2500, tickSpacing, zeroAddress]
  )
)
// poolId = keccak256 of the ABI-encoded (padded, 160-byte) PoolKey
```

### Output files

```
meta.json          { indexedBlock, indexedAt, lagSeconds, window }
pools.json         top ~1000 by volume  // full list in pools-all.json, lazy
leaderboard.json   top 1000
labels.json
search.json        names + addresses only — keep under ~2MB gzipped
pools/0x….json     per-pool detail + candles
wallets/0x….json   top 1000 only
holders/0x….json   liquid pools only
```

Commit the small top-level files to the repo; push sharded directories to R2 or Vercel Blob. Thousands of files in git history will make the repo miserable.

### The cron

```yaml
# .github/workflows/refresh.yml — */30 * * * *
scan pools (incremental) → scan swaps (incremental)
→ fold → recompute → emit JSON → upload
# RPC_URL is a GitHub secret. It never reaches the browser.
```

**Never put an RPC key in client-side code.** If you want live client-side chain reads, proxy them through one serverless function with the key server-side.

---

## 11. Verify before you send

- [ ] **Distinct traders isn't tiny.** Single digits = you stored the router.
- [ ] **Every swap has opposite-signed legs.** Zero rows where both signs match.
- [ ] **One wallet reconciles by hand.** Pick a mid-activity wallet, open it on Blockscout, check buys, sells and net ETH against the real list. **Catches traps 1, 2 and 3 at once — do this before building anything on top of the fold.**
- [ ] **A pool's price matches an aggregator.** Off by 10ⁿ = decimals. Reciprocal = inverted.
- [ ] **No protocol address on the board.** Cross-check against labels.json — must be empty.
- [ ] **Volume isn't double.** ~2× a Dexscreener check = trap 2.
- [ ] **Top wallet has buys.** Sells with no buys = phantom basis.
- [ ] **Derived rebuilds from scratch.** Wipe derived, recompute, identical output.

### Ship with

- **Freshness stamp on every page** — "as of block N, 4 minutes ago". Disclosed staleness is a trust signal; hidden staleness is a bug.
- **Methodology page** — cost basis, dedupe, exclusions, flag definitions. Nobody in this space publishes one.
- **README with the cut list** — what you deferred and why.
- **"Not affiliated with Uniswap Labs"** in the footer. Their [trademark policy](https://uniswap.org/trademark) prohibits the mark in a product or domain name.

### UI conventions that carry credibility

- **Subscript-zero notation for tiny prices**: `0.0000000124` → `0.0₈124`. Highest-ratio detail on the list.
- `font-variant-numeric: tabular-nums` on every numeric column.
- PnL always signed and coloured; never a bare number.
- Truncate addresses at both ends (`0x8f3a…b21c`), deterministic identicon, copy button + explorer link.
- Sort and filter state in the URL so views are shareable.

---

## Appendix — upgrading to Railway

~2 hours, and only after the MVP is live. Nothing below touches the scan, the fold, the traps, or any component.

| Step | Time |
|---|---|
| Provision Railway Postgres | 5 min |
| Translate schema DDL | 20 min |
| Write `PgStore implements Store` | 45 min |
| Move the cron to a Railway worker — same script, different trigger | 20 min |
| API routes — thin wrappers over `store.*` | 30 min |
| Change the frontend base URL | 5 min |

```sql
CREATE TABLE pool (
  pool_id bytea PRIMARY KEY, token bytea NOT NULL UNIQUE,
  name text, symbol text, decimals smallint NOT NULL DEFAULT 18,
  mode text NOT NULL, tick_spacing int NOT NULL,
  launcher bytea NOT NULL, creator bytea NOT NULL,
  created_block bigint NOT NULL, created_ts timestamptz NOT NULL,
  created_tx bytea NOT NULL
);

CREATE TABLE swap (
  tx_hash bytea, log_index int,
  pool_id bytea NOT NULL REFERENCES pool,
  block bigint NOT NULL, ts timestamptz NOT NULL,
  trader bytea NOT NULL,
  eth_delta numeric(78,0) NOT NULL,     -- your strings land here unchanged
  token_delta numeric(78,0) NOT NULL,
  sqrt_price numeric(78,0) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX ON swap (trader, block DESC);
CREATE INDEX ON swap (pool_id, block DESC);

-- position, daily_flow, pool_stat, leaderboard, holder, label, scan_cursor
-- mirror the MVP shapes exactly
```

**What it unlocks**

- **All-time.** pools.trade is only ~9 weeks old, so the full backfill is roughly an hour, not overnight. Every window from `daily_flow`.
- **Any address.** Wallet pages and PnL cards generated on demand, not pre-built for the top N.
- **Real search.** Prefix indexes on addresses, trigram on names.
- **Seconds-not-minutes iteration.** Change the PnL math, recompute derived — no re-scan.
- **Per-wallet refresh button.** `getLogs` Transfer where `to`/`from` = addr (both indexed), upsert, recompute that trader only. This is the one query the chain *can* answer per-address, because `Transfer` indexes `from` and `to` — unlike `Swap`, which doesn't index the trader at all.
- **The CCA auction explorer** becomes new tables, not a new architecture.

**Why this stays cheap:** big numbers were strings all along, so they drop into `numeric(78,0)` with no conversion. Every read went through `Store`, so the API returns the shapes the files already had. `fold.ts` is pure, so it moves untouched.

---

## Stretch goals, ranked by signal

1. **CCA auction explorer** — clearing-price path, bid ladder, fills, refunds. Uniswap's own novel mechanism, and nobody has visualized one.
2. **Crowd vs instant study** — does TWAP bidding actually reduce sniping? Their blog asserts it; nobody has measured it.
3. **Creator pages** — `pool` grouped by creator. Nearly free once the pool scan exists.
4. **Locked-liquidity tracker** — fees autocompound into a position nobody can withdraw, so the floor only rises. Unique to pools.trade, unindexed.
5. **All-time leaderboard** — see appendix.
6. **Read-only wallet connect** — "you're ranked #412". 30 min with wagmi, no database.
7. **Public JSON API** — positions it as infrastructure rather than a page.

One deep feature beats seven shallow ones.

---

## Competitive context

- **pools.xyz** has no trader analytics. Uniswap's Launch Aggregator (`app.uniswap.org/launches`) has token discovery but no leaderboards or trader pages.
- **kolscan.fun** ships a Robinhood Chain leaderboard — but it's a *curated KOL list*; you only appear if they track you. Don't claim "no leaderboard exists."
- **robinscan.io** covers holders and risk scoring (including adjusted top-10 excluding infrastructure addresses — worth copying).
- **hoodpools.com** covers tokenized stock pairs, and publishes a methodology page.

The genuinely unoccupied ground: a permissionless, all-wallet leaderboard with per-token attribution and a page for any address — plus anything touching the CCA.

---

*Verify contract addresses and event signatures on Blockscout before use — several come from a third-party indexer's documentation rather than Uniswap directly. Independent analysis, not affiliated with or endorsed by Uniswap Labs.*
