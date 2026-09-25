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

The feed's rows are each followed wallet's own trades as the chain explorer
lists them (see "API and evidence" below). The API supplies the wallet, buy
or sell, token identity, exact raw token amount, optional block time and
transaction hash for each row. The previous accounting-backed feed showed an
ETH amount and average execution price per trade; the explorer source supplies
neither. Whether trade lists
should show ETH amounts remains an open product question. No trade is signed,
submitted, simulated or executed. The surface is informational, not advice.

The browser checks the Following API every 30 seconds while visible and
unpaused. Polls wait for the previous request; there are no overlapping automatic
requests or browser RPC calls. Pausing stops automatic refresh, and removing the
last followed wallet unmounts and cancels its feed. Failed refreshes retain the
last matching dated rows with a visible error. Successful empty responses replace
those rows, including after a source rewind.

## API and evidence

`GET /v1/following?wallets=<addresses>&limit=50` accepts at most 200 unique,
normalized addresses and at most 50 returned trades. Malformed/duplicate query
parameters, duplicate addresses and oversized selections fail validation. An
empty selection reads nothing.

The feed is the explorer's per-swap trade list of each followed wallet, the
same code path, cache and verified-registry token check as the wallet page's
Trades tab (`kind=trades` on `/v1/wallets/:address/history`,
`docs/WALLET-TRADE-HISTORY.md`): a row is a followed wallet's ERC-20 leg
settled directly with the v4 PoolManager in a launch token of `indexed_pools`,
so a spoofed token never appears. It is explorer data for display only, never
joined to accounting or PnL, and the pre-ledger accounting tables are no longer
read by it (they stay in place). `apps/api/src/following-read.ts` holds the
response types and the policy below.

The answer is the union of each wallet's first explorer page (50 ERC-20
transfers, so 0 to 50 trades each), merged newest first by block and log index
and cut at `limit`. A row has `id` (`txHash:logIndex`), `wallet`, `poolId`
(the registry's pool for the token, or null if ambiguous), `token`, `symbol`,
`name`, `decimals`,
`txHash`, `logIndex`, `block`, `timestamp`, `side`, `tokenRaw` (exact raw
amount) and `method`; there is no ETH amount, price, publication cutoff or
support flag. `coverage.wallets` says for every requested wallet whether its
page was `read` (with `fetchedAt`), is `stale` (a refresh failed, with its
`reason`), is `pending` (not read yet) or `unavailable` (never read, with its
`reason`), and where its page ends (`horizonBlock`, with `olderTrades`): a
launcher's page of transfers can span a few hours, so that wallet's older
trades may be missing while other wallets' trades at those blocks are listed.
When no requested wallet could be read the route answers 503
`wallet_history_unavailable` with a reason and `Retry-After`.

One answer reads at most 8 wallets from the explorer (240 credits), never-read
wallets first, so a list of 200 fills in over about 25 polls. A cached page is
read again when the ledger's All-window `last_timestamp` for the wallet
(`agg_wallet_windows`) is newer than its newest listed trade and than what the
ledger showed when the page was read (once the page is 2 minutes old); when
the ledger already showed that activity but the page does not list it yet
(every 5 minutes while it is under 15 minutes old); and when it is 6 hours old,
or 10 minutes without a ledger signal. A feed polled every 30 seconds therefore
spends credits in proportion to what its wallets do, and the cache is shared
with the wallet page and every viewer following the same wallet. Following
never spends the last fifth of the day's credit cap, which stays for the wallet
page; past its share pages are served `stale` with `reason:"budget_exhausted"`
and nothing is filled in. The credit arithmetic is in
`docs/WALLET-TRADE-HISTORY.md`, "Credit budget".

The API and web proxy do not cache these responses. An unavailable API is an
error for this feature; it is never replaced by an invented empty preloaded
feed.

## Validation

`apps/api/src/following-read.test.ts` covers the merge and per-wallet horizons,
the registry re-check, the refresh gate against ledger activity and age, the
per-answer read bound, per-wallet failure disclosure, the credit reserve and the
shared cache. `ledger-wallet.integration.test.ts` pins the ledger signal to the
wallet header's own `last`. Watchlist browser tests use fresh recipient
contexts and cover explicit
merge, cross-tab state, URL filters, invalid input, limits and clipboard denial.
