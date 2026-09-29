# D2 - the PnL card's Trades count (29 Sep 2026)

Figures audit of 29 Sep 2026, section 5, item D2: the card printed
`wallet.tradeCount` (every attributed swap, positions the PnL excludes
included) where the wallet page's Trades tile and every board column print
`supportedTradeCount`.

Method: a local production build served the wallet read from a stand-in
read API that answered `/v1/wallets/0x68bb…5713?window=7d` with the
production response captured at 2026-09-29 (asOf 1790696044: `tradeCount`
26, `supportedTradeCount` 23) and 404 for everything else, so no page here
reached production and no explorer credit was spent (the Trades tab was
never opened). The card is the route's own PNG at the share size, 1200 by
630; the tile is the wallet page's stats row at 1440 px.

- `card-before.png`: main (524d7aa), `TRADES 26`.
- `card-after.png`: this change, `TRADES 23`.
- `wallet-tile-1440.png`: the wallet page's Trades tile, `23`, unchanged by
  this PR, the figure the card now agrees with.
