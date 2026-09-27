# Wallet trade history

The wallet page's trade list is served on demand from the chain's explorer,
Blockscout (aggregate design decision D3: no per-sale rows are stored, the PnL
curve is hourly). Only the verified registry's list of launch tokens comes from
our database, to decide which explorer rows are trades. This note is the contract
between the read API and the website. The route's configuration, budget and
failure behaviour are in `apps/api/README.md`, "Explorer wallet history".

## Request

`GET /v1/wallets/:address/history?kind=trades` for the newest trades, then
`&cursor=<nextCursor>` for each older page. `kind` defaults to `transactions`,
so a trade list must always name it. The only other parameter is `cursor`: a
cursor is bound to the wallet and the kind, and any other parameter or a cursor
from another wallet or kind is a 400. The website forwards the Trades tab's
history requests through `/api/product/wallets/:address/history/` on demand.

## Response

The `WalletHistoryResponse` union in `packages/core/src/wallet-history-types.ts`,
with `kind: "trades"`:

```ts
{
  source: "blockscout";
  chainId: 4663;
  wallet: string; // lowercase
  kind: "trades";
  items: WalletHistoryTrade[]; // newest first
  nextCursor: string | null; // opaque; null once the explorer has no more
  fetchedAt: string; // ISO time the explorer answered
  stale: boolean; // true: served from cache because the explorer or the credit budget could not answer
  note: "Explorer history for display only; not accounting or PnL evidence.";
}

interface WalletHistoryTrade {
  transactionHash: string; // lowercase; the explorer link is /tx/<hash>
  logIndex: number; // unique with transactionHash; one transaction can hold two legs
  block: number;
  timestamp: number | null; // Unix seconds
  side: "buy" | "sell"; // buy: the wallet received the token; sell: the wallet sent it
  token: {
    address: string; // lowercase
    symbol: string | null; // explorer display string, at most 256 characters
    name: string | null;
    decimals: number | null; // null when the explorer does not know it: show the raw amount or a dash, never assume 18
    type: string | null; // always "ERC-20" here
  };
  tokenRaw: string; // exact raw integer amount
  method: string | null; // decoded method name or 4-byte selector of the transaction
}
```

Example (a real first page, trimmed to two items):

```json
{
  "source": "blockscout",
  "chainId": 4663,
  "wallet": "0x55244d122ad8e8dd42abc05e7a6825556cba5db9",
  "kind": "trades",
  "items": [
    {
      "transactionHash": "0xd52a2f4a1704f82e4c906c9f5c8bcf00ef0cf1dea7fbdbd219412bc8aa1688fc",
      "logIndex": 2,
      "block": 72363734,
      "timestamp": 1790353075,
      "side": "sell",
      "token": {
        "address": "0x5b7cb8fe6c58368fcd33148a3f43b34b2bfe3a0d",
        "symbol": "SMARTCHAIN",
        "name": "Smart Chain",
        "decimals": 18,
        "type": "ERC-20"
      },
      "tokenRaw": "19638821806889535844609694",
      "method": "0x3593564c"
    },
    {
      "transactionHash": "0xba87a40538e7f826a73ead8713a5247c42ce9dfde2913cdcf3f84fca0439b023",
      "logIndex": 102,
      "block": 72362457,
      "timestamp": 1790352948,
      "side": "buy",
      "token": {
        "address": "0x5b7cb8fe6c58368fcd33148a3f43b34b2bfe3a0d",
        "symbol": "SMARTCHAIN",
        "name": "Smart Chain",
        "decimals": 18,
        "type": "ERC-20"
      },
      "tokenRaw": "19638821806889535844609694",
      "method": "0x3593564c"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJzY29wZSI6ImQ5OTNkMzY0ODI5MjU3MGY3NTliM2EyNCIsImtpbmQiOiJ0cmFkZXMiLCJwYWdlIjp7ImJsb2NrX251bWJlciI6IjcxNDU2MTUzIiwiaW5kZXgiOiIxMDkifX0",
  "fetchedAt": "2026-09-25T16:41:22.488Z",
  "stale": false,
  "note": "Explorer history for display only; not accounting or PnL evidence."
}
```

Errors are the route's existing ones: 503
`{error:"wallet_history_unavailable", reason}` with `Retry-After`, where
`reason` is `not_configured`, `budget_exhausted`, `upstream_unavailable` or
`key_rejected`; 400 `invalid_kind` or `invalid_cursor`. A process that has not
yet read the registry and cannot reach the database answers the generic 503
`{error:"data_temporarily_unavailable"}` (or the warming refusal while the
database warms), and spends no explorer credit.

## What a trade is here

A leg of the wallet's own ERC-20 transfers, in a token of the verified registry
(`indexed_pools`, whose pools are admitted only after their id is recomputed
from the pool key), in a transaction that carries a swap of that token's pool
through the Uniswap v4 PoolManager
(`0x8366a39cc670b4001a1121b8f6a443a643e40951`). `side` is the leg's
direction: `buy` when the token came to the wallet, `sell` when the wallet
paid it out. The API reads the wallet's explorer transfer pages and sorts
their legs two ways:

- **Direct.** The counterparty is the PoolManager, the settlement leg of the
  swap itself. It is listed as read.
- **Relayed.** The counterparty is any other address: a router or aggregator
  that takes the swap's tokens from the PoolManager and passes them on, but
  equally a plain send to another wallet or an airdrop. The transfer page
  carries only the wallet's own legs, so the API asks the chain whether the
  transaction holds the swap: one `eth_getLogs` per block for the
  PoolManager's `Swap` logs of the legs' pools, sent through the explorer's
  JSON-RPC gateway five blocks to a batch, and keeps a relayed leg only when
  its own transaction is among them. Verdicts for legs at least five minutes
  old are cached per transaction and pool for the life of the process; newer
  legs are checked again so indexing lag or a recent reorg cannot freeze a
  wrong answer. A plain send or an airdrop carries no swap and stays out.

Relaying is common. On the 7d board of 25 Sep 2026, wallet `0xb96de56c` sold
20 of its 22 trades through the launchpad's own router
(`0x8876789976decbfcbbbe364623c63652db8c0904`), the heavy trader `0xb5ba7f32`
settled 239 of its 680 legs through routers, and all 280 legs of `0x6e7d7a4e`
went through aggregators (`0xf5576dee…`, `0xe7bf8da1…`, `0xcc4c6fa2…`
and others). Before relayed legs were confirmed the list showed 2 of 22 and
441 of 680 for the first two and none of the third's. Paged to the end through
the route on 27 Sep 2026, the three list 22 of 22, 680 of 680 and 280 of 280,
with no duplicate, no wrong side and no leg the chain does not show.

The first page of the 7d board's top wallet on 25 Sep 2026 was 10 spoofed-token
address-poisoning logs (a token named with invisible characters to pass for
"ETH"), 8 NFT mints and 32 PoolManager legs, so the raw
`kind=token-transfers` list is not a trade list, and telling its rows apart
needs this chain's contract addresses.

- **No ETH amount.** For many trades the ETH is paid or received by a router
  or bot contract, not the wallet, so no wallet-level explorer feed carries
  it. The exact figure lives only in each swap's log, at one 30-credit explorer
  call per trade, about 750 credits per page, which the free key cannot
  sustain. The row links to the explorer transaction, which shows it.
- **Not the ledger's count.** The Trades stat tile is the ledger's window
  count (`tradeCount`); this list is the wallet's whole history in the
  registry's pools. On 25 Sep 2026 over the same 24 hours, one wallet matched
  exactly (46 and 46); another showed 40 PoolManager legs against the ledger's
  12, because most of its legs were in pools the ledger has not registered,
  which the registry check now leaves out. Never label the list's
  length as the wallet's trade count, and never derive a figure from it: it is
  display data, not accounting evidence, and is never joined to positions or
  PnL.
- **Registry tokens only.** Any token contract can write any `from` and `to`
  into its Transfer log, so the direction alone cannot tell a sale from a
  spoofed token's log that names the PoolManager, and Blockscout's reputation
  flag does not catch it either (the recorded poisoning token is marked `ok`).
  The token of a Transfer log, though, is the contract that emitted it, which
  the EVM sets, so a spoofed token can never carry a registered token's
  address; the registry check closes that gap. The API holds the registry's
  tokens in memory, reads only newly registered pools every 30 s and reloads
  in full hourly, so a token launched in the last half minute can be missing
  from a first read. Trades in pools outside the verified registry are not
  listed, the same scope as every other page on the site.
- **Legs in a swap's transaction, not decoded swaps.** A relayed leg is
  listed because its transaction swapped the token's pool, not because the
  leg was proven to be that swap's output. So a router's refund of unspent
  tokens shows as a buy, and a send to another wallet inside a transaction
  that also swaps the same pool shows as a sell. A liquidity add or remove
  against the PoolManager would show as a sell or buy too; the launchpad's
  pools take no outside liquidity, so this is rare. A swap whose tokens never
  pass through the wallet (a router paying them straight to another
  recipient) is not the wallet's leg and is not listed.
- **The swap must be in the token's registered pool.** A leg whose
  transaction swapped the token only in a pool outside the registry is not
  listed, the same scope as the direct legs.
- **Unconfirmed is never shown as confirmed or dropped silently.** When the
  gateway cannot answer, or answers something malformed, the whole page fails
  as `upstream_unavailable`: the cached page is served `stale`, otherwise the
  route answers 503. A page never goes out with its relayed legs missing.

## Pagination

Every response reads exactly one explorer page of 50 transfers, so a page holds
anywhere from 0 to 50 trades beside a non-null `nextCursor`: a wallet whose
page is crowded with other transfers, or with trades in pools outside the
registry, can answer an empty page that still has more behind it. Offer Show
more whenever `nextCursor` is non-null, whatever the item count. Append by
following `nextCursor` and never refetch a page already shown. Key rows on
`transactionHash` and `logIndex`.

One explorer page answers in about 2 s: measured on 25 Sep 2026, 1.5-2.1 s from
a workstation (Blockscout itself took 1.8-2.0 s per page) and 2.0-4.6 s from
Railway. Confirming a page's relayed legs adds one gateway batch per five
blocks, two batches in flight, each answering in 0.1-0.7 s. On 27 Sep 2026 a
local build paging the heavy trader `0xb5ba7f32` through the route from a
workstation answered each of its 19 pages in at most 1.8 s (median 1.4 s),
confirmations included. The website's proxy aborts every upstream read at 8 s
(`AbortSignal.timeout(8000)` in `apps/web/src/lib/product-server.ts`), which is
why a response never reads more than the one page.

Following caps confirmation at two gateway batches across all eight wallets
refreshed in one answer. That makes at most ten billed calls in the answer:
eight explorer pages and two gateway batches, with up to five block queries
per batch. At the shared five-calls-per-second limit and with no other key
traffic, the tenth call starts at most about one second after the first if
calls are ready together. Using the observed slow end of 4.6 s per page and
0.7 s per gateway batch gives an approximately 6.3 s envelope for this work,
below the proxy's 8 s deadline. A slower upstream can still hit that deadline;
the browser-visible worst case is then an unavailable response at 8 s. A
relayed leg that did not fit the budget is left out of that Following answer
and can be confirmed on a later poll. Such a partial page never enters the
Trades tab's shared page cache, and the Trades tab keeps its full confirmation
path.

## Credit budget

The free Blockscout PRO key allows 100,000 credits per UTC day and 5 requests
per second. An explorer page of transfers costs 30 credits. Confirming relayed
legs costs 20 credits per gateway batch of up to five blocks (a batch is billed
and rate-limited as one request; the gateway refuses more than five and bills
the refusal), only for blocks holding relayed legs of registry tokens whose
transaction and pool the process has not confirmed before, so a page of
direct trades costs nothing extra and a page read again costs only the page.

| event                                     | explorer pages | gateway batches | credits  |
| ----------------------------------------- | -------------- | --------------- | -------- |
| wallet page load, first trades page       | 1              | 0 to 10         | 30 - 230 |
| same wallet again within 30 s             | 0 (cached)     | 0               | 0        |
| each Show more                            | 1              | 0 to 10         | 30 - 230 |
| a page already read within 10 minutes     | 0 (cached)     | 0               | 0        |
| that page again later, legs already known | 1              | 0               | 30       |

Measured on 27 Sep 2026: `0x78cc2ff0`'s whole history (4 pages, all direct)
cost 120 credits; `0xb96de56c`'s one page with 20 router-relayed sells cost 110
(30 plus 4 batches); the heavy trader `0xb5ba7f32`'s whole history, 19 pages
with 239 relayed legs, cost 1,750 (570 plus 59 batches), about 92 a page; and
`0x6e7d7a4e`'s 30 pages, all 280 legs relayed by aggregators, cost 2,220.

Each process may spend `BLOCKSCOUT_DAILY_CREDIT_CAP` (default 30,000) per day,
which is 1,000 uncached pages of direct trades, about 325 at the heavy trader's
mix, and 130 at the worst case of 50 relayed legs in 50 blocks. Past that the
route serves cached pages marked `stale` and otherwise answers 503
`budget_exhausted` until UTC midnight. The cap keeps three process lifetimes a
day inside the key's allowance. At 16:27 UTC on 25 Sep 2026 the key had 99,900
credits left, so the route was barely being called.

`GET /v1/following` spends from the same cap and cache (see
`docs/FOLLOWING-AND-WATCHLISTS.md` for its refresh policy): at most 8 page
reads (240 credits) and two gateway batches (40 credits) per answer. It
reserves the cap's last fifth for wallet-page reads. The figures
below count page reads at 30 credits; a followed wallet that trades through a
router adds 20 per five blocks of new relayed trades when budget permits, since
older legs a refresh has already confirmed are not asked again.

| Following event                                          | explorer pages          | credits           |
| -------------------------------------------------------- | ----------------------- | ----------------- |
| first view of 10 followed wallets                        | 10, over 2 answers      | 300               |
| first view of 200 followed wallets (the maximum)         | 200, over 25 answers    | 6,000             |
| a 30 s poll with cached pages and no new ledger activity | 0                       | 0                 |
| a quiet followed wallet with a ledger signal, per day    | 4 (6 h age limit)       | 120               |
| a followed wallet trading in ~30 bursts a day            | about 34                | about 1,000       |
| a followed wallet trading nonstop for 24 h, the ceiling  | 720 (one per 2 minutes) | 21,600            |
| 10 followed wallets, 3 of them active, watched all day   | about 150               | about 4,500 (15%) |

A page is shared by every viewer following the wallet and by this route's
first page, so the figures are per unique followed wallet, not per viewer.
Without a wallet-specific ledger signal, Following retries that wallet's page
every 10 minutes while watched, so the quiet-wallet estimate above does not
apply.
