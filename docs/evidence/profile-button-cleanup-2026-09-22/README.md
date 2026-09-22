# Wallet profile and trader action audit

Captured from the production build with `PRODUCT_FIXTURES=1` and
`CHAIN_REFRESH_DISABLED=1` on 22 September 2026. The phone captures use an
exact 390 x 844 viewport, not a device preset.

## Reproduction

Before the change, the primary actions looked related but were separate CSS
implementations. At 1440 px, `Trader leaderboard` was 36 px high and had a
text arrow while `Copy trade` was 38 px high and had no icon. Both happened to
be 44 px high at 390 px, but their icon treatment still differed. The
leaderboard link owned page-specific hover and active selectors while Copy
trade inherited the shared primary button selectors.

## Control inventory

| Surface | Control | Family | Geometry and type | Icon treatment |
| --- | --- | --- | --- | --- |
| Explore heading | Trader leaderboard | Primary `.button` | 38 px desktop, 44 px phone, 10 px radius, 0 14 px padding, 13 px / 600 | 15 px `ArrowRight`, 2 px stroke |
| Wallet heading | Explorer | Secondary `.button` | 38 px desktop, 44 px phone, 10 px radius, 0 14 px padding, 13 px / 500 | None |
| Wallet heading | Share PnL card | Secondary `.button` | Same secondary geometry | None |
| Wallet heading | Follow wallet | Secondary `.button` | Same secondary geometry | Shared 15 px button icon |
| Wallet heading | Copy trade | Primary `.button` | Same as Trader leaderboard | 15 px `ArrowRight`, 2 px stroke |
| Wallet body | Address controls | `.icon-button` | Shared icon target, 44 px minimum on phone | Existing address icons |
| Wallet body | Window and activity tabs | `.segmented` and `.table-tabs` | Shared segmented and tab tokens | None |
| Traders heading | View, metric, and window controls | `.segmented` | Shared segmented tokens | None |
| Traders rows | Follow, copy, and explorer controls | `.icon-button` | Shared icon target, 44 px minimum on phone | Existing row icons |
| Traders footer | Show more | Secondary `.button` | Shared secondary geometry | None |
| Traders YOU row | Whole-row link | Link-style card action | Fixed 54 px desktop, 84 px phone | Existing trailing arrow |

All primary rest, hover, active, and focus-visible states now come from the
same semantic control tokens in `globals.css`. The exact 1440 and 390 browser
tests compare background, border, radius, shadow, colour, typography, padding,
gap, height, focus outline, and icon geometry between both actions.

## Removed profile identity action

`This is my wallet` and its `MyWalletButton` component were removed. That
control had no dialog and no unique storage key. It wrote directly to the
shared `poolsinfo.my-wallet.v1` identity store. The header's Set my wallet
dialog, wallet menu, portfolio framing, and leaderboard YOU row all depend on
that shared store, so the minimum shared identity path remains. Browser
coverage proves that opening a profile does not write the store, while setting
and forgetting a wallet through the retained header continues to drive the
menu, profile framing, and YOU row.

## Frames

### 1440 px

- [Wallet before](wallet-1440-before.png)
- [Wallet after](wallet-1440-after.png)
- [Trader board before](traders-1440-before.png)
- [Trader board after](traders-1440-after.png)
- [Explore CTA before](home-1440-before.png)
- [Explore CTA after](home-1440-after.png)

### True 390 px

- [Wallet before](wallet-390-before.png)
- [Wallet after](wallet-390-after.png)
- [Trader board before](traders-390-before.png)
- [Trader board after](traders-390-after.png)
- [Explore CTA before](home-390-before.png)
- [Explore CTA after](home-390-after.png)
