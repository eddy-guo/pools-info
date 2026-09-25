# Wallet trade history

The wallet page's trade list is served on demand from the chain's explorer,
Blockscout, and never from our database (aggregate design decision D3: no
per-sale rows are stored, the PnL curve is hourly). This note is the contract
between the read API and the website. The route's configuration, budget and
failure behaviour are in `apps/api/README.md`, "Explorer wallet history".

## Request

`GET /v1/wallets/:address/history?kind=trades` for the newest trades, then
`&cursor=<nextCursor>` for each older page. `kind` defaults to `transactions`,
so a trade list must always name it. The only other parameter is `cursor`: a
cursor is bound to the wallet and the kind, and any other parameter or a cursor
from another wallet or kind is a 400. The website's proxy does not forward
`/history` today, since the old wallet tabs were cut. Serving this route means
adding a proxy path for it, with its own trailing slash.

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
  side: "buy" | "sell"; // buy: the token left the PoolManager for the wallet; sell: the wallet paid it in
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
`key_rejected`; 400 `invalid_kind` or `invalid_cursor`.

## What a trade is here

An ERC-20 transfer between the wallet and the Uniswap v4 PoolManager
(`0x8366a39cc670b4001a1121b8f6a443a643e40951`), the settlement leg of every
swap in a catalog pool. The API reads the wallet's explorer transfer pages and
keeps only those legs, deriving `side` from their direction. Everything else is
dropped. The first page of the 7d board's top wallet on 25 Sep 2026 was 10
spoofed-token address-poisoning logs (a token named with invisible characters
to pass for "ETH"), 8 NFT mints and 32 PoolManager legs, so the raw
`kind=token-transfers` list is not a trade list, and telling its rows apart
needs this chain's contract addresses.

- **No ETH amount.** For many trades the ETH is paid or received by a router
  or bot contract, not the wallet, so no wallet-level explorer feed carries
  it. The exact figure lives only in each swap's log, at one 30-credit explorer
  call per trade, about 750 credits per page, which the free key cannot
  sustain. The row links to the explorer transaction, which shows it.
- **Not the ledger's count.** The Trades stat tile is the ledger's window
  count (`tradeCount`); this list is the wallet's whole history across every v4
  pool. On 25 Sep 2026 over the same 24 hours, one wallet matched exactly
  (46 and 46); another showed 40 legs against the ledger's 12, because most of
  its legs were in pools the ledger has not registered. Never label the list's
  length as the wallet's trade count, and never derive a figure from it: it is
  display data, not accounting evidence, and is never joined to positions or
  PnL.
- **Direct settlement only.** A trade where a contract other than the
  PoolManager hands the wallet its tokens is not listed. None of the sampled
  board wallets traded that way. A liquidity add or remove against the
  PoolManager would show as a sell or buy. The launchpad's pools take no
  outside liquidity, so this is rare.

## Pagination

Each response reads whole explorer pages (50 transfers each) until it holds 25
trades, reaches the end, or has read three pages. So a page usually holds 25 to
50 trades, and can hold up to 150. It can hold fewer, or none, beside a
non-null `nextCursor` when the wallet's pages are crowded with other transfers
or a later explorer page failed. Offer Show more whenever `nextCursor` is
non-null, whatever the item count. Append by following `nextCursor` and never
refetch a page already shown. Key rows on `transactionHash` and `logIndex`.
Measured on 25 Sep 2026 from a workstation, a first page answered in 1.5-2.1 s
(Blockscout itself took 1.8-2.0 s per page).

## Credit budget

The free Blockscout PRO key allows 100,000 credits per UTC day and 5 requests
per second. An explorer page of transfers costs 30 credits.

| event                                 | explorer pages | credits |
| ------------------------------------- | -------------- | ------- |
| wallet page load, first trades page   | 1 (at most 3)  | 30 (90) |
| same wallet again within 30 s         | 0 (cached)     | 0       |
| each Show more                        | 1 (at most 3)  | 30 (90) |
| a page already read within 10 minutes | 0 (cached)     | 0       |

Each process may spend `BLOCKSCOUT_DAILY_CREDIT_CAP` (default 30,000) per day,
which is 1,000 uncached wallet page loads (333 when every page is crowded).
Past that the route serves cached pages marked `stale` and otherwise answers
503 `budget_exhausted` until UTC midnight. The cap keeps three process
lifetimes a day inside the key's allowance. At 16:27 UTC on 25 Sep 2026 the key
had 99,900 credits left, so the route was barely being called.
