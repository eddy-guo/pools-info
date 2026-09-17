# Local lists and read-only trade signals

Watchlists and following remain browser preferences. There are no accounts,
signatures, account-synced lists or server-side personal profiles in this change.
The existing read API receives selected public wallet addresses for a lookup;
it does not save those selections as a user's follow list.

## Shareable watchlists

On Explore, star pools and choose Watchlist, then Copy watchlist link. The URL
contains `view=watchlist&watchlist=<pool IDs>` and preserves the current text
filter, window, sort and direction. It starts at the first results page.

Opening the link uses its selected pools without changing the recipient's local
stars. Save to my watchlist explicitly merges with the latest browser list.
My watchlist returns to personal stars. Legacy preferences and cross-tab updates
remain supported, including an explicitly empty saved list.

Links support at most 50 pool IDs and 4,096 URL characters. Sharing never silently
truncates. Invalid, repeated or oversized shared parameters produce an error and
an empty shared selection, never a fallback to unrelated personal stars. A
clipboard denial exposes a selectable link. Personal lists larger than the API's
200-ID read bound remain saved, with an explicit notice that the first 200 are
shown.

## Following activity

Follow a wallet from its profile, then open the Wallet directory. Following
activity shows up to 50 newest verified trades across the followed selection.
A wallet profile no longer opens this view for its own address: its Copy trade
action opens the designed copy-trading card as a read-only preview instead
(`apps/web/src/components/copy-trade-preview.tsx`), with every control
disabled and no order, wallet connection or backtest behind it.

Each row links to the wallet, pool and original transaction, shows the exact
underlying ETH amount and average execution price, and offers Open on Pools.
The latter opens the token page on pools.xyz. No trade is signed, submitted,
simulated or executed. The surface is informational, not advice.

Only attributed trades with supported wallet positions and matching current
accounting publications appear. Transaction initiators, unsupported accounting,
unfollowed wallets and projections that no longer match their source are
excluded. This is saved deep history, not all wallet activity or a real-time
chain feed. Row timestamps and newest/oldest returned pool cutoffs stay visible.

The browser checks the existing saved API every 30 seconds while visible and
unpaused. Polls wait for the previous request; there are no overlapping automatic
requests or browser RPC calls. Pausing stops automatic refresh, and removing the
last followed wallet unmounts and cancels its feed. Failed refreshes retain the
last matching dated rows with a visible error. Successful empty responses replace
those rows, including after a source rewind.

## API and evidence

`GET /v1/following?wallets=<addresses>&limit=50` accepts at most 200 unique,
normalized addresses and at most 50 returned trades. Malformed/duplicate query
parameters, duplicate addresses and oversized selections fail validation. Empty
selections do not query the global dataset.

One parameterized SQL read uses the indexed accounting wallet/trade relations.
Each wallet contributes at most `limit + 1` candidates before the global ordered
merge. Wei amounts stay integer-exact. Average execution price is computed as
`ethWei * 10^decimals / tokenRaw` with BigInt and rounded down to integer wei.
The response carries `scope: saved_verified_positions`, `supported: true` on each
returned row, partial coverage and per-row publication cutoffs. It has no PnL
calculation of its own and does not alter accounting or coverage cursors.

The API and web proxy do not cache these responses, so successful polls observe
source removal. The proxy validates wallet selection, identities, amount types
and attribution before serving a response. An unavailable API is an error for
this feature; it is never replaced by an invented empty preloaded feed.

## Validation

The real Postgres integration checks exact amounts above 2^53, supported and
unsupported attribution, unfollowed exclusion, ordering, limits, canonical-event
uniqueness, publication mismatch and source rewind. Browser tests cover delayed
loading, no overlapping polls, stale retention, pause/resume, empty replacement,
unmount cleanup, read-only wallet signals and unchanged personal follows.
Watchlist browser tests use fresh recipient contexts and cover explicit merge,
cross-tab state, URL filters, invalid input, limits and clipboard denial.

The combined local validation passed `pnpm check`, all 42 database tests with
zero skips, and all 82 desktop/mobile browser tests. Shared-link tests use the
accessible sort control because Next can retain a hidden streamed HTML copy.
