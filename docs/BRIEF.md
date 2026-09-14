# Pools.trade — Technical Brief

Reference material for building analytics on pools.trade (Uniswap Labs' launchpad on Robinhood Chain).
Protocol mechanics, verified addresses, data sources, metric definitions.

Researched 12–14 September 2026. **Provenance is marked throughout** — several facts come from a third-party indexer rather than Uniswap directly.

---

## 1. Corrections to common assumptions

| Assumption | Reality |
|---|---|
| Pools are like pump.fun — a curve that graduates | Every launch mints a **real Uniswap v4 pool in the same transaction as the token**. No curve contract, no migration, no graduation event |
| Holder lists come from an RPC call | **ERC-20 has no holder enumeration.** No RPC method exists. Use Blockscout's indexed endpoint |
| ENS lookups work on-chain | **ENS is not deployed on chain 4663.** Reverse lookups need a second client on Ethereum mainnet |
| Uniswap's API can supply the data | The Trading API is **swap execution and quoting only** — no pools, history, holders or traders, and it's gated behind an intake form. There's **no hosted v4 subgraph for 4663** either |
| PnL is straightforward: group swaps by wallet | `Swap.sender` is the **router**, not the trader. Group naively and your leaderboard has one row |
| The $50k FDV graduation bar is a milestone | **Cosmetic UI only.** Uniswap's own table says instant-launch graduation requirement: "No requirement." Nothing happens on-chain |
| No competitor exists | kolscan.fun, robinscan.io, hoodpools.com and pools.fun all ship Robinhood Chain leaderboards |

---

## 2. What a "pool" is

pools.trade is a front end over two public, audited Uniswap repos — the source **is** the documentation:

- [`Uniswap/liquidity-launcher`](https://github.com/Uniswap/liquidity-launcher)
- [`Uniswap/continuous-clearing-auction`](https://github.com/Uniswap/continuous-clearing-auction)
- Docs: [launchpad overview](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/overview), [CCA](https://docs.uniswap.org/contracts/liquidity-launchpad/CCA)

### Constants from `InstantLaunchStrategy.sol` — OFFICIAL

```solidity
int24   constant MIN_LAUNCH_TICK  = -160_100;
int24   constant MAX_INITIAL_TICK =  251_325;
uint256 constant TOTAL_SUPPLY     = 1_000_000_000e18;
uint24  constant LP_FEE           = 2_500;   // pips → 0.25%, NOT 2500 bps
int24   constant TICK_SPACING     = 25;

PoolKey({
  currency0: Currency.wrap(address(0)),  // native ETH, not WETH
  currency1: Currency.wrap(token),
  fee: LP_FEE, tickSpacing: TICK_SPACING,
  hooks: IHooks(address(0))              // no hooks at all
});
```

Because fee, tickSpacing, hooks and currency0 are fixed, **you can derive any pool's id from its token address alone** — no need to wait for an `Initialize` event.

### The liquidity position is unusual

The whole 1B supply goes in as **one single-sided, token-only position** spanning `[-160100, initialTick]`, with spot initialized at the *upper* bound. At t=0 the pool holds 1B tokens and zero ETH; buys walk the tick down and accumulate ETH.

Consequences:

- **The creator starts with zero tokens.** No allocation, no vesting. They must buy on their own pool. "Dev holding %" is structurally zero — a nonzero value means they bought.
- **Liquidity is locked permanently and structurally**, not by timelock. The LP NFT goes to a singleton `FeeSplitter` whose `onERC721Received` only accepts from the canonical PositionManager, and which contains **no transfer or withdrawal function**. Not even Uniswap can pull it.
- **LP fees autocompound into that locked position**, so every pool's liquidity floor only rises. Unique to pools.trade and nobody charts it.
- **Every token's largest holder is the v4 PoolManager**, since all liquidity sits in the singleton.

### The two launch modes

| | Instant ("curve") | Crowd (CCA) |
|---|---|---|
| Format | Live immediately, one transaction | ~4-hour bidding window, then pool opens |
| Mechanism | Single-sided v4 position; price discovered by trading | Continuous Clearing Auction in a per-token contract |
| Anti-sniping | None | Each bid is split across all remaining intervals — the "TWAP bid" |
| Threshold | None | 10k FDV or **all bids refunded** |
| Migration | None — pool exists from block one | Yes: permissionless `migrate()` builds the pool at final clearing price |
| Contract | `InstantLaunchStrategy` | `LBPStrategy` + `ContinuousClearingAuction` |

**CCA mechanics** (OFFICIAL, from the repo's technical documentation):

- Timing is in **blocks**, not timestamps: `startBlock`, `endBlock`, `claimBlock`. Supply releases per an `auctionStepsData` schedule (rates in milli-bps, `1e7 = 100%`).
- `submitBid(maxPrice, amount)`. Bids live in a sorted linked list at price ticks; each bid is spread across every remaining interval — that spreading, not an oracle, is what defeats bundling.
- **Clearing price** = the lowest price at which all remaining scheduled supply clears against demand at or above it. Q96 fixed point, recomputed lazily at most once per block, **monotonically non-decreasing**.
- Bids above clearing fill pro-rata; bids *at* clearing fill partially, pro-rata to demand at that tick.
- **Claiming is two steps, in order:** `exitBid()` (or `exitPartiallyFilledBid()`), then `claimTokens()` after `claimBlock`.
- **Failure:** not graduated → `exitBid()` refunds in full, `sweepUnsoldTokens()` returns the entire supply. A failed auction is a real, observable outcome.

### Fees — OFFICIAL

- **No launchpad fees.** A standard 0.25% LP fee that autocompounds into locked liquidity, framed against "the standard ~1% on other launchpads."
- **Optional creator fee:** creators can enable it at launch and receive **0.05% of the 25bps** — i.e. 20% of all LP fees; the other 20bps autocompounds.
- The creator's claim is a **transferable ERC-721** — creator fee streams are tradeable assets, and nothing indexes that market.
- `collectFees()` is **permissionless** — anyone can crank the compounding.

### "Graduation" at $50,000 FDV — THIRD-PARTY, and it's cosmetic

The $50k figure is **not an official Uniswap number and has no on-chain existence**. Uniswap's own comparison table says instant-launch graduation: "No requirement."

It comes from Bitquery describing the pools.trade UI: a graduation progress percentage computed as `fdvUsd / graduationTargetUsd * 100`. Explicitly: *"crossing 100% does not emit a migration event"* and *"no `Graduated` / `LaunchedToDEX` event to subscribe to."*

**Nothing changes at $50k.** No call, no event, no state transition. It's a pump.fun-style progress bar retained for familiarity on a protocol with no graduation step. The only real threshold is crowd-launch `requiredCurrencyRaised`.

---

## 3. Addresses

### Uniswap on Robinhood Chain — OFFICIAL ([deployments](https://developers.uniswap.org/deployments))

| Contract | Address |
|---|---|
| v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| v4 StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| v4 Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| v3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| v3 NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| v2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| v2 Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` |
| Universal Router | `0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

> The same PoolManager address is used on other chains — it's a deterministic deploy. Always filter by chain as well as address.

### pools.trade — OFFICIAL unless noted

| Contract | Address | Note |
|---|---|---|
| LiquidityLauncher (entry) | `0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0` | v3.2.0, Aug 5 |
| InstantLaunchStrategy *(creator fees)* | `0x23f8209572b4a1C2AD88A42749E830791Fb027f1` | tickSpacing 25 |
| InstantLaunchStrategy *(no fees)* | `0xAD44D55E7f8337C3cE113fBb591486E85be104b2` | The creator-fee toggle is **two deployed contracts**, not a flag |
| LBPStrategy (crowd) | `0x05d552391067389EE44fec3924157ed33F976000` | v3.1.1 |
| ContinuousClearingAuctionFactory | `0x000000001F26a0044BaA66024e7b6599c61963F8` | v2.1.0 |
| FeeSplitter *(holds every LP NFT)* | `0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf` | v3.2.0 |
| UERC20Factory (token factory) | `0x000000e200088D55C39a11F609E5F667729ad49b` | v2.0.0 |
| UERC20BeneficiaryVault | `0xd35E9CA72F64C7F93BE30fad67524323396B36D7` | |
| Launcher v1 *(July, still live)* | `0x00004c4ccc709ef590f7c81102c0689f0263d4e9` | THIRD-PARTY. **tickSpacing 60** |
| WETH (aeWETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | THIRD-PARTY |
| POOLS token | `0x385b36ff682ab4c76e7c37a66b96aabc466471d5` | THIRD-PARTY |

**Index both launcher versions** — the July deployment still processes launches and uses a different tickSpacing, so derive pool ids per launcher.

### Chain

| | |
|---|---|
| Chain ID | 4663 (`0x1237`); testnet 46630 |
| Mainnet RPC | `https://rpc.mainnet.chain.robinhood.com` — "rate-limited, not recommended for production" |
| Sequencer feed (WS) | `wss://feed.mainnet.chain.robinhood.com` — a Nitro broadcaster stream, **not** `eth_subscribe`. There is no public JSON-RPC websocket |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Production RPC | `https://robinhood-mainnet.g.alchemy.com/v2/<key>` — what Robinhood's own docs hand you |
| Stack | Arbitrum Nitro / Orbit, settles to Ethereum |
| Block time | ~100ms **[UNVERIFIED — sources say 100ms vs 250ms; this number dominates your cost model]** |
| Native gas | ETH |

### Arbitrum quirks that will bite an indexer

- **`block.number` inside a contract returns an estimated L1 block number**, not L2 height. JSON-RPC returns L2. Use `ArbSys(0x64).arbBlockNumber()` for true L2 height.
- Block timestamps track L1 time and are **not strictly increasing per block** — many consecutive blocks share a timestamp. Never use timestamp as a unique key; sort by block + logIndex.
- **Sequencer is first-come-first-served**, not priority-fee. Priority-gas-auction analytics are meaningless here, and "same block" is a weak bundler signal.
- **Three-stage finality:** sub-second soft confirmation (reorderable by the sequencer) → batch posted to L1 (minutes) → L1 finality (~13 min).

---

## 4. Data source routing

| What you need | Source | How |
|---|---|---|
| New pool / launch feed | On-chain logs | `TokenLaunched` from the launchpad, or v4 `Initialize` from PoolManager |
| Creation time | On-chain | Block timestamp of the launch tx |
| Creator address | On-chain | `tx.from` of the launch tx. Also recorded in the token as `graffiti() = keccak256(abi.encode(creator))` — a hash, so match by computing, don't reverse |
| Creator name (ENS) | **Ethereum mainnet**, not 4663 | Mainnet UniversalResolver reverse lookup, then forward-verify |
| Current price / liquidity | On-chain read | `StateView.getSlot0(poolId)` → `sqrtPriceX96`. Multicall hundreds at once |
| Price history / candles | Derived | Every `Swap` log carries `sqrtPriceX96` — **your swaps are your price series**. Shortcut: GeckoTerminal OHLCV |
| Holder list | Blockscout | `/api/v2/tokens/{addr}/holders`, keyset-paginated 50/page. `/counters` first to size. Free, no key, ~300 req/min per IP |
| Wallet's token balances | Blockscout | `/api/v2/addresses/{addr}/token-balances` — all in one call |
| Trades for PnL | **Your own index** | v4 `Swap` logs + `tx.from`. No API gives you this correctly |
| Token metadata | On-chain event | Factory `TokenCreated(address,(string,string,string,bytes))` carries name, description, URL, image |
| ETH/USD | Chainlink on 4663 | Read the feed address at runtime; don't hardcode |
| Bulk backfill | Envio HyperSync | `https://robinhood.hypersync.xyz` — returns tx fields alongside logs, free tier |
| Price cross-check | Dexscreener | Chain slug is `robinhood`. `/token-pairs/v1/robinhood/{token}`. No OHLCV, no trades |

**Skip:** Dune (free tier went view-only Sept 2026 — can't execute queries) and Bitquery (no real free tier, though their pools.trade decoding docs are the best third-party reference on this protocol).

**Blockscout limits:** no key → 300 req/min per IP; free PRO key → 5 rps / 100k credits per day at `api.blockscout.com/4663/api/v2/...`. `eth_getLogs` and `txlistinternal` are capped at **1,000 records on Robinhood Chain** specifically.

---

## 5. The Uniswap v4 data model

v4 is a **singleton** — one contract holds every pool. There are no per-pool addresses.

```solidity
struct PoolKey {
    Currency currency0;   // lower, sorted numerically. Native ETH = address(0)
    Currency currency1;
    uint24 fee;           // capped 1_000_000; high bit set = dynamic fee
    int24 tickSpacing;
    IHooks hooks;
}

// poolId = keccak256 of the tightly-packed 160-byte (5×32) PoolKey
function toId(PoolKey memory k) internal pure returns (PoolId id) {
    assembly ("memory-safe") { id := keccak256(k, 0xa0) }
}
```

```solidity
event Initialize(PoolId indexed id, Currency indexed currency0,
  Currency indexed currency1, uint24 fee, int24 tickSpacing,
  IHooks hooks, uint160 sqrtPriceX96, int24 tick);

event Swap(PoolId indexed id, address indexed sender,
  int128 amount0, int128 amount1, uint160 sqrtPriceX96,
  uint128 liquidity, int24 tick, uint24 fee);

event ModifyLiquidity(PoolId indexed id, address indexed sender,
  int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt);
```

**Four consequences for indexing:**

1. You cannot filter by `address` to isolate a pool. Filter on `topics[1]` = poolId.
2. `Initialize` is the **only** event carrying the PoolKey. `Swap` carries an opaque poolId only — without an id→tokens map, swap logs are undecodable. Index `Initialize` first.
3. **`Swap.sender` is the router**, not the trader. The end user is `tx.from`. This is the most common v4 PnL bug.
4. `amount0`/`amount1` are signed `int128` deltas. **v4 flipped the sign convention relative to v3** — determine it empirically from one known transaction, never from documentation.

### StateView — the read-only lens

PoolManager keeps state in packed storage with no public getters. All functions take `PoolId`:

```
getSlot0(PoolId) → (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
getLiquidity(PoolId) → uint128
getFeeGrowthGlobals, getTickInfo, getPositionInfo, getFeeGrowthInside, …
```

`getSlot0` multicalled across many poolIds gives you a whole live price table in one request.

### Price math

```ts
const Q192 = 1n << 192n
// wei of ETH per whole token; decimals cancel when both are 18
const ethPerToken = (sqrtP: bigint, d0 = 18n, d1 = 18n) =>
  (Q192 * 10n ** (18n + d1 - d0)) / (sqrtP * sqrtP)
// from tick: price = 1.0001 ** tick
```

Square in BigInt **before** any float conversion — these prices sit around 1e-10 ETH and converting first loses them entirely.

---

## 6. Leaderboard metric definitions

None of Dexscreener, GMGN, kolscan, Axiom or pump.fun publishes a PnL formula. These are the standard reconstructions — **state yours on a methodology page**.

- **Realized PnL** = Σ(sell proceeds) − Σ(cost basis of tokens sold). Two conventions: **average cost** (total ETH spent ÷ total tokens bought, applied to the sold quantity — easier and more common) or FIFO. Dexscreener degenerates to `sell_usd − buy_usd`, which equals average-cost realized PnL only when a position is fully closed.
- **Unrealized PnL** = (mark price × tokens still held) − cost basis of those tokens. Mark with `getSlot0`, and haircut or flag against pool liquidity — a 10 ETH paper position in a 2 ETH pool isn't worth 10 ETH.
- **Total PnL** = realized + unrealized.
- **ROI** = total PnL ÷ total cost basis. Guard against near-zero denominators (airdrops, transfers in) or you get ∞.
- **Win rate** = winning ÷ closed positions. Pick per-closed-token-position, require ≥10 trades before ranking, and say so.
- **Avg holding duration** = mean(first buy → last sell) per position. Separates snipers from swing traders.

**Rank on realized.** Unrealized on an illiquid memecoin is fiction, and it's also what kolscan and Dexscreener do.

### Columns worth shipping

Rank · wallet · realized PnL · ROI · W/L record · trades · volume · avg hold · last trade. Timeframe tabs (24h / 7d / 30d / all) and a minimum trade count.

### Anti-gaming — these exist because leaderboards get farmed

GMGN's four checks, computable from swap logs alone. Ship as **filters**, not just badges:

- **Didn't buy** — tokens arrived by transfer, not purchase (the zero-cost-basis exploit)
- **Sold > bought** — indicates inbound transfers
- **Buy/sell within N seconds** — wash trading
- **Blacklist/honeypot count** — known-bad tokens touched

### Holder-quality tags — retune for this chain

Standard definitions come from Solana tooling and **do not transfer**:

- **Sniper** — standard is "bought within 0–3 blocks." At ~100ms that's 300 milliseconds. Define by **block offset from `Initialize`**, or better, by share of supply acquired in the first N blocks. Express as a **rate** ("18% of supply held by snipers"), not a count.
- **Bundler** — standard is "4+ transactions in the same block." Near-meaningless at 100ms. Use **shared funding source + tight amount clustering** instead.
- **Fresh wallet** — nobody publishes a definition. Pick one, document it.
- **Top-10 concentration** — show raw, **adjusted** (excluding infrastructure addresses), and optionally Gini. The adjusted figure is essential here because the protocol-held pool is always the #1 holder.

### Two chain-specific caveats

1. Bitquery warns each trade leg **returns approximately twice** on Robinhood v4 — deduplicate before aggregating volume.
2. pools.trade trades appear as generic Uniswap v4 activity and aren't isolable by a protocol filter — you isolate by poolId against your own pool set.

---

## 7. Trademark — read before naming anything

Uniswap Labs publishes a [trademark policy](https://uniswap.org/trademark). Sending an unsolicited project to the company whose policy you've violated is an avoidable own-goal.

| | Rule |
|---|---|
| **Allowed** | Use the wordmark in text to truthfully refer to and link to unmodified Uniswap contracts. Use logos to identify Uniswap software in an integration. State non-affiliation |
| **Required** | Include the attribution line; use the mark as an **adjective** — "the Uniswap protocol", never "Uniswap's" |
| **Prohibited** | The mark in your product name, business name, or **domain name**. Implying affiliation. Confusingly similar "Uni-Something" constructions |

Practically: no Uniswap- or Uni-prefixed domain, don't reuse the pools.xyz droplet mark. Build something visually *compatible* — pools.xyz runs near-black `#131313`, classic Uniswap pink is `#FF007A` — and put "not affiliated with Uniswap Labs" in the footer.

Official assets: [`Uniswap/brand-assets`](https://github.com/Uniswap/brand-assets).

---

## 8. Verify before you ship

| Check | Why it matters |
|---|---|
| **Real block time** | Dominates your entire indexing cost model; sources say 100ms vs 250ms |
| **Swap sign convention** | Gets buy/sell backwards and silently inverts the whole leaderboard |
| **Blockscout keyless access** | Your entire holder strategy depends on it |
| **`eth_getLogs` caps** | Undocumented block-range and result limits on the public RPC |
| **`initialTick` on each strategy** | An immutable — every instant launch starts at the identical price. This is your baseline FDV, and it's unpublished |
| **FeeSplitter `splits()`** | Confirms the 20%-to-creator figure, which is derived from the blog rather than read from chain |
| **pools.trade on GeckoTerminal** | If its pools aren't indexed there, you lose the free OHLCV shortcut |
| **Event topic0 hashes** | Bitquery lists `TokenCreated` and `TokenDistributed` with identical hashes — clearly a doc error. Compute from the repo interfaces |
| **Crowd-launch threshold** | Blog says 10k FDV, Bitquery says ~$5k raise — reconcilable but unconfirmed |

**Solid:** pool mechanics, constants, fees, locked liquidity, distribution, and the v4 data model — all from Uniswap source, repo docs, or the blog.

**Third-party only (Bitquery):** the $50,000 graduation target, the July-launcher addresses, the double-counted-legs warning, the ~4-hour auction duration, chain ID.

---

## 9. Competitive landscape

- **pools.xyz** — no trader analytics. Its own description covers launching, trading, live price tracking, position claims.
- **Uniswap Launch Aggregator** (`app.uniswap.org/launches`) — token discovery across launchpads, sortable by 24h volume / liquidity / recency / trending. **No leaderboards or trader analytics.** Its launch post gives the market size: 340K+ new tokens and $3.6B volume on Robinhood Chain in July alone.
- **kolscan.fun** — closest competitor. Live leaderboard for Robinhood Chain: trader, Realized PnL, Record (W/L), Buys/Sells, Volume, Last. Today / 7D / 30D / All-time. **But it's a curated KOL list** — you only appear if they track you.
- **robinscan.io** — explorer + leaderboard. Holders tab with raw Top-10, **adjusted Top-10 excluding infrastructure addresses**, and a Gini coefficient, feeding a 0–100 risk score. The adjusted figure is the single best idea to copy.
- **hoodpools.com** — pool scanner focused on tokenized stocks, not memecoins. Publishes raw JSON exports and a methodology page.
- **pools.fun** — a competing launchpad on SushiSwap v3, not an analytics site. Name-squats adjacent to pools.trade.
- **Pons** — the main competing launchpad. Peak ~80% of Robinhood Chain launchpad volume; 1.65M trades in a 24h window; 250,000+ tokens launched.

**Genuinely unoccupied:** a permissionless, all-wallet leaderboard with per-token attribution and a page for any address — and anything touching the CCA. Nobody has visualized a continuous clearing auction.

---

## Sources

**Uniswap**
- [Pools.trade: A New Way to Launch](https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain)
- [Uniswap is Live on Robinhood Chain](https://blog.uniswap.org/robinhood-chain-is-live)
- [Launch Aggregator](https://blog.uniswap.org/launch-aggregator-explore-top-uniswap-launchpads-in-one-place)
- [liquidity-launcher](https://github.com/Uniswap/liquidity-launcher) · [continuous-clearing-auction](https://github.com/Uniswap/continuous-clearing-auction) · [v4-core](https://github.com/Uniswap/v4-core) · [v4-periphery](https://github.com/Uniswap/v4-periphery) · [v4-subgraph](https://github.com/Uniswap/v4-subgraph)
- [Deployments](https://developers.uniswap.org/deployments) · [Launchpad deployments](https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/deployments) · [CCA docs](https://docs.uniswap.org/contracts/liquidity-launchpad/CCA)
- [Trading API](https://api-docs.uniswap.org/introduction) · [uniswap-ai skills](https://github.com/Uniswap/uniswap-ai) · [brand-assets](https://github.com/Uniswap/brand-assets) · [trademark policy](https://uniswap.org/trademark)

**Chain & data**
- [Robinhood Chain docs](https://docs.robinhood.com/chain/) · [connecting](https://docs.robinhood.com/chain/connecting/) · [differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/) · [finality](https://docs.robinhood.com/chain/transaction-finality/)
- [Bitquery pools.trade API](https://docs.bitquery.io/docs/blockchain/robinhood/pools-trade-api/)
- [Blockscout REST](https://docs.blockscout.com/devs/apis/rest) · [Robinhood PRO API](https://docs.blockscout.com/robinhood-api) · [limits](https://docs.blockscout.com/devs/apis/requests-and-limits)
- [GeckoTerminal API](https://apiguide.geckoterminal.com/getting-started) · [Dexscreener API](https://docs.dexscreener.com/api/reference)
- [Envio HyperSync networks](https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks) · [Goldsky Robinhood](https://goldsky.com/chains/robinhood)
- [ENS deployments](https://docs.ens.domains/learn/deployments/) · [ENS primary names](https://docs.ens.domains/web/reverse/)

**Metrics & competitors**
- [GMGN wallet metrics](https://docs.gmgn.ai/index/wallet-detail-page) · [Mobula: detecting snipers & bundlers](https://docs.mobula.io/almanac/detecting-snipers-bundlers) · [Axiom Pulse filters](https://axiompedia.com/guides/trading/axiom-pulse-explained)
- [kolscan.fun](https://www.kolscan.fun/) · [robinscan.io](https://robinscan.io/leaderboard) · [hoodpools.com](https://www.hoodpools.com/) · [GeckoTerminal Robinhood](https://www.geckoterminal.com/robinhood/pools)

---

*Independent analysis, not affiliated with or endorsed by Uniswap Labs.*
