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
  `agg_wallet_windows` for the leaderboard ("The trader leaderboard" below).
  Any other pool answers exactly as with `broad`.

Any other value refuses to start. The `listening` log line names the source in
effect. With `ledger`, `/ready` also checks read access to `agg_streams`,
`agg_batches`, `agg_pool_hours`, `agg_pool_state`, `agg_live_trades`,
`agg_wallets`, `agg_wallet_windows`, `agg_window_refreshes` and the supply
columns of migration 019. The code is `apps/api/src/ledger-market.ts`, the
ledger branches of `broad-explore.ts` and `projected-explore.ts`, the ledger
cut in `observed-market-read.ts` and `ledger-leaderboard.ts`. No endpoint is
added.

## Which pools the ledger serves

The ledger's cut is its stream cursor (`agg_streams`): block, hash and
timestamp, which must be the newest committed batch's end (`agg_batches`).
A ledger with no cursor or no pool hour has folded nothing and every pool
answers as with `broad`.

A pool is covered when it launched between the ledger's start block and its
cursor and the ledger's own launch lane registered it
(`pool_launch_sources.stream_key = 'launches:agg:v1'`) in a batch at or below
the cursor. Every swap of a covered pool since launch is folded, so a covered
pool with no `agg_pool_state` row has proven zero trades. A covered pool is
served from the ledger unless a deep publication is newer than the ledger's
cursor (the newest-cutoff rule the broad and deep sources already follow); a
pool launched past the cursor, a recent-only catalog row, or a pool with a
newer deep publication answers as with `broad`.

## Windows

A window is whole UTC hours ending with the newest hour the pool hours hold
(`max(hour)` in `agg_pool_hours`): 24h is hours newest-23 through newest, 7d
the last 168 and 30d the last 720. The cutoff reported with every figure is
the ledger's cursor, inside that newest hour, and `windowStart` is the first
hour's start, so a label always spans the ledger's own last hours and never a
stale capture's minutes. The newest hour holds only the minutes up to the
cursor, so a 1h window of one bucket would be a bucket-rounded figure under an
hour's name: the ledger serves no volume, trade count or change for 1h, and
its `completeWindow` is false. All is the pool's whole history.

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
  lifetime totals). A covered pool with no trade in the window has a proven
  `"0"` and `0`.
- **Change**: the latest price state against the close of the pool's last
  hour before the window, to the hundredth and truncated toward zero, taken
  from the sqrt prices themselves. Exactly 0 when the pool traded before the
  window and not inside it. Null for All, for 1h, and when the pool's first
  hour is inside the window: a change since launch is never labelled with a
  window the series does not span.
- **completeWindow**: price and volume are served and the pool either
  launched inside the window or has its pre-window close. The screener must
  read it: a false flag means the row's figures do not cover the window.
- **Candles** (`market.history`, `intervalSeconds: 3600`): one per pool hour,
  the newest thousand. An hour opens at the previous hour's close (or its own
  first swap's state for the pool's first hour); its high and low prices are
  the lowest and highest sqrt among that opening state and its swaps.
- **Observations**: the pool's newest fifty trades still in the ledger's live
  ring (`agg_live_trades`, its last 24 hours or 250,000 rows).
- **FDV** (`market.fdvWei`, pool page only): the served price times the
  token's measured `indexed_pools.token_total_supply_raw` (migration 019) over
  `10^decimals`, null until the supply has been read. The supply is written by
  `pnpm supply:read run`, a Multicall3 read of `totalSupply()` over the public
  RPC with the block it was read at (`token_supply_block`); see
  `docs/LEDGER-CUTOVER.md`.
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

## Failure behaviour

With `ledger`, a cursor that is not the newest batch's end, a batch timestamp
that disagrees with the cursor, or a pool hour that starts after the cursor
answers `503 market_evidence_invalid`; a deep publication at the cursor block
with a different hash or time answers `503 market_identity_conflict`. The
broad source is unaffected by any ledger row.

## The trader leaderboard

`GET /v1/leaderboard` is served from `agg_wallet_windows`
(`packages/db/src/ledger-windows.ts`): one row per wallet per window, summed
by the tip loop from whole UTC hours ending with the ledger cursor's hour,
with the top of the board by realized already ranked. The response is the
accounting board's, field for field; what its values mean changes:

- **The board is the top 100 per window and nothing beyond** (captain, 17 Sep
  2026). `total` is the eligible wallets up to 100, `nextOffset` is null once
  100 rows are reachable, and `offset` plus `limit` past 100 answers 400
  `invalid_offset` rather than a page of unranked rows. The broad source keeps
  its deeper pages.
- **Eligible** is the writer's rule: at least 10 supported trades in the
  window on a supported position, the predicate migration 020's partial index
  carries. `minTrades=10` and `metric=realized` (the website's default; it
  never sends a gate) read the writer's own `rank` off the rank index, one
  probe per address, and `total` is the refresh's ranked count. Any other gate or metric orders the
  same eligible rows the same way (realized or net descending, the address
  breaking ties, so the realized order equals the materialised ranks whenever
  the gate is 10) and counts them up to 100; the page's last figure bounds
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
  any gate or metric, a transfer to another wallet costs that position's
  coverage rather than booking a loss, and the wallet page's header, read
  from the same window row, agrees with the board to the wei.

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
`metric=net` has no index and reads the window's whole eligible set through
the partial index (about 8,600 heap pages on All, 5,300 on 30d, 27 to 46 ms
warm); a gate under 10 reads the window's rows without an index. The warm
set for a cutover (`docs/LEDGER-CUTOVER.md`) is therefore the four default
boards, the four `metric=net` boards, and explore's catalog count.

## The wallet page

`GET /v1/wallets/:address?window=` is served from the ledger by
`apps/api/src/ledger-wallet.ts`: the summary from the wallet's row in
`agg_wallet_windows` for the window, the very row the board above ranks, so
the page's headline equals the board's figure to the wei at the same cursor;
the positions from `agg_positions` (the fold's whole state per pool, one row
per pool the wallet ever traded or received tokens in) joined to
`indexed_pools` for the identity and to `agg_pool_state` for the mark. The
response is the accounting reader's, field for field; what its values mean:

- **`wallet`** is the board row with its meanings ("The trader leaderboard"
  above): `rank` 1 to 100 or null, and null is not "unranked" copy but no
  rank at all; `last` the wallet's last activity across its positions, the
  same in every window. A wallet the ledger knows that has no hour in the
  window has no row in it and reads as zero activity in the window (realized,
  net and volume `"0"`, counts 0, `roi`, `bestWei` and `avgHold` null) with
  its lifetime position counts and last activity. A wallet the ledger has
  never attributed a swap or transfer to is the empty profile the accounting
  reader serves for an unknown wallet. `asOf` and `oldestAsOf` are the
  window's refresh cursor, `completeWindow` true.
- **`wallet.unrealizedWei`** is the page's own addition to the board row: the
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
  `investedWei`, `proceedsWei`, `buys`, `sells`); `asOf` and `throughBlock`
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
  per sale (design decision D3), so the Trades tab reads 0 and no trade-share
  link is emitted. It is never served from the frozen accounting tables,
  which would put two worlds on one page.
- **`launches`** are catalog rows whoever serves the page, the same
  statement as before.

Failure behaviour is the board's: a ledger with no cursor or no pool hour
answers as with `broad`; a window without a refresh row answers 503
`wallet_refresh_pending`; a refresh past the cursor 503
`market_evidence_invalid`.

Cost: one unique-index probe for the `wallet_ref`, one primary-key probe on
`agg_wallet_windows` (or one `agg_positions_wallet` range for the position
stats when the window has no row), and for the positions one
`agg_positions_wallet` range with one `indexed_pools` and one
`agg_pool_state` probe per position plus one `agg_wallet_hours` primary-key
range grouped per pool; the busiest ranked wallet on the 17 Sep copy has
3,070 hour rows and 23 positions, the widest a few thousand positions, which
the 500 cap bounds on the wire but not in the mark's sum. The curve is one
more `agg_positions_wallet` range (the supported positions) with one
`agg_wallet_hours` primary-key range per position, grouped per hour and
summed in one window pass: 3,176 shared buffers and 4 ms warm for that
busiest wallet on All (823 sale hours from 3,031 hour rows), plus one
`min(hour)` over the same ranges on All. Warm on the production-shape copy
(Postgres 18): 15 to 45 ms end to end for a top-100 wallet, 150 ms cold. The
current production reader warm set is owned by `docs/DATABASE-WARMING.md`.

## The creators aggregate

`GET /v1/creators` (`apps/api/src/creators-read.ts`) measures a launch by the
rule that gives an explore row its window volume (`rankedFlowCtes`), so with
`ledger` it follows the switch as explore does: every launch the ledger
covers, under "Which pools the ledger serves" above and whose deep
publication, if any, is no newer than the cursor, is measured from the
ledger's pool hours and state (the window's whole hours, or the state's
lifetime totals for All; a covered launch with no swap is a proven zero, so it
is measured and not traded), and every other launch keeps the broad rule.
`1h` is a window whole hours cannot answer, so a covered launch is unmeasured
under it. A ledger that has folded nothing yet changes no byte.

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
rule, and the response's `note` says which rule applies. The set is found by
one `agg_wallets` lookup per launch sender and one `agg_positions`
primary-key probe per launch, held on that probe by a `LATERAL ... LIMIT 1`:
the wallet index's plan read 1.3M buffers with two parallel workers and a
temp spill where this reads one index page and one heap page per launch.

Those probes read the position heap at random, so the read carries them for
the creators it serves and no others: the ranking statement measures the whole
catalog without the flag, and a second statement, bound to the page's launch
senders, answers `bool_or(own) FILTER (WHERE volume IS NOT NULL)` for them.
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

The failure evidence is a three-part causal chain. At
2026-09-24T12:58:21Z production logged
`event=database_warming reason=product_statement_cancelled`, immediately
followed by `event=read_failed route=creators code=57014 ms=3044`. On the
fully cold local production-shaped copy, creators took 2,481-2,818 ms while
the precomputed trader board took 19-22 ms and the busiest pool page took
78-88 ms. The disconfirming result was that a host-wide cold penalty would
have taken the two controls into seconds too; neither did, cold-first or after
creators. The creators ranking spent 2,436 ms of one 2,537 ms read in one
statement, with 2,180 ms in its `ledger_own` hash alone. Finally, the
deterministic scale regression fails before this rule with 62,031 own-buy
probes for a page containing 103 launches, and passes when the served plan can
probe no more than those page launches. That plan-scope assertion, rather than
a machine-speed or cache-temperature wall-clock assertion, prevents the
root-cause mechanism consistently across runners.

The alternatives were measured on that same cold copy before choosing the
page-scoped query:

| Alternative                                                                          | Measured result                                      | Tradeoff and decision                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page-scoped own-buy evidence                                                         | 351-906 ms cold; 211-411 ms warm                     | No new storage or migration, scales with the served page, and was chosen.                                                                                                                                                                                                                            |
| Partial covering index on `agg_positions(chain_id,pool_ref,wallet_ref) WHERE buys>0` | 962-1,009 ms cold; 56 MB                             | Faster than the old query but still catalog-scaled, and requires a migration. The local candidate index was dropped.                                                                                                                                                                                 |
| Precompute/cache like traders                                                        | Existing `agg_wallet_windows` control: 19-22 ms cold | An equivalent creators rollup requires a migration, writer work, and a refresh path. Merely adding creators to the warm set is not a fix: the old 2,481-2,818 ms cold read approaches or exceeds `warmPolicy.servingMs` at 2,800 ms, so warming can mark it slow and keep the readiness gate closed. |

No index, migration, precompute path, cache, timeout increase or production
change is part of this rule.

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
own-buy probe never reaches past the page's own launches (62,031 probes against
the page's 103 before this rule). The population walk (the
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
