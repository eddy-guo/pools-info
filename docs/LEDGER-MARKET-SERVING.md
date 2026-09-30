# Serving the market from the aggregate ledger

The read API serves the screener's and the pool page's market figures, and
the trader leaderboard, from one of two stores, chosen once at startup by
`MARKET_SOURCE`:

- `broad` (the default, and what an unset variable means): the canonical broad
  rollups beside the deep publications (`docs/BROAD-MARKET-SERVING.md`) and
  the accounting tables behind the leaderboard, byte for byte as before this
  switch existed.
- `ledger`: the aggregate ledger's `agg_pool_hours` and `agg_pool_state`
  (`docs/AGGREGATE-LEDGER.md`) for every pool the ledger covers, and its
  `agg_trader_windows` for the leaderboard ("The trader leaderboard" below).
  Any other pool answers exactly as with `broad`.

Any other value refuses to start. The `listening` log line names the source in
effect. With `ledger`, `/ready` checks the required tables and columns; the
deployment access requirements are in [the API README](../apps/api/README.md).
The code is `apps/api/src/ledger-market.ts`, the ledger branches of
`broad-explore.ts` and `projected-explore.ts`, the ledger
cut in `observed-market-read.ts` and `ledger-leaderboard.ts`. No endpoint is
added.

## Which pools the ledger serves

The main ledger's cut is its stream cursor (`agg_streams`): block, hash and
timestamp, which must be the newest committed batch's end (`agg_batches`).
A ledger with no cursor or no pool hour has folded nothing and every pool
answers as with `broad`.

An Instant pool is covered when it launched between the ledger's start block and its
cursor and the ledger's own launch lane registered it
(`pool_launch_sources.stream_key = 'launches:agg:v1'`) in a batch at or below
the cursor. Every swap of a covered pool since launch is folded, so a covered
pool with no `agg_pool_state` row has proven zero trades. A covered pool is
served from the ledger unless a deep publication is newer than the ledger's
cursor (the newest-cutoff rule the broad and deep sources already follow); a
pool launched past the cursor, a recent-only catalog row, or a pool with a
newer deep publication answers as with `broad`.

Crowd pools use a separate stream and a matching-cursor serving gate. Their
catalog membership, unmeasured state and accounting rule are in
[Crowd launches](CROWD-LAUNCHES.md).

## Windows

The 6h, 24h, 7d and 30d windows cover whole UTC hours ending with the newest
pool hour (`max(hour)` in `agg_pool_hours`): 24h is hours newest-23 through
newest, 7d the last 168 and 30d the last 720. The cutoff reported with every
figure is the ledger's cursor, inside that newest hour, and `windowStart` is
the first hour's start, so a label always spans the ledger's own last hours
and never a stale capture's minutes. All is the pool's whole history.

1h is the rolling hour instead: the swaps from the cursor's time less 3,600 s
(inclusive, its `windowStart`) through the cursor, read from the live ring
(`agg_live_trades`, `ledgerHour` in `apps/api/src/ledger-market.ts`). Whole
hours cannot answer it, since the newest hour holds only the minutes up to the
cursor (three minutes of trading at 09:03 under an hour's name). The ring is
written in the same transaction as the hours it mirrors and pruned only from
its oldest end (24 hours ending at the cursor, with the row cap in
`docs/AGGREGATE-LEDGER.md` under **The live ring**), so it always holds every
swap after its oldest row; walk-back removes a batch's rows with the batch,
and the tip loop resumes from its cursor, so a restart leaves
no gap. Its reads are ranges of the ring's block index, bounded by the batches'
end times rather than scanned. The age prune removes only trades older than
the cursor less 24 hours, before the rolling hour's first UTC hour. The ring
covers that hour when its oldest row predates it or the ring holds fewer than
the configured row cap. If the oldest row falls inside the hour and the ring
is at its row bound, 1h serves no volume, trade count or change and its
`completeWindow` is false.

## Figures

- **Price** (`stats.priceWei`, `market.priceWei`): wei per whole token from
  `agg_pool_state.sqrt_price_x96`. Every pool is keyed currency0 = native ETH
  and currency1 = the token, so one whole token costs
  `2^192 * 10^decimals / sqrtPriceX96^2` wei, truncated; the same conversion
  the broad and raw paths apply, with the decimals from `indexed_pools`. One
  price per pool: an explore row the ledger serves returns `market: null`,
  `processed: false` and null deep `asOf`, `throughBlock`, `generatedAt` and
  `sourceKind`, and its pool response returns `analytics: null`, because the
  deep publication it outdates carries an older price, candles and trades that
  the page would otherwise prefer.
- **Volume and trades**: the window's hours summed (All reads the pool state's
  lifetime totals, 1h the rolling hour's swaps in the ring). A covered pool
  with no trade in the window has a proven `"0"` and `0`.
- **Change**: the latest price state against the close of the pool's last
  hour before the window, to the hundredth and truncated toward zero, taken
  from the sqrt prices themselves. For 1h the baseline is the pool's last
  swap before the rolling hour's start: from the ring when it is inside the
  start's UTC hour, else the close of the pool's last hour before that one.
  Exactly 0 when the pool traded before the window and not inside it. Null
  for All, and when the pool launched inside the window: a change since
  launch is never labelled with a window the series does not span.
- **completeWindow**: price and volume are served and the pool either
  launched inside the window or has its pre-window close. The screener must
  read it: a false flag means the row's figures do not cover the window.
- **Candles** (`market.history`, `intervalSeconds: 3600`): one per pool hour,
  the newest thousand. An hour opens at the previous hour's close (or its own
  first swap's state for the pool's first hour); its high and low prices are
  the lowest and highest sqrt among that opening state and its swaps.
- **Observations**: the pool's newest fifty trades still in the ledger's live
  ring (`agg_live_trades`; retention is defined in `docs/AGGREGATE-LEDGER.md`).
- **FDV** (`market.fdvWei`, pool page only): the served price times the
  token's measured `indexed_pools.token_total_supply_raw` (migration 019) over
  `10^decimals`, null until the supply has been read. The supply is written by
  `pnpm supply:read run`, a Multicall3 read of `totalSupply()` over the public
  RPC with the block it was read at (`token_supply_block`); see
  `docs/LEDGER-CUTOVER.md`. The supply itself is served beside it as
  `market.supplyRaw` on every pool market response (raw token units, null
  when the pool is unindexed or its supply has not been read), so a holding's
  share of supply is `quantity / supplyRaw` when supply is nonzero, rather
  than a lossy `fdvWei / priceWei`.
- **Creator fee** (`market.creatorFees`, pool page only, optional): whether
  the deployment that launched the pool takes creator fees, from
  `indexed_pools.creator_fees` (migration 021, written by the launch lane at
  discovery), or, where that column is null on a row written before it
  existed, from the deep publication the ledger outdates. The key is absent
  when neither holds a real boolean: an unknown flag is never served as
  false, because "Disabled" is a claim about someone's money. Rows written
  before the column are filled by `pnpm creator-fees:backfill`
  (`docs/LEDGER-CUTOVER.md`, "Creator-fee flags").

Not served from the ledger: holders and liquidity keep today's values (both
are being removed from the product; `agg_pool_state.liquidity` is raw active
liquidity L, not ETH). `marketCoverage.rawPrice` and `priceBaseline` are null
because the ledger keeps no block hash for a pool's price states. The unit
basis is the ledger's cutoff (`source: "aggregate_ledger"`); a verified deep
snapshot that declares other decimals is a units conflict and suppresses the
price, change, candles and FDV.

## Explore cold read after removing the frozen trade scan

The explore rank (`rankedFlowCtes`), the served page's metrics and the creators
read now probe `analytics_accounting_trades` only for launches whose deep
publication supplies the figure. This still includes a deep publication newer
than the ledger cursor; a ledger-served or broad-served figure skips the frozen
trades. The old catalog-wide aggregate scanned the table even when every
served launch used ledger figures. On a restored production copy with
PostgreSQL 18, OS cache evicted before each round and system load 5-11, the
unfiltered home screener measured:

| Measure                               |     Before |      After |
| ------------------------------------- | ---------: | ---------: |
| Home screener volume read             | 316-360 ms | 224-234 ms |
| Volume-rank statement                 | 227-247 ms | 123-126 ms |
| Volume-rank blocks read               |     15,749 |      2,045 |
| Both screener statements, blocks read |     20,393 |      6,653 |
| Frozen trade-table blocks read        |     13,779 |          0 |

All 525 compared responses were byte-identical. These are cold measurements
on the restored copy, not a latency guarantee for the live service.

## Failure behaviour

With `ledger`, a cursor that is not the newest batch's end, a batch timestamp
that disagrees with the cursor, or a pool hour that starts after the cursor
answers `503 market_evidence_invalid`; a deep publication at the cursor block
with a different hash or time answers `503 market_identity_conflict`. The
broad source is unaffected by any ledger row.

## The trader leaderboard

With `MARKET_SOURCE=ledger` and a ledger cut, `GET /v1/leaderboard` is served
from `agg_trader_windows`; production has served from the ledger since
18 Sep 2026. With `MARKET_SOURCE=broad`, or in ledger mode before the first
cut, the accounting fallback still ranks own-launch positions and contracts
the old way. The exclusions below apply to the ledger board.

The ledger board reads `agg_trader_windows`
(`packages/db/src/ledger-windows.ts`): one row per wallet per window, summed
by the tip loop from whole UTC hours ending with the ledger cursor's hour,
with the top of the board by realized already ranked by the writer. The
response is the accounting board's, field for field; what its values mean
changes:

- **Who is a trader** (decided 28 Sep 2026, migration 025). A wallet's
  trader row is its window sums without every position in a pool it launched
  itself (the pool's `launch_sender`, the creator the creators board
  credits): a launcher's buy sits inside its own launch transaction and its
  sales go to the buyers who follow, a creator's take that the creators
  board already shows. On the 27 Sep production backup 43 of the 7d top 100
  and 42 of the All top 100 traded nothing but their own launches (the 7d #1
  to #5 made 98 to 58 ETH that way at a 100 percent win rate), and two more
  All wallets stood on theirs (#10: 66.05 ETH, 0.96 ETH of it on others'
  launches). The trade floor counts the trader row's supported trades alone,
  so a launcher cannot clear it on its own launches' trades (273 All wallets
  would have, none into the top 100 that day). The wallet's own row, its
  profile, keeps every position, and a wallet with no launch of its own has
  the same trader row as its own row, so its figures are unchanged; its rank
  can move when other wallets are excluded. An observed contract leaves the
  ledger board: the api's census reads the code of each wallet the board
  could show that the ledger never saw send a
  swap (every attributed swap of every position it holds went to it as the
  counterparty; a contract never sends a transaction), and one whose code is
  not an EIP-7702 delegation designator (`0xef0100` and a 20-byte delegate)
  is a contract. A delegated wallet is still an externally owned one, however
  its gas is paid: All #67 of 27 Sep (#32 once the launchers left),
  `0x33b6…c577`, is a wallet delegated to Uniswap's Calibur whose every swap
  is relayed, and stays. The census
  runs in the api (`apps/api/src/trader-contracts.ts`, the api holds the
  explorer key): immediately after start and every 5 minutes, over the exact
  union of wallets servable in any window, realized or net order, trade gate 0-999,
  and offset page within the top 100. After the running top 100 fills, its
  index probe jumps past trade gates whose best metric cannot enter it. It
  reads only bounded gate-index pages,
  then reads the due wallets'
  code with `eth_getCode` through the explorer's JSON-RPC gateway, five
  addresses a 20-credit call and at most 25 addresses a run, never while
  the key's stated balance (`x-credits-remaining`) is under 30,000 or past
  four fifths of the api's own daily cap, and never retrying a failed call
  inside a run. The last fifth of local credits is reserved so the census
  cannot starve the live Trades tab and Following, which share that key.
  `wallet_code_observations` keeps each answer. Migration 025 seeds only
  `0x91f99c026126f60a35c4306cb288388848b48faf`, whose contract bytecode
  was verified in the 27 Sep board spot-check, so the first ledger read
  excludes it. If the explorer key is absent or the credit floor stops the
  census, a newly arriving contract stays visible until checked; the board
  never removes a wallet on a guess. Empty code and EIP-7702 designators are
  both stored as `none` and read again after a week while the board could
  still show the wallet. Subsequent ledger board and wallet-rank reads
  exclude observed contracts without a ledger refresh; a cached response
  can retain one for up to five seconds. Their rows stay. On the 27 Sep
  backup the servable union held 2,312-2,331 wallets across the recorded
  cuts, 46 of which had never initiated a swap
  (10 calls, about 200 credits). A whole-trader census would have considered
  287,798 ranked wallets and read 62,208 non-initiators (12,442 calls,
  about 248,840 credits), beyond the shared key's 100,000-credit daily cap.
  Before the gate jump, the full candidate read on the 2,331-wallet cut
  took 850-975 ms warm with about 128,600 shared-buffer hits on the 27 Sep
  production copy; the sweep visited 943 gates in All, 750 in 30d, and 445
  in 7d. In a worktree-local projection of that copy with the queried rows
  and indexes, the exact 2,331 wallet refs were unchanged after the jump;
  its warm full candidate read fell from 765-798 ms and 139,781 buffer hits
  to 459-479 ms and 103,067 hits. Those local timings do not establish the
  latency on production's slower CPU and 1.5 GB memory trial.
  On the 27 Sep production copy with the gate jump, the full candidate read
  took 536-594 ms warm and about 92,500 shared-buffer hits for the same
  2,331-wallet servable union.
  The first servable census found three contracts: All #31 `0x91f9…8faf` (15,739
  bytes; a market maker many wallets call, 44,992 relayed swaps), a
  13,587-byte contract on the 6h and 24h boards, and a 6,718-byte one on the
  6h net board.
- **The board is the top 100 per window and nothing beyond** (captain, 17 Sep
  2026). `total` is the eligible wallets up to 100, `nextOffset` is null once
  100 rows are reachable, and `offset` plus `limit` past 100 answers 400
  `invalid_offset` rather than a page of unranked rows. The broad source keeps
  its deeper pages.
- **Eligible** means at least the requested `minTrades` supported trades in
  the window on a supported position of the trader row, and no observed
  contract. Every order and gate, including the default realized board,
  applies that rule at read time. The wallet page computes the same realized
  rank from the current top 100. The page's last figure bounds
  the candidates first, as the writer's `rankWindow` does, so the tie-break
  sort touches a page of rows rather than the window's whole eligible set.
- **Figures**: `realizedWei` is proceeds minus disposed cost of the window's
  sales at average cost, with basis carried in from before the window (a
  token bought last week and sold today realizes against last week's cost);
  `netWei` is the window's own cash out minus cash in; `roi` is realized over
  the window's disposed cost, null when nothing bought was sold and never a
  percent of a zero basis (a sale of tokens received by transfer is on an
  excluded position and reaches neither figure); `wins`/`losses` count closed
  inventory cycles by their gain; `avgHold` is the closed cycles' hold time;
  `bestWei` the best single sale; `tradeCount` every attributed swap and
  `supportedTradeCount` those on supported positions; `last` the wallet's
  last activity across its positions (the same in every window).
  `supportedPositionCount` and `excludedPositionCount` are the row's counts,
  summed at its refresh; `excludedByFlag` breaks the excluded
  count down by excluding flag (`zero_cost_inflow`, `unattributed_outflow`,
  `unknown_basis`, `unattributed_swap_activity`, the keys
  `ledgerExcludingFlags` lists), counted from the trader's `agg_positions`
  as the row is served, excluding positions in pools the wallet launched
  itself, just as the board's figures and position totals do. A position
  carrying several flags counts under each, and a flag no position carries
  is 0. The counts can sum past the row's total because of multiple flags or
  positions excluded since its refresh (about a minute).
  It is null on the accounting fallback, which classifies no exclusion by
  ledger flag. The website discloses the `unattributed_swap_activity` count
  on the row and on the wallet header as "N positions excluded (pooled or
  unattributed swap)": a sell pooled with other wallets' tokens through a
  batch contract can give a position that flag, but a pooled buy and a
  transaction with several swaps of one pool are left unattributed the same
  way, so the label names the flag's whole meaning rather than a sale.
  `unrealizedWei` is null on every row: it needs a price per position and is
  the wallet page's figure. `asOf` and `oldestAsOf`, on the coverage and on
  every row, are the cursor the window's rows were summed to
  (`agg_window_refreshes.through_timestamp`, at most a refresh interval behind
  the ledger cursor), and `completeWindow` is true, since the ledger folds
  every swap since launch. `coverage.pnlScope` is
  `attributed_positions_all_pools` and `processedPools` the pools with a
  trade (`agg_pool_state`).
- **Windows** are hour-aligned as the pool figures are: 24h is the 24 whole
  hours ending with the cursor's hour, so a wallet whose trades sit in the
  window's first hour leaves the board when the cursor's hour moves. 1h and
  6h are served from their own rows (the tip loop refreshes all six).
- **Population**: the accounting board ranked wallets on the 1,364 deep-tier
  pools whose captures stop minutes after launch and excluded every
  wrapper-routed position; the ledger's board ranks every attributed wallet on
  every pool with a trade, and its top 100 shares no wallet with the old
  board's on any window (`docs/LEDGER-CUTOVER.md`, "The trader leaderboard:
  the old board beside the new"). A position that received tokens without a
  swap of its own (`zero_cost_inflow`), or sent them away without one
  (`unattributed_outflow`), is excluded at the fold since migration 022
  (design decision D2, taken 18 Sep 2026): its swaps are trades and volume
  on the row, never supported trades, wins, spent, realized or disposed
  cost, so a wallet with nothing but such positions stands on no board under
  any gate or metric, and a transfer to another wallet costs that position's
  coverage rather than booking a loss. The wallet page's header agrees with
  the board to the wei for every wallet with no launch of its own.

Failure behaviour: a ledger with no cursor or no pool hour answers as with
`broad` (the accounting tables); a window without a refresh row, which a
walk-back leaves until the tip loop's next refresh, answers 503
`leaderboard_refresh_pending`; a refresh past the cursor answers 503
`market_evidence_invalid`.

Cold cost, measured on a production-shape copy (Postgres 18, 370k All rows,
86k eligible): the default board touches about 480 pages per window (the rank
index and one `agg_wallets` probe per row) plus the coverage's catalog count
(3,950 pages of `indexed_pools`, the same statement explore's coverage runs)
and the `agg_pool_state` count (1,559 pages); warm, 20 to 30 ms end to end.
`metric=net` reads the same eligible rows in net order off the net partial
index (migration 023's, on the trader rows since 025) (the realized index's predicate on `net_wei DESC`) and stops at
the page's last row, as the default board does off its rank. Before it, the
net board read the window's whole eligible set through the realized index and
sorted it: on the 27 Sep 2026 production backup (Postgres 18.6, 392k All
rows, 77.5k eligible), 6,706 pages for 7d, 8,727 for 30d and 18,843 with two
parallel workers for All, of which a cold restart read 1,307, 4,253 and
9,289 from disk; with the index every window reads about 510 pages, 171-177
of them from disk cold and none past a 16 MB `shared_buffers`, and the
index is 4 MB, built in 123 ms. Production had answered 7d and 30d net in
0.7-1.7 s under a 1.5 GB memory cap, against 148-187 ms uncapped, because the
tip loop's writes pushed those pages out between reads. A gate under 10 reads
the window's rows without an index. `docs/DATABASE-WARMING.md` owns the current
warm set. Since migration 025 the default board also probes each row's
trader row (about 1,030 pages warm on the 27 Sep backup against about 500
before) and both orders probe `wallet_code_observations` once per row they
pass; warm, every window and order answered in 11 to 23 ms through the
reader. The refresh keeps both row sets: a typical one-batch refresh took
40-47 ms on that backup against 128 ms and more before, and a refresh
whose hour moved 0.6-0.7 s against 2.9-3.2 s (the old per-row probe of the
hour index that decided which summed wallets had left a window, 2.9 s on
7d, is one hashed read now), and a full rebuild 27-30 s. Migration 025 fills
the trader rows and ranks in 14 s there. `excludedByFlag` adds one
correlated `agg_positions_wallet` range per served row, a scalar subquery
so the planner can read each served wallet's positions from the index instead
of hashing the whole table; the index includes `supported`.

## The wallet page

`GET /v1/wallets/:address?window=` is served from the ledger by
`apps/api/src/ledger-wallet.ts`: the summary from the wallet's row in
`agg_wallet_windows` for the window, with its rank on the board above, so
the page's headline equals the board's figure to the wei at the same cursor
for every wallet with no position in its own launches (the board leaves
those positions out, the profile keeps them);
the positions from `agg_positions` (the fold's whole state per pool, one row
per pool the wallet ever traded or received tokens in) joined to
`indexed_pools` for the identity and to `agg_pool_state` for the mark. The
response is the accounting reader's, field for field; what its values mean:

- **`wallet`** is the wallet's full row with the board's metric meanings
  ("The trader leaderboard" above); its figures can differ when it traded
  its own launches. `rank` is 1 to 100 or null, and null is not "unranked" copy but no
  rank at all; `last` the wallet's last activity across its positions, the
  same in every window. A wallet the ledger knows that has no hour in the
  window has no row in it and reads as zero activity in the window (realized,
  net and volume `"0"`, counts 0, `roi`, `bestWei` and `avgHold` null) with
  its lifetime position counts and last activity. A wallet the ledger has
  never attributed a swap or transfer to is the empty profile the accounting
  reader serves for an unknown wallet. `asOf` and `oldestAsOf` are the
  window's refresh cursor, `completeWindow` true. `excludedByFlag` has the
  same keys and counting rule as on the board row (above), but counts all of
  the wallet's positions, including its own launches, as the page is
  served. The window row and the no-window position stats use this same
  wallet-wide scope, so the header can disclose positions excluded for an
  unattributed swap.
- **`wallet.unrealizedWei`** is the page's own addition to the wallet row: the
  sum of the marks of every supported position (over the whole set, not the
  500 served), or null while any of them is unmarked. A position's mark is
  what its held units fetch at the pool's latest price state less their cost,
  `trunc(quantity_raw * 2^192 / sqrt^2) - cost_wei`, exact to the wei and
  truncated toward zero as `ledgerPriceSql` prices a whole token (the
  decimals cancel). A flat position marks at zero less its cost, zero under
  the fold's invariant, whatever the pool's price; a held one is unmarked
  while the pool's decimals are unknown (`indexed_pools.decimals` null, a pool
  the pass never read) or it has no price state. Mark-to-last-trade on a thin
  pool is a figure that could never be realized, as it was on the accounting
  reader.
- **`positions[]`** are in pool-id order, the first 500 with
  `positionsTruncated` past them: `realizedWei`, `netWei` and `volumeWei` are
  the window's own figures per pool, summed from `agg_wallet_hours` from the
  refresh's own first hour so they sum to the summary's; `position` is the
  fold's lifetime state (`quantity`, `costWei`, lifetime `realizedWei`,
  `investedWei`, `proceedsWei`, `buys`, `sells`, and since migration 027
  `boughtRaw` and `soldRaw`, the token units bought and sold through the
  position's attributed swaps, so `investedWei / boughtRaw` and
  `proceedsWei / soldRaw` are its exact average entry and exit prices, both
  null on a position written before the fold recorded them, never a partial
  count) with its times: `openedAt`,
  when its open inventory cycle began (`cycle_opened_at`, unix seconds; null
  while flat), and `firstHour` and `lastHour`, the UTC hours of its first and
  last attributed swap as unix seconds at the hour's start, from the same
  pass over its hour rows as the window's sums, the honest bounds of a closed
  position's span, since the ledger keeps swaps per hour and no first swap
  time; `asOf` and `throughBlock`
  are the ledger cut on every position (there is no per-pool capture cutoff
  any more); `decimals` is `indexed_pools.decimals`, null when unread, never
  defaulted. An excluded position (`supported` false, an excluding flag among
  `flags`) serves its counts, its volume and null for every finance and for
  `position`, as before; the fold keeps its numbers, the reader never serves
  them.
- **`curve`** is the accounting reader's per-sale curve at the ledger's hour
  grain, the same `{time, wei}` points: for a wallet with a supported
  position, a leading zero at the window's start (the window's first whole
  hour; on All, the start of the first hour the wallet traded a supported
  position in), then the cumulative realized in the window at the end of
  each hour with a sale on a supported position (`agg_wallet_hours` summed
  across pools per hour, from the refresh's first hour through the refresh's
  own hour), and the header's own `realizedWei` at the window's cutoff, so
  the chart's end equals the headline. A point sits at its hour's end, never
  before its sales; the refresh's own hour, still open at the cutoff, ends at
  the cutoff. An excluded position's hours are left out rather than drawn as
  flat points: they carry no finance (migration 022), so the sum is the
  header's either way, and a wallet whose positions are all excluded has no
  curve, as before. Past about 500 hours the points are sampled as the
  accounting reader sampled its sales, every k-th hour and the last, and
  `curveSampled` says so. Nothing is interpolated: a wallet whose hours the
  ledger has not folded has no point for them.
- **`trades`** is empty and `tradesTruncated` false: the ledger keeps no row
  per sale (design decision D3), and no trade-share link is emitted from this
  response. The Trades tab reads explorer history separately (see
  `docs/WALLET-TRADE-HISTORY.md`). The response is never served from the frozen
  accounting tables, which would put two worlds on one page.
- **`launches`** are catalog rows whoever serves the page, the same
  statement as before.
- **`pooledSwapsAttributedSince`** is the wallet page's disclosure of the
  rule change: the unix time since which every sell routed through a pooled
  swap, earlier ones included (the history is re-folded), is attributed to
  each contributor pro rata by the token it moved
  (`agg_streams.fold_rule_since`, set at the swap-in of a ledger folded
  under rule 2), or null while the served ledger folds under rule 1 or the
  swap-in date is not recorded yet. The page states the day in UTC beside
  the positions list, in the fixed-height row that holds Still held, and
  renders nothing there for null.

Failure behaviour is the board's: a ledger with no cursor or no pool hour
answers as with `broad`; a window without a refresh row answers 503
`wallet_refresh_pending`; a refresh past the cursor 503
`market_evidence_invalid`.

Cost: one unique-index probe for the `wallet_ref`, one primary-key probe on
`agg_wallet_windows` (or one `agg_positions_wallet` range for the position
stats when the window has no row), and for the positions one
`agg_positions_wallet` range with one `indexed_pools` and one
`agg_pool_state` probe per position plus one `agg_wallet_hours` primary-key
range grouped per pool, the window's sums filtered inside the aggregates
rather than under the scan (a `hour>=$2` predicate there steered the planner
onto migration 026's pool-first index and a filtered nested loop: 11,698
buffers and 20 ms against 3,077 and 3 ms for a 358-position wallet on the
production-shape copy, measured when the hour span joined the row on 29 Sep);
the busiest ranked wallet on the 17 Sep copy has
3,070 hour rows and 23 positions, the widest a few thousand positions, which
the 500 cap bounds on the wire but not in the mark's sum. The curve is one
more `agg_positions_wallet` range (the supported positions) with one
`agg_wallet_hours` primary-key range per position, grouped per hour and
summed in one window pass: 3,176 shared buffers and 4 ms warm for that
busiest wallet on All (823 sale hours from 3,031 hour rows), plus one
`min(hour)` over the same ranges on All. The breakdown's
`agg_positions_wallet` range runs inside the window-row statement (or the
position stats): on the 27 Sep backup (Postgres 18.6) it costs the 7d #1
trader (459 supported positions, 53 excluded) 1.0k shared buffers and
0.4 ms, and the widest wallet, `0x…dead` with 64,625 excluded positions,
12.9k buffers and 23 ms, the page answering in 50 and 240 ms warm.
Earlier measurements on the production-shape copy (Postgres 18) were 15 to
45 ms end to end for a top-100 wallet, 150 ms cold. The
current production reader warm set is owned by `docs/DATABASE-WARMING.md`.

### A single position

`GET /v1/wallets/:address/positions/:poolId?window=`
(`apps/api/src/ledger-position.ts`, `WalletPositionResponse` in
`packages/core/src/analytics-types.ts`) is the read behind the position PnL
card: one wallet-position, named by the wallet and the pool page's own
32-byte pool id (a wallet holds at most one position per pool; the plural
`wallets` form only, no singular alias), default window `All`. `position` is
the wallet page's row for that pool: the same `positionColumns`
over the same sources, the same cut and the same window start, mapped by the
same `walletPosition` in `ledger-wallet.ts`, so a consumer of the page reuses
its type, and `ledger-position.integration.test.ts` pins the two equal on
every window, under a units conflict and in a pool with unknown decimals
too: the mark in wei (`markSql`) does not depend on the decimals, so only
the figures per whole token are withheld without trusted units. Beside it
are the card's additional figures, null where the ledger cannot vouch for
them:

- **`pool`** is the catalog row (`CatalogPool`), the identity a card names the
  token by.
- **`mark`** is the price state behind `unrealizedWei` at the ledger cut:
  `sqrtPriceX96`, `priceWei` per whole token (`ledgerPriceSql`, null while
  the token's decimals are unknown, exceed 36, or a verified snapshot inside
  the ledger cut disagrees with indexed decimals), the swap that set it
  (`block`, `timestamp`, `txHash`) and `valueWei`, what the held units
  fetch at that price (`unrealizedWei + costWei`, `"0"` for a flat position,
  null for an excluded or unmarked one). Null when the pool has no swap
  folded. A newer deep publication can make the pool page's current price
  differ from this ledger-cut price.
- **`roi`** is the ledger's ROI as the board and the wallet header define it:
  lifetime realized over lifetime disposed cost (`investedWei - costWei` on a
  supported position, since an outflow excludes), in percent to four decimals
  truncated toward zero in integer arithmetic (`walletSummary`'s rule), null
  while nothing has been disposed. **`totalRoi`** is realized plus the mark
  over invested, the open position's whole return, null while unmarked; on a
  flat position the two are equal, since invested is then disposed cost.
- **`avgEntryPriceWei`** is the average entry price of the held units, wei
  per whole token: their average-cost basis (`costWei` times ten to the
  `decimals` over `quantity`, truncated), the price a card sets against
  `mark.priceWei`. Null while flat, excluded or the decimals are unknown or
  conflict with a verified snapshot or exceed 36. The fold keeps no count of raw
  token units bought or sold (only the held quantity, and no row per swap), so a
  lifetime average entry price and an average exit price cannot be derived
  and are not served; serving them would need a writer change, not a read.
- **`cycles`** is the position's inventory cycles over its whole history,
  never windowed: `openedAt`, when the open cycle began (`cycle_opened_at`,
  exact seconds; null while flat) and `openHoldSeconds`, how long it has
  been held at the cut (bounded at zero when block timestamps run backward),
  and from its hour rows the `closures`, summed
  `holdSeconds` (the closed cycles' hold time; the average is `holdSeconds`
  over `closures`, the header's `avgHold` per position). Null for an excluded
  position, whose inventory is not served.
  The nested `position.position` retains the wallet page's `openedAt`,
  `firstHour` and `lastHour`. The latter two bound a closed position's span at
  UTC-hour precision; there is no separate activity object or exact first-buy
  timestamp.

An excluded position answers `supported: false` with its flags, null finances
and no `position`, as the page does, and `mark.valueWei`, `roi`, `totalRoi`
and `cycles` null. A pool the catalog lacks answers 404 `pool_not_indexed` as
the pool route does; a wallet the ledger never attributed a swap or transfer
to 404 `wallet_not_found`; a wallet that never held or traded the pool's
token 404 `position_not_found`. A ledger that has folded nothing, or a
deployment on the broad source, answers 503 `position_coverage_unavailable`
rather than the frozen accounting tables; a window without a refresh row 503
`position_refresh_pending`, as the page's `wallet_refresh_pending`; a catalog
whose recent and indexed rows disagree on a pool's identity 503
`catalog_identity_conflict`, as the pool route answers. Caching
is the page's: `Cache-Control: no-store`, coalesced and cached in process for
five seconds.

Cost: the cut, the catalog identity check the pool route runs (a join of
`recent_pools` to `indexed_pools`, 0.04 ms warm on the copy, whose
`recent_pools` is empty), one catalog probe by pool id, one unique-index probe for the
`wallet_ref`, the window's refresh row, then one statement over one
`agg_positions` primary-key probe with its `indexed_pools` and
`agg_pool_state` probes and one `agg_wallet_hours` primary-key range (the
window's flow, the hours traded in and the lifetime closures in one pass),
then the coverage's two counts and the counterparty legs. On the production-shape copy (Postgres 18, 2.18M
positions, 3.06M hour rows, migrated through 026) the position statement
reads 14 to 15 buffers and runs in 0.04 to 0.06 ms warm, 1 to 2.5 ms on
first touch (8 to 10 buffers read from disk); the busiest wallet-pool pair
(879 hour rows) reads 702 buffers, 0.5 ms warm and 22 to 30 ms on first
touch. The route answers in 14 to 15 ms warm end to end, of which the coverage
envelope's two counts (the catalog's 3,952 buffers, about 9 to 14 ms, and
`agg_pool_state`'s 1,559, about 6 ms) are the bulk, the same envelope every
ledger read pays; a first read after a process start is 25 to 140 ms with
the pool's connection. Nothing here needs an index beyond the primary keys
migration 017 laid down.

## The creators aggregate

`GET /v1/creators` (`apps/api/src/creators-read.ts`) measures a launch by the
rule that gives an explore row its window volume (`rankedFlowCtes`), so with
`ledger` it follows the switch as explore does: every launch the ledger
covers, under "Which pools the ledger serves" above and whose deep
publication, if any, is no newer than the cursor, is measured from the
ledger's pool hours and state (the window's whole hours, or the state's
lifetime totals for All, or the rolling hour's swaps in the ring for 1h; a
covered launch with no swap is a proven zero, so it is measured and not
traded), and every other launch keeps the broad rule. While the ring does not
hold the rolling hour, a covered launch is unmeasured under 1h. A ledger that
has folded nothing yet changes no byte.

Once the ledger has folded, the response's existing `coverage` envelope is
the ledger coverage shared with wallet and leaderboard reads: its cursor time,
the count of pools with a trade in `agg_pool_state`, and
`pnlScope=attributed_positions_all_pools`. `broadMarketCutoff` remains specific
to a broad fallback cutoff and can therefore still be null. Before the ledger
has folded, the accounting coverage envelope remains byte for byte unchanged.

`boughtOwnLaunch` for a ledger-served launch is the ledger's attributed
evidence: a position of the launch sender in that pool with `buys > 0`
(`agg_positions`), that is, a buy attributed to that address by the
beneficiary rule of `planLedgerBatch` (the transaction's initiator when it
received the tokens, otherwise the one address that did), over the pool's
whole folded history. The broad and deep sources keep their sender-routed
rule, and the response's `note` says which rule applies. The flag is
found per sender: one `agg_wallets` lookup by address, then one
`agg_positions` primary-key probe per ledger-served measured launch, held on
that probe by a `LATERAL ... LIMIT 1` (the wallet index's plan read 1.3M
buffers with two parallel workers and a temp spill), stopping at the first
hit, since one own buy answers for the sender. A sender whose broad or deep
launches already hold an own buy, or who has no ledger-served measured
launch, is not probed at all. If the live ring cannot answer `1h`, no
ledger-served launch is measured in that window, so none is probed.

Those probes read the position heap at random, so the read carries them for
the creators it serves and no others: the ranking statement measures the whole
catalog without the flag, and a second statement, bound to the page's launch
senders, answers the flag for them.
The orders the route offers never read the flag, so the page is the same page
either way; asking for it over the whole catalog is what took the read past
its budget. On the restored production copy (62,896 launches, 2.18M positions,
ledger cursor 65,409,776, Postgres 18, `shared_buffers` 128 MB) with the
page cache dropped and the server restarted before every read, the
whole-catalog probe cost 2.1 s of the ranking statement's 2.4 s (260k buffers,
43,070 probes, `EXPLAIN (ANALYZE, BUFFERS)`) and the read took 2,481-2,818 ms
of its 3,000 ms statement budget on every window and sort; the page-scoped
probe takes 351-906 ms cold and 211-411 ms warm for the same eighteen, with
the two statements 284 ms and 457 ms of a cold 842 ms. Every window, sort,
direction and the second page answer byte for byte what the whole-catalog
probe answered.

Probing every launch of the page's creators was still what cost the largest
page. The top 100 by launches hold 14,727 launches (a few prolific launchers
dominate the order), so `window=All&sort=launches&limit=100` ran 12,463
random position probes and a sequential scan of all 428k `agg_wallets` rows
to hash them by address; production served it in 2.1-2.4 s uncapped with
the cache warm, and answered 503 at 3.6-3.7 s on both paced passes under a
1.5 GB memory cap, where the tip loop's writes keep the position heap out of
cache (each 57014 also closed the readiness gate for every visitor until the
next warm-up). 85 of those 100 creators bought one of their own launches, so
stopping at the first hit probes 1,081 launches instead. On the 27 Sep 2026
production backup (64,625 pools, 2.41M positions, Postgres 18.6,
`shared_buffers` 128 MB), the server restarted and every other database
streamed through the page cache before each read:

| Read (statement)                         | Before, cold              | After, cold              | Before, warm | After, warm |
| ---------------------------------------- | ------------------------- | ------------------------ | -----------: | ----------: |
| `All`, launches, 100 (whole read)        | 1,078 ms                  | 464 ms                   |       397 ms |      281 ms |
| `All`, launches, 100 (own-buy statement) | 790 ms, 12,630 disk reads | 183 ms, 1,564 disk reads |       185 ms |       69 ms |
| `All`, launches, 25 (whole read)         | 785 ms                    | 437 ms                   |              |             |
| `All`, launches, 25 (own-buy statement)  | 488 ms, 7,250 disk reads  | 143 ms, 1,161 disk reads |              |             |
| `1h`, launches, 25 (whole read)          | 713 ms                    | 339 ms                   |              |             |
| `1h`, launches, 25 (own-buy statement)   | 430 ms, 7,250 disk reads  | 113 ms, 1,161 disk reads |              |             |
| `1h`, launches, 100 (whole read)         | 1,212 ms                  | 410 ms                   |              |             |
| `1h`, launches, 100 (own-buy statement)  | 957 ms, 12,630 disk reads | 164 ms, 1,564 disk reads |              |             |

With `shared_buffers` at 16 MB standing in for cache pressure, the `All`
page of 100's own-buy statement fetches 11,663 blocks from outside the
cache against 28,593; what remains is the ranked launches' sequential scans
of the catalog tables the ranking statement reads too. The ranking
statement (about 230 ms cold, 190 ms warm, 3,392 blocks from disk cold) is
unchanged by the own-buy probe fix: it measures the whole catalog by design
and planned no parallel worker on that backup. The warm set's creators read
goes from 654 ms to 344 ms cold
and the whole warm set from 1,062 ms to 763 ms. Every window, sort,
direction and page answered byte for byte what the per-launch probe
answered, apart from `generatedAt`, on this backup and on the
production-shaped ledger copy of 17 Sep.

The own-buy statement runs with `max_parallel_workers_per_gather = 0`, set
`LOCAL` around it and restored to the server's value before the identity
lookup, independently of the earlier ranking guard. Its
planned shape was a `Gather` of two workers over a `Parallel Hash Left Join`,
and a page of 50 senders or more grew that hash past the shared memory the
`LedgerPostgres` container gives parallel query: production answered 53100
(`could not resize shared memory segment "/PostgreSQL.NNN" to 8388608 bytes:
No space left on device`, the proxy's `data_temporarily_unavailable`) for
`window=All` at `limit=50` and `limit=100`, failing at about 0.8 s, while the
same page at `limit=25` served in 855 ms cold and 173 ms warm and `limit=100`
on 1h, 24h, 7d and 30d served in 0.68-0.94 s. Serial, the probe plans inside
one backend's `work_mem` and asks the container for no segment at all, so the
page can no longer be refused one. It costs throughput, not correctness: on
the production-shaped ledger copy (62,657 launches, 2.18M positions, migration
022, Postgres 18.6, `shared_buffers` 128 MB), with the server restarted and
the 4.4 GB database evicted from the page cache before each round, the read
goes from 741 ms to 756 ms cold and 338 ms to 382 ms warm at `limit=25`, from
588 ms to 602 ms cold at `limit=50`, and from 621-1,322 ms to 716-1,323 ms
cold and 386 ms to 437 ms warm at `limit=100`; `limit=100` on 1h, 24h, 7d and
30d goes from 320-401 ms to 367-465 ms cold. The trader board (19 ms) and an
explore page (59-61 ms) are unmoved, and every response is byte for byte what
the parallel plan answered. The worst reading, 1.3 s, is 44% of the 3,000 ms
statement budget.

### Ranking statements and shared memory

The creators rank and ledger explore's volume, trades, change, liquidity and
gainers ranks also admit `Gather` plans. On a local copy of the 17 Sep
production-shaped ledger (62,896 pools, 166,334 pool hours, 2,175,993
positions), PostgreSQL 18.6 with parallel scan thresholds and costs set to
zero planned two-worker `Gather` nodes for each rank at the routes' 100-row
limit. Default local costs happened to plan serial scans; catalog growth or
statistics can change that choice. The ranking statements and their
empty-page count statements now set `max_parallel_workers_per_gather = 0`
locally inside the read transaction, then restore `DEFAULT` before the
page's other statements. The existing creators own-buy guard remains scoped
to its own later probe.

Paired warm reads on that copy, toggling only the new rank guard, gave these
end-to-end reader times in milliseconds. Each response compared byte for byte
after removing only `generatedAt`:

| 100-row read                  | Previous | Guarded |
| ----------------------------- | -------: | ------: |
| Creators All, launches        |      289 |     291 |
| Creators All, volume          |      273 |     266 |
| Creators All, median          |      271 |     262 |
| Explore All, volume           |      157 |     163 |
| Explore All, trades           |      160 |     162 |
| Explore 24h, change           |      139 |     144 |
| Explore 24h, liquidity        |       25 |      20 |
| Explore 7d, gainers by volume |       77 |      72 |

The largest observed increase was 6 ms for explore volume in these warm
paired runs. The first pass after copying the database is not a controlled
OS-cold comparison: copying and earlier reads changed the host's page cache.
The 62k-pool scale suite asserts the actual rank plans have no parallel node
under the same planner pressure, including empty-page counts, and keeps the
whole routes below its 2,000 ms read bound. The fix requires no response or
schema change.

The failure evidence is a three-part causal chain. At
2026-09-24T12:58:21Z production logged
`event=database_warming reason=product_statement_cancelled`, immediately
followed by `event=read_failed route=creators code=57014 ms=3044`. On the
fully cold local production-shaped copy, creators took 2,481-2,818 ms while
the precomputed trader board took 19-22 ms and the busiest pool page took
78-88 ms. The disconfirming result was that a host-wide cold penalty would
have taken the two controls into seconds too; neither did, cold-first or after
creators. The creators ranking spent 2,436 ms of one 2,537 ms read in one
statement, with 2,180 ms in its `ledger_own` hash alone. The deterministic
scale regression failed before page scoping with 62,031 own-buy probes for a
page containing 103 launches. It now checks the served plan against one probe
for each buying creator and each launch of a creator who never bought one.
That plan-scope assertion, rather than a machine-speed or cache-temperature
wall-clock assertion, prevents both whole-catalog and redundant per-launch
probing across runners.

The alternatives were measured on that same cold copy before choosing the
page-scoped query:

| Alternative                                                                          | Measured result                                      | Tradeoff and decision                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page-scoped own-buy evidence                                                         | 351-906 ms cold; 211-411 ms warm                     | No new storage or migration, scales with the served page, and was chosen.                                                                                                                                                                                                                            |
| Raising the database container's shared memory                                       | Not measured                                         | A plan and money decision on Railway; the captain's, and not taken here.                                                                                                                                                                                                                             |
| Chunking a large first paint into `limit<=25` requests in the website                | Not measured                                         | The fallback if the serial probe had been slow; it was not, so the read API keeps answering the page the URL asks for.                                                                                                                                                                               |
| Partial covering index on `agg_positions(chain_id,pool_ref,wallet_ref) WHERE buys>0` | 962-1,009 ms cold; 56 MB                             | Faster than the old query but still catalog-scaled, and requires a migration. The local candidate index was dropped.                                                                                                                                                                                 |
| Precompute/cache like traders                                                        | Existing `agg_wallet_windows` control: 19-22 ms cold | An equivalent creators rollup requires a migration, writer work, and a refresh path. Merely adding creators to the warm set is not a fix: the old 2,481-2,818 ms cold read approaches or exceeds `warmPolicy.servingMs` at 2,800 ms, so warming can mark it slow and keep the readiness gate closed. |

The earlier page-scoping change added no index, migration, precompute path,
cache or timeout increase. Migration 023 is for the separate net board read.

Response shape, ranking rule, the Launches column and every other field are
unchanged, and no row goes empty that was not empty before: under `broad` on
production's data (empty `broad_*` rollups, 1,364 deep publications) 28 of the
top 100 by launches had no measured launch; under `ledger` every one of the
100 is measured on every launch. The launch-order tie-break is the served
volume (`volumeWei DESC NULLS LAST`), so rows on an equal launch count may
swap places when their volumes change; the launch count at each rank does
not. On the production-shaped copy (62,896 launches, 2.18M positions, ledger
cursor 65,409,776) the read answers over HTTP in 351-906 ms cold and
211-411 ms warm across every window and sort. `ledger-market.scale.test.ts`
bounds every one of them at 2,000 ms on caches its own seeding left cold,
before its warm-up read, and asserts from the served statement's plan that the
own-buy probe stops at each creator's first own buy. The population walk (the
old and new top 100 by launches and by volume side by side) is
`scripts/creators-walk.mjs <old api origin> <new api origin>`, recorded in the
pull request that made the change.

## Before the switch is set

Migration 019 applied and the supply read run; the frontend reading
`completeWindow` and no longer rendering the pool page's removed deep panels;
and, at flip time, one same-instant comparison of the served 24h volume against
a third party for the same pools, recorded with both timestamps. The measured
statement timings and the volume comparison evidence are in the pull request
that added this switch.
