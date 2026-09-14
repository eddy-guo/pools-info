# Pools From First Principles

Conceptual background. What Uniswap does, what a pool really is, how pools.trade is wired in, and every term in the spec decoded. No code.

---

## 1. Uniswap, in five ideas

**1. There is no order book and no counterparty.**
On a normal exchange you buy because someone sells — your order matches theirs. Uniswap deleted that. You trade against a pot of two tokens sitting in a contract. You put ETH in, tokens come out, and nobody is on the other side. That pot is the pool.

**2. The price is just the ratio of what's in the pot.**
If the pool holds 10 ETH and 1,000,000 TOKEN, one token costs `10 ÷ 1,000,000` = 0.00001 ETH. Nobody sets that price. It's arithmetic on the balances, which is why it moves the instant anyone trades.

```
BEFORE: 10 ETH / 1,000,000 TOKEN     price 0.00001 ETH
  buy with 1 ETH → +1 ETH in, −90,909 TOKEN out
AFTER:  11 ETH /   909,091 TOKEN     price 0.0000121 ETH

the pool keeps ETH × TOKEN constant: 10 × 1,000,000 = 11 × 909,091
price rose 21% because you bought, not because anyone quoted you
```

That's slippage: the bigger your trade relative to the pot, the worse your price.

**3. Liquidity providers stock the pot and earn the fees.**
Someone has to put that ETH and TOKEN in. Every trade pays a fee (0.25% on pools.trade) that accrues to them.

**4. v2 → v3 → v4 is a story about where liquidity sits.**
- **v2:** your liquidity spreads across every possible price, zero to infinity. Simple, wasteful.
- **v3:** you pick a price *range* — all your capital works inside it and earns far more fees, but earns nothing if price leaves. That's "concentrated liquidity," and ranges are measured in **ticks**.
- **v4:** same math as v3, but every pool on the chain lives inside *one* contract instead of one contract per pool, plus optional plugins called hooks. That single-contract design is the "singleton."

**5. "Uniswap" is four things wearing one name.**
The **protocol** is the contracts. **Uniswap Labs** is the company. The **interface** at app.uniswap.org is one front end among many. **UNI** is the governance token.

---

## 2. What lives where

| Thing | What it is | Relevant? |
|---|---|---|
| **Uniswap v4** | The current AMM contracts. One `PoolManager` holds every pool on the chain | **Yes — the core** |
| **pools.trade** | A launchpad: contracts + web app that create a token and its v4 pool in one transaction | **Yes — the subject** |
| **Universal Router** | The contract that executes your swap and calls PoolManager for you | Yes — and it's why `Swap.sender` is never the trader |
| **Robinhood Chain** | **Robinhood's** L2, not Uniswap's. Arbitrum Orbit, settles to Ethereum. Uniswap is a tenant | Yes — where everything runs |
| Unichain | Uniswap's *own* L2. A different chain entirely | No — wrong chain |
| UniswapX | Intent-based trading; off-chain fillers compete for your fill | No |
| Uniswap Wallet | Their consumer wallet | No |
| Trading API | Hosted quoting + swap execution, gated | Only for a swap widget — **it has no analytics data** |
| Launch Aggregator | `app.uniswap.org/launches` — their token discovery tab | As competitive context — no trader analytics |

```
┌──────────────────────────────────────┐
│ Your dashboard                       │  YOU
│ a sibling of pools.xyz, not a layer  │
│ on top of it                         │
├──────────────────────────────────────┤
│ pools.xyz web app                    │  UNISWAP LABS
│ one of many possible front ends      │   ↑ nothing available from their app
├──────────────────────────────────────┤
│ pools.trade contracts                │  UNISWAP
│ mints token + opens v4 pool, one tx  │   ↑ you read event logs
├──────────────────────────────────────┤
│ Uniswap v4 — PoolManager + routers   │  UNISWAP
│ every pool, one contract             │   ↑ you read logs + contract state
├──────────────────────────────────────┤
│ Robinhood Chain · 4663               │  ROBINHOOD
│ Arbitrum Orbit L2 · ~100ms blocks    │
├──────────────────────────────────────┤
│ Ethereum L1                          │  ETHEREUM
│ settlement · where ENS lives         │
└──────────────────────────────────────┘
```

**There is no path that "queries Robinhood Chain through Uniswap."** Uniswap is a set of contracts *on* the chain, not a data provider in front of it. You read the chain directly. The only things Uniswap hands you are contract addresses, ABIs, SDKs, and open-source indexing code.

---

## 3. What pools.trade actually did

On a normal launchpad, a new token can't have a real market yet — no liquidity, because nobody deposited any. So launchpads invent a temporary one: a **bonding curve**, a separate contract that sells tokens at a mathematically rising price. Once enough has sold, the operator takes the money, opens a real pool on a real DEX, and moves everyone over. That move is **graduation** or migration, and it's where everything can go wrong — a privileged operation, a rug point, a discontinuity in price history.

Uniswap's insight: **a concentrated-liquidity position can be shaped so it already behaves like a bonding curve.** So they skipped the temporary contract entirely.

Every pools.trade launch mints 1,000,000,000 tokens and deposits *all of them, and zero ETH*, into a real v4 pool as a single position — with the starting price at the very top of that position's range. Because there's no ETH in the pot yet, the only possible trade is a buy. As buyers arrive, ETH accumulates and price walks down the range. **Mechanically a bonding curve. Structurally just a Uniswap pool that has been one since block one.**

```
pump.fun model
  mint token → bonding curve → [MIGRATION] → real DEX pool
                (separate)     at threshold   price history restarts
                              ↑ the rug point, the discontinuity

pools.trade model
  [mint token + open real v4 pool] → people trade → (no migration)
   ONE transaction                    ETH accumulates  liquidity locked forever,
   all 1B tokens in, 0 ETH in         price walks      fees compound into it
```

### pools.trade vs pump.fun

| | pump.fun | pools.trade |
|---|---|---|
| Early price discovery | Separate bonding-curve contract | A real v4 pool, shaped like a curve |
| Graduation | Real: liquidity migrates at a threshold | Doesn't exist; progress bar is cosmetic |
| Who holds liquidity after | Burned or locked LP tokens, varies | A contract with no withdrawal function, permanently |
| Fees | ~1% plus launch fees | 0.25% total; 0.20% compounds, 0.05% optional to creator |
| Creator's starting tokens | Often a dev allocation | **Zero.** They must buy their own launch |
| Anti-sniping | None in the base design | Optional: a 4-hour auction splitting each bid over time |
| Chain | Solana | Robinhood Chain (an Ethereum L2) |
| **What to track** | Migrations, dev wallets, LP burns | **None of those exist.** Auctions, locked-liquidity growth, who's actually trading |

### The two launch modes, plainly

**Instant launch:** pool opens immediately, first buyer gets the lowest price. Fast, and snipeable.

**Crowd launch:** a ~4-hour auction runs first. Everyone bids a maximum price, every bid gets spread across the remaining time so being first doesn't help, and at the end everyone who cleared pays the *same* price. If it doesn't raise enough, everybody is refunded and the token never opens. Then a pool is built at that final clearing price.

---

## 4. The vocabulary

**RPC** — a URL you send JSON to, that asks a blockchain node a question. That's it. `eth_call` = "read this contract now." `eth_getLogs` = "give me past events matching this filter." Every library (viem, ethers) wraps these.

**Events / logs** — **the most important concept here.** Contracts can't be queried about their history; storage only holds current state. So contracts *emit events*: permanent receipts written into the block. "Pool initialized." "Swap happened, here are the amounts and the new price." The chain's entire searchable history is these logs. Your dashboard is, fundamentally, a nice view over v4's `Swap` logs.

**Indexer** — a program that reads all those logs once, decodes them, and writes them into a normal database. After that your website queries the database — fast, sortable, searchable — instead of the chain, which is none of those. **You don't search the blockchain; you search your copy of it.**

**Caching (the 30-minute thing)** — fetching one token's holder list takes ~200 API calls. You can't do that while someone waits for a page. So a background job does it every 30 minutes and stores the result; page views read the stored copy. "Cache" here just means *fetch on a schedule, serve from your own store*.

**Multicall** — one RPC request that performs hundreds of contract reads at once. How you refresh 500 pools' prices without making 500 requests.

---

## 5. Why holders can't come from an RPC call

**An ERC-20 token does not store a list of its holders.** It stores a mapping from address to balance, and a mapping can't be iterated — you can ask "what is 0xabc's balance" but never "who has a balance." There is no RPC method because there's no data structure to read.

Two ways to know a token's holders, and everyone uses one:

1. **Replay history.** Fetch every `Transfer` event the token ever emitted and add them up. Correct, and at ~864,000 blocks a day, slow.
2. **Ask something that already did that.** Block explorers do this continuously. Blockscout — Robinhood Chain's explorer — exposes it as a free endpoint with no API key.

Use the second. The 30-minute cache is how you make it cheap.

---

## 6. What can and can't be computed on demand

The blocker isn't performance — it's that the query doesn't exist.

| Question | On demand? | Why |
|---|---|---|
| Price of pool X | ✅ | One `eth_call` |
| Creation time + creator of pool X | ✅ | One log + one tx + one block |
| Holders of token X | ✅ | Blockscout maintains that index |
| **Every swap by wallet X** | ⚠️ | Not via `Swap` — the trader is `tx.from`, which isn't an event field and isn't filterable. **But** ERC-20 `Transfer` *does* index `from` and `to`, so you can find a wallet's activity that way |
| **Top 100 traders by PnL** | ❌ | Requires aggregating every swap. You can't narrow it — you don't know the candidates until you've seen everyone |

**The generalizable rule:** per-entity data is fine on demand. Cross-entity aggregates — rankings, totals, "top N" — are impossible on demand.

**So the leaderboard is the single feature that forces a store.** You could build this entire site with no database and everything would work except that one thing. Which tells you exactly how much infrastructure is justified.

### The reframe

**The cron job *is* your backend.** You're not avoiding a backend — you're choosing when it runs:

| | Serverless | Cron |
|---|---|---|
| Trigger | Per request | Every 30 min |
| Budget | ~10s, ~1 GB | Minutes, whole disk |
| Good for | One entity | Aggregation over everything |

Same code, different trigger. Scheduled is strictly better here, because the work is identical for every visitor.

---

## 7. Staleness is not wrongness

**Your store isn't a cache of mutable state. It's a prefix of an append-only log.**

A swap that happened at block 1,000,000 never changes. So everything you indexed up to block N is permanently, exactly correct. Unlike caching a user profile — where someone edits the source and your copy becomes *wrong* — here the source only ever appends. Your copy can only be **incomplete**, never incorrect.

The error is bounded by one number: how far behind the tip you are. So state it: *"as of block 12,345,678 — 4 minutes ago."* Etherscan does this. It converts staleness from a hidden bug into a disclosed property.

### Does it matter? Depends on the metric

| Metric | Changes on the scale of | 30 min stale = |
|---|---|---|
| 7-day PnL ranking | Days | Fine — one trade barely moves a 7-day sum |
| Pool creation facts | Never | Immutable |
| Holder list | Hours | Fine |
| **Current price** | Seconds | **Visibly wrong** — why price is read live |

### Two things you *do* have to engineer

1. **Partial writes** — the real danger. If your job dies halfway, some wallets are updated and some aren't, and now Alice's sell is recorded but not her buy. Wrap each run in a transaction, or write to staging and swap atomically.
2. **Reorgs at the tip** — the newest blocks are only soft-confirmed and can be reordered. Index to `tip − N`, and re-scan the last few minutes each run.

---

## 8. What's dynamic and what isn't

"Dynamic" doesn't mean "rows need updating." A pool's volume isn't a field that gets edited — it's a `SUM` over swap rows that keep arriving.

| Data | Changes? | Handling |
|---|---|---|
| poolId, token, name, symbol, decimals | **Never** | Write once |
| Creator, creation time, launch mode | **Never** | Write once |
| Trades | Appends only | Insert new rows |
| Volume, trade count, unique traders | Derived | Recompute from swaps |
| Price history / candles | Derived | **Already in your swap rows** |
| Current price | Constantly | Live read, or last swap's price |
| Liquidity | Slowly — locked, grows with fees | Live read |
| **Holder balances** | Constantly | **Re-fetch and overwrite** |

Across the whole schema: `pool` and `swap` are **insert-only, never updated**. Derived tables are wiped and rebuilt. `holder` is the **one genuinely mutable table**. That's the entire answer to "but it's dynamic."

**A freebie:** every `Swap` log carries `sqrtPriceX96` — the price at that instant. Your swap rows *are* your price history. No separate price job, no candle API. Bucket by time and you have candles.

**The one job that scales badly:** a pool with 500 holders is ~10 paginated requests. Doing that for 10,000 pools every 30 minutes isn't viable. So crawl only pools above a liquidity floor on a schedule, and fetch the rest lazily on first view. Most of your 10k pools are dead tokens nobody will open.

---

## 9. Search, and why theirs is bad

A single undifferentiated search box has to guess what a string means. `0x8` could be a token, a wallet, or a transaction prefix — and a live chain query can't prefix-match any of them, because there's no index to scan.

Once your data is in a database, all of it is just SQL:

| User types | You return | How |
|---|---|---|
| `frog` | Tokens whose name or symbol matches, ranked by liquidity | Trigram / prefix index |
| `0x8f3…` | Grouped: **tokens**, **wallets**, **transactions** | Prefix index per column — impossible on-chain, trivial in SQL |
| A full address | Jump to that token or wallet | Exact lookup |
| A 66-char hash | The transaction with decoded swaps | Exact lookup |
| `vitalik.eth` | Resolve on Ethereum mainnet, then the wallet | Separate mainnet client |

The UX fix is **typed, grouped results** — labelled sections with enough context per row to choose. An hour of work once the data is indexed, and it's categorically better than a flat list.

> A note on terminology you'll see on pools.xyz: token names like "frog" and "candy" are just memecoin names, not protocol vocabulary. What looks like odd search output is usually a live activity feed rendered near the search box.

---

## 10. Profiles without accounts

You want a user to land on a page showing what they hold and how they've done. The instinct is that this needs accounts, sessions, login. It doesn't — **the chain is already the user database, and it's public.**

A wallet page is just a route: `/wallet/0xabc…`. It reads that address's trades from your index and its balances from Blockscout. No login, because there's nothing to authenticate. It works for any address whether or not its owner has ever visited.

Connecting a wallet adds exactly one thing: **it tells you which address is the visitor's**, so you can say "you're ranked #412" instead of making them paste it. ~30 minutes with wagmi, no database table, no signature flow.

| Feature | Needs accounts? | Do instead |
|---|---|---|
| See my holdings and PnL | No | `/wallet/[address]` — works for anyone |
| "That's me" highlighting | No | Read-only wallet connect |
| Watchlist | No | URL params (shareable) + `localStorage` |
| Email or push alerts | **Yes** | The one real exception — cut it |

You still need a data store for indexed swaps and computed PnL. That's a *data* database, not a *user* database. Keeping those separate collapses this from a scary feature into an afternoon.

---

## 11. So what are you building

A program that reads Uniswap v4's `Initialize` and `Swap` logs from Robinhood Chain once, decodes them into a database, figures out the real human behind each trade, and computes profit and loss per wallet. On top of that: a screener of tokens, a page per pool, a page per wallet, a leaderboard, and a search box that knows the difference between a token, a wallet and a transaction. Holder lists come from Blockscout on a schedule. Current prices come from a batched contract read. Nothing needs accounts, and nothing talks to Uniswap's servers.

**The one thing to internalize:** you don't query the blockchain; you copy it into a database and query that. Every "how do I search / sort / rank / paginate" question answers itself once that's true. The chain is a write-once log with terrible read ergonomics. Your value is the copy.

This is not an unusual architecture — **every site that lets you query chain data by anything other than "current state of one contract" is running an indexer.** Etherscan, Blockscout, Dexscreener, GMGN, Dune, Nansen, Arkham, Zapper, DeBank, The Graph. No exceptions. Blockscout is open source and Robinhood Chain's explorer *is* Blockscout — so when you call their holders endpoint, you're querying someone else's database that did exactly what you're about to do.

---

*Conceptual explanations are simplified where precision doesn't change the decision; exact constants, addresses and caveats live in BRIEF.md. Independent analysis, not affiliated with or endorsed by Uniswap Labs.*
