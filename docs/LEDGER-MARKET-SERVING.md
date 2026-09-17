# Serving the market from the aggregate ledger

The read API serves the screener's and the pool page's market figures from one
of two stores, chosen once at startup by `MARKET_SOURCE`:

- `broad` (the default, and what an unset variable means): the canonical broad
  rollups beside the deep publications (`docs/BROAD-MARKET-SERVING.md`),
  byte for byte as before this switch existed.
- `ledger`: the aggregate ledger's `agg_pool_hours` and `agg_pool_state`
  (`docs/AGGREGATE-LEDGER.md`) for every pool the ledger covers. Any other
  pool answers exactly as with `broad`.

Any other value refuses to start. The `listening` log line names the source in
effect. With `ledger`, `/ready` also checks read access to `agg_streams`,
`agg_batches`, `agg_pool_hours`, `agg_pool_state`, `agg_live_trades` and the
supply columns of migration 019. The code is `apps/api/src/ledger-market.ts`,
the ledger branches of `broad-explore.ts` and `projected-explore.ts`, and the
ledger cut in `observed-market-read.ts`. No endpoint is added.

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

## Before the switch is set

Migration 019 applied and the supply read run; the frontend reading
`completeWindow` and no longer rendering the pool page's removed deep panels;
and, at flip time, one same-instant comparison of the served 24h volume against
a third party for the same pools, recorded with both timestamps. The measured
statement timings and the volume comparison evidence are in the pull request
that added this switch.
