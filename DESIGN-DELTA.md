# Design Delta — design system vs. live UI

## Accent moved to lime, 17 September 2026

The captain approved moving the accent from pink to lime ("convert now if you want, nbd"). No lime export arrived and neither design file names one: the export's accent swatches are teal `#4DE1C1`, green `#3BF07A` (the card's own "Green" preset), pink `#FC72FF` and amber `#FFB84D`. The accent is Tailwind v4's `lime-300` (`#bbf451`), with `lime-950` (`#192e03`) as `accentDeep`, set once in `packages/core/src/visual-theme.ts`; the share card's default preset is now `lime` and reads the same token. The pink notes below are the history of the first theme pass.

## Verified source and isolated first step, 15 September 2026

The user approved the existing export for now: "its fine just use the pink one for now, we'll update it later". Lime remains a future design update.

- Source: `/Users/eddyguo/Downloads/Poolsinfo.html`, 505,279 bytes, modified 15 September 2026 at 02:41:51 America/Toronto. Original SHA-256: `25778cdf869dd6dce7db93f42d5154402f0badfe20da4e7a1385076e5b28a566`.
- Version-controlled reference: `design/poolsinfo.html`. It is a standalone bundle; no assets directory, share wrapper, `.dc.html`, or support files were copied.
- Sanitization removes the rendered `<img alt="Uniswap">` and its exact embedded 18,754-byte SVG from the asset manifest. The other 14 bundled assets remain. The independent-analytics / non-affiliation footer remains. Chrome confirms the page still renders and contains no images after sanitization.
- Source caveat: its decoded page template matches the older design after resource UUID normalization. `#fc72ff` appears 53 times, fourth in the literal palette frequency list; the themeable rendered `--ac` still defaults to teal `#4de1c1`. The reference preserves that mixed source palette. The application now uses the explicitly approved pink `#fc72ff` theme token. No lime values were invented.

The Tailwind diagnosis below overstates the effect on current components. The app has 569 `className` assignments, but 462 literal attributes use semantic CSS classes such as `panel`, `button`, `data-table`, and `muted`. None of those literal attributes uses color, radius, or font Tailwind utilities; the only `text-*` token is the custom `text-button` class. Existing components are chiefly styled by explicit selectors in `globals.css`, not Tailwind color utilities.

Completed only the requested first step: `@theme static` defines the palette, type and radius scales; legacy `:root` aliases point to the appropriate theme tokens; body text is 13px. Static theme output keeps all design tokens available to the legacy CSS as well as future utilities. Component, chart and OG-card literals are unchanged.

Validation: `pnpm build` passed. Production-build browser checks at 1440 x 1000 confirm body text changed from 14px to 13px, the brand accent resolves to `rgb(252, 114, 255)`, and the missing text/border/radius tokens are present in computed styles. The source bundle renders without its wordmark. No financial values or data-loading behavior were changed.

Visual assessment at matching 1440 x 1000 viewport:

- Before: `/tmp/pools-theme-before.png`; after: `/tmp/pools-theme-after.png`; sanitized reference: `/tmp/pools-theme-reference.png`.
- Theme wiring and body size work, but there is no large layout change: fixed table rows remain 67px, token names remain 12.5px / weight 500, panels remain 16px radius and stat cards 14px. Explicit selectors continue to control those values.
- Reference rows are denser, secondary text is brighter, and its table begins much higher. The app's large coverage notice, extra metric descriptions and second toolbar row cause most of that vertical displacement. These need a considered component pass that preserves honest coverage disclosure.
- Teal token-icon defaults, chart/card literals, selected-control tints and additional hardcoded neutrals remain for subsequent steps. Semantic gains/losses stay separate from the pink accent.

The comparison used the existing real preloaded dataset with live chain refresh disabled, so missing live-feed content is a data-environment difference, not a theme regression. The isolated first step is ready for assessment before continuing with component-level changes.

## Shared palette follow-up

`packages/core/src/visual-theme.ts` is now the color source for the browser theme, lightweight-charts, server-rendered PnL images, and default wallet avatars. The approved pink accent is shared; gains and losses retain independent green/red tokens. Volume-bar opacity derives from those same semantic colors.

The generated `apps/web/src/app/visual-theme.css` contains the palette portion of `@theme`; `globals.css` imports it and keeps the existing type/radius declarations and legacy aliases. To change colors, edit the TypeScript source and run `pnpm exec tsx scripts/sync-visual-theme.ts`. Never hand-edit the generated file. `pnpm exec tsx scripts/sync-visual-theme.ts --check` detects stale output, and the normal unit suite checks the CSS artifact against the shared values and prevents private hex palettes returning to the three renderers.

This follow-up changes the avatar/card accent to pink and centralizes existing chart colors. It does not change chart behavior, financial calculations, component spacing, or table density. Text-ramp application and component-level contrast/weight/radius work remain separate.

## Desktop pool rows and readability

The desktop screener now follows the reference's measured row proportions: 62px rows, 30px token icons, 14px / weight 500 token names, 12px secondary token text, 13px prices, weight 600 signed changes, and 11.5px / weight 400 column headers in a 34px head row; the sortable ones sort on click with an arrow on the active column. The metadata, liquidity, holder count and creator columns use their distinct shared neutral tokens. Related table/filter literals now reference equivalent shared colors. Existing panel, card and control radii remain unchanged.

These density changes are scoped to `.desktop-pools`. The token icon selector covers both the original avatar and the new `PoolImage` wrapper. Coverage labels and timestamps remain present; their line boxes and the watch-button display were adjusted to avoid inflating the reference row height. Mobile cards retain their separate typography and touch targets.

Production-build browser validation at 1440 x 1000 measured eight visible rows at exactly 62px, token names at 14px / 500, secondary text at 12px / `rgb(154, 154, 164)`, icons at 30 x 30, and signed changes at 14px / 600. The page has no viewport overflow. Matching-viewport screenshots: `/tmp/pools-rows-before.png`, `/tmp/pools-rows-reference.png`, and `/tmp/pools-rows-after.png`. The final screenshot uses the built application without injected preview CSS. A manual 500px viewport check also confirmed stacked mobile cards, hidden desktop tables, 44px watch controls and no horizontal page overflow.

The combined production build and four token-image desktop/mobile E2E checks passed in the parallel image task. Broader responsive regression checks remain with the root task. This increment changes no component markup, query behavior or financial calculations. The coverage notice and double toolbar still cause the largest page-level difference from the reference and are deliberately left for a separate layout decision.

## Leaderboard row hierarchy

The reference trader row is a 10-column grid (`42px 464px 118px 82px 116px 78px 108px 92px 84px 68px`, 10px gaps) whose numeric columns are right-aligned: realized at 14px / 600 in the up colour, the supporting counts at 14px / 400 in text-2, rank and time in text-3. The live table had every column left-aligned at 12px / 600 with `ch` widths that left ROI, W/L, trades and positions 174px wide while the timestamp overflowed its 159px cell.

`.leaderboard-panel .data-table` now fixes pixel widths (rank 58, realized 150, ROI 104, W/L and trades 92, volume 124, positions 110, best sale 134, last 186; the trader column takes the remainder, 324px at 1440) and right-aligns columns three onward. Realized, ROI and W/L render at `--text-lg` / 600; trades, volume, positions, best sale and last render at `--text-base` / 400 in text-2, with best sale keeping its sign but not its colour. Table ROI goes through the shared signed `Change` component, so it reads `+23.03%` and `-8.54%` like the mobile card. Numeric spans are blocks inside their cells: a right-aligned inline-block whose width changes on the pending-to-value swap moves its left edge, which registered as a 0.00001 layout shift before the fix. Mobile cards mirror the split with `.mobile-trader-key` (ROI, W/L at 14px / 600) above `.mobile-trader-stats` (12px / 400, text-2); the 268px card height is unchanged and the content fits it. Row height stays 74px, so the reserved geometry and the layout-stability sentinels are untouched.

## Type, colour and control tokens (W1)

The export sets 70 percent of its text at weight 400 and keeps 600 for what carries a row; the live site was set on `body { font-weight: 600 }`, which made every `strong` compute to 900. `body` is now 400 on a 1.25 line (prose `p` and `li` keep 1.5), `strong` and `b` are 600, and the intentional 600s are named: the signed change, PnL and the Buy/Sell side (`.change`, `.positive`, `.negative`), the H1, the active segment, the primary button; monogram initials are 700. Head labels are one style on every table (11.5px caps at 400, `.04em`, on the 34px inset head row); captions, ages and addresses sit at 11.5-12.5px, so no text is under 11px except chips and the price subscript; `.panel` borders are `--color-line` with `--color-line-strong` kept for inputs, buttons and segmented frames; every segmented control is the 32px frame of 26px buttons at 12/600 with the `--color-surface-6` active fill; `.button` is 38px (44 on the phone) at 13px, 600 for the primary and 500 for the secondary; the stat label is 12/400 muted; the rail's token names are 12.5/400.

An unknown datum renders as an empty, aria-labelled cell, as the export leaves one; only a stat card's value slot carries a quiet en dash in `--color-faint` so its label does not float. The fallback avatar is the export's monogram: two characters from the address on a hue drawn from it (`hsl(h 42% 13%)` under `hsl(h 78% 72%)`), drawn from `data-initials` by the stylesheet so a cell's text stays the address; the default 16px address-chip tile keeps the hue border and no letters, while trader rows and podium cards opt into the readable 30px monogram. `#71717c`, `#25252c`, `#666670` and `#777781` are no longer used; no token was added.

Reserved geometry that the line height moved was resized in the same pass: the phone screener card is 168px (15 + 44 + 14 + 80 + 15), the creators progress row holds 69px with or without its button, and on the on-demand pool page the launch meta holds two 15px lines (30px), the stat card is 103px (101 on the phone), the phone price heading is 87px and the heading is the sum of its fixed slots again (107px; 259 on the phone). A launch fact's value takes its row's free space and its skeleton is a different node from its value: Chrome tracks a text run's starting point, so text that resolves to another width inside one right-aligned node is a layout shift even when its box holds still. `tests/e2e/type-tokens.spec.ts` measures these tokens on `/` and `/traders/`.

## Leaderboard evidence labels

The podium's `#N · covered pools` label, the accounting badge on podium cards and rows, the `N eligible / N excluded` positions cell and mobile footnote, the refresh button and the empty state's basis sentence are gone; the positions column shows the count alone. The reserved slots closed up by exactly what left them, measured on the production build: the desktop row drops from 74px to 62px (level with the screener and creators rows and the export's 61px; on W1's tokens its tallest cell is the 17.5px signed value inside 13px padding), the desktop podium card from 204px to 183px and its band from 236px to 215px (the badge line was 21px), and the mobile card from 268px to 224px (the footnote was 44px; on W1's tokens the content ends at 223px). The mobile podium card keeps 120px because its badge shared the value's row. The mobile card's value row is 27.5px in both states: its caption rule matches the span after the number rather than the last child, because a pending row holds the number alone and the last-child rule shrank it to 11px (13.75px), a first-paint difference that sat below the Pixel 7 viewport on main and only registered once the copy above it went. The podium's card content and the flat list against the export remain a separate item.

---

Extracted from `~/Downloads/Poolsinfo Design System/poolsinfo.html` and compared against `apps/web/src/app/globals.css` + components, 15 Sep 2026.

**Summary: four concrete defects. The neutral ramp is collapsed, the accent is the wrong colour, body type is too large, and none of the tokens reach Tailwind.**

---

## Defect 1 — the tokens never reach the components

```
var(--token) used in components:   6
className=   used in components: 566
```

`globals.css` defines `:root { --bg, --panel, --muted, --ac ... }`. Tailwind v4 is imported with **no `@theme` block**. In v4 those are unconnected: Tailwind cannot see `:root` custom properties, so every `bg-*` / `text-*` / `border-*` class resolves to **Tailwind's stock palette**, not the design system.

This is why the UI drifts no matter how carefully components are written. Fix this first — the other three defects can't be fixed durably until tokens are real utilities.

---

## Defect 2 — the text hierarchy is collapsed (biggest visual cause)

**Resolved in the 15 September stability pass.** Components now use the existing
five-step theme through token-backed CSS: text-2 for bright secondary text,
text-3 for ordinary secondary text, muted/faint for lower emphasis, and
line-strong on raised panel boundaries. The three private literals were removed
from component rules. Body weight defaults to 600; explanatory paragraphs can
still explicitly use 400. The comparisons below describe the original defect.

Loading now paints on persistent real elements. Launch rails, rows, charts and
coverage notices reserve geometry, including empty/error states. The four
approximate route loading pages were removed. Desktop and mobile measurements
cover the screener, pool, traders and wallet, plus on-demand pool success/error:
CLS 0, unchanged sentinels, and persistent representative numeric nodes.

A reserved slot is sized at first paint and never resized by a response. The
pool page's chart region is the one slot with two sizes: it holds a chart's
height unless the row that opened it carried no market evidence, in which case
it paints the empty state's height from the start (`pool-row-memory.ts` carries
that row into the page, and hydration cannot read it, so a direct URL always
reserves the chart). A pool whose detail the read API does not publish keeps
whichever height it painted with. The pool page reserves no slot for coverage
or methodology copy (evidence badge, refresh status, coverage paragraph, chart
footnote, stat captions): that copy is gone, and the price heading and stat
cards are sized to the price, its change box and the value alone.

Under 768px the pool heading stacks into one column that never wraps, and its
slots are sized for a 390px phone: the title holds two rows (the name beside
its symbol, then the launch mode chip), then the short address and the launch
line on 44px rows; the heading is the sum of those and the two-row action grid
(see "Pool page laid out like the export").

## Pool page laid out like the export (W4)

The pool page follows the export's token page: a 17px breadcrumb, a 57px
header (54px r16 identity, name 26/600 with the mono symbol and the launch
mode chip on a 34px row, then the short address with copy and explorer beside
`launched <age> by <sender>` on an 18px line; the age is `since()` against the
server's render clock, passed down as `renderedAt` so both sides of hydration
paint the same text), the chart panel at 233px from the top on a 1440x1000
desktop (export 224) and 529px on a 390px phone (export 529), then the stat
cards and the tabs panel.

The chart panel is 498px: a 98px head (18px padding, the 30/600 mono price
with its 14px ETH unit and the 15/600 signed change on a 42px row, the
`1h 6h 24h 7d` changes the evidence supports on a 17px row, and the 32px range
control at the right), a 390px chart region and 8px under it. The panel holds
no select: the candle interval follows the range (5m -> 1s or 1m, 1h -> 1m,
6h and 24h -> 5m, 1W -> 1h, All by the loaded span) and the OHLC readout is a
tooltip at the crosshair. On the phone the head is 168px (the control wraps
under the changes on a 50px row) over a 282px region, the export's 460px
panel. The region's two reserved heights are 390px and 156px on the desktop
(282px and 156px on the phone); a launch-only row shows the empty state alone,
with no head.

Every slot is fixed at first paint: the pending address is a skeleton of the
short address's shape (11 mono characters and two 18px controls) so the launch
line after it never moves, and that line, the symbol and chip after the name,
the signed change after the price and the centred empty-state headings are
remounted with the response rather than rewritten, because Chrome scores a
rewritten text run whose start moves as a shift. The price box is the row's
42px whether or not a subscript hangs in it. Stat cards are the export's 95px
(14px padding, 16px label, 23px value at 18/600, 15px fact line, or the same
height without one); the volume card's fact line is the trade count from the
same source as its figure.

Viewport-matched screenshots are retained in `docs/evidence/layout-2026-09-15/`
(`screener-before-desktop.png` / `screener-after-desktop.png`, and mobile peers).
They use the same real preloaded fixture with chain refresh disabled. Current
live coverage counts are intentionally not hardcoded into these screenshots.

The design's two most-used colours are **missing entirely** from the implementation.

| Design colour | Uses   | Role             | In impl?                |
| ------------- | ------ | ---------------- | ----------------------- |
| `#9a9aa4`     | **83** | secondary text   | ❌ **missing**          |
| `#8a8a94`     | 83     | muted text       | ✅ `--muted`            |
| `#f2f2f5`     | 61     | primary text     | ✅ `--text`             |
| `#b4b4be`     | **51** | bright secondary | ❌ **missing**          |
| `#7a7a85`     | 12     | faint            | ❌ (impl has `#777781`) |

The design runs a **five-step text ramp**: `f2f2f5 → b4b4be → 9a9aa4 → 8a8a94 → 7a7a85`.
The implementation has three, and is missing the two most-used steps.

Same story for surfaces and lines:

| Design                                                    | Uses      | Role               | In impl?                                     |
| --------------------------------------------------------- | --------- | ------------------ | -------------------------------------------- |
| `#22222a`                                                 | 37        | raised border      | ❌ missing                                   |
| `#1a1a1f`                                                 | 28        | line               | ✅ `--line`                                  |
| `#101014`                                                 | 26        | panel raised       | ✅                                           |
| `#17171c`                                                 | 25        | grid / subtle line | ❌ missing                                   |
| `#0e0e11`                                                 | 23        | panel              | ✅                                           |
| `#131317`                                                 | 20        | surface step       | ❌ missing                                   |
| `#33333d`                                                 | 19        | hover border       | ❌ missing (hardcoded in `candles.tsx` only) |
| `#1c1c22` · `#1e1e25` · `#26262e` · `#2a2a33` · `#3a3a44` | 6–13 each | elevation steps    | ❌ missing                                   |

**Twelve neutrals missing.** A design with a graduated ramp rendered with 6 flat values reads as cheap regardless of layout — this is the single largest contributor to "looks off."

---

## Defect 3 — wrong accent

|                | Colour           | Uses in design            |
| -------------- | ---------------- | ------------------------- |
| **Design**     | `#fc72ff` (pink) | **53**                    |
| Implementation | `#4de1c1` (teal) | primary accent everywhere |

The design is built around pink. `#4de1c1` appears only 6 times in the design file — it's a minor secondary, not the primary accent.

Note `--ac: {{ accent }}` is a template variable in the design source, so the accent was intended to be themeable, but every rendered instance uses `#fc72ff`.

_Aside:_ `#fc72ff` is Uniswap's interface pink. A colour isn't a trademark, and the design folder's Uniswap wordmark is **not** referenced in the HTML (verified: 0 occurrences), so there's no mark usage. Just be aware the palette reads as deliberately Uniswap-adjacent — which is probably the intent, and is fine as long as the wordmark stays out.

---

## Defect 4 — body type is one step too large

|                    | Design                      | Impl              |
| ------------------ | --------------------------- | ----------------- |
| Dominant body size | **13px (35×) / 12px (34×)** | `font-size: 14px` |
| Label sizes        | 10px, 11px                  | —                 |
| Headings           | 14–20px                     | —                 |
| Display            | 26, 30, 32, 34px            | —                 |

Shipping 14px where the design specifies 12–13px inflates every row, cell and label. Combined with the missing neutrals, that's most of the perceived difference.

**Weights:** 600 dominates (80×), then 500 (45×), 700 (16×), 400 (13×), 300 (5×). If components default to 400/500 the design will read soft — it leans on 600 far more than typical.

**Letter-spacing:** `.04em` on uppercase labels (25×), `.1em` on the smallest ones, and negative tracking `-.02em` to `-.035em` on large numerals and display text. The impl has `-0.015em` on `.number` only.

**Radii:** design uses 3, 5, 6, 7, 8, 9, 10, 11, 14, 16px — with **10px (28×) and 16px (22×)** dominant. Define a scale rather than letting components pick arbitrarily.

---

## Target `@theme` block

Replace the `:root` block in `apps/web/src/app/globals.css`:

```css
@import "tailwindcss";

@theme {
  /* surfaces — dark to light */
  --color-bg: #08080a;
  --color-panel: #0e0e11;
  --color-panel-raised: #101014;
  --color-panel-hover: #121216;
  --color-surface-3: #131317;
  --color-surface-4: #17171c;
  --color-surface-5: #1c1c22;
  --color-surface-6: #1e1e25;

  /* lines — subtle to prominent */
  --color-line: #1a1a1f;
  --color-line-strong: #22222a;
  --color-line-hover: #33333d;
  --color-line-raised: #26262e;
  --color-line-active: #2a2a33;
  --color-line-bright: #3a3a44;

  /* text ramp — five steps, brightest first */
  --color-text: #f2f2f5;
  --color-text-2: #b4b4be;
  --color-text-3: #9a9aa4;
  --color-muted: #8a8a94;
  --color-faint: #7a7a85;

  /* semantic */
  --color-accent: #fc72ff;
  --color-accent-deep: #45184f;
  --color-up: #3fd68c;
  --color-up-soft: #7fd9a6;
  --color-up-bg: #06120d;
  --color-down: #ff6169;
  --color-warn: #e0b45c;
  --color-warn-bright: #ffc94d;
  --color-warn-bg: #4a3a16;

  /* type */
  --font-sans: var(--font-geist);
  --font-mono: var(--font-geist-mono);
  --text-2xs: 9px;
  --text-xs: 10px;
  --text-sm: 11px;
  --text-base: 12px;
  --text-md: 13px;
  --text-lg: 14px;
  --text-xl: 17px;
  --text-2xl: 20px;
  --text-3xl: 26px;
  --text-4xl: 34px;

  /* radii */
  --radius-xs: 3px;
  --radius-sm: 5px;
  --radius-md: 7px;
  --radius-lg: 9px;
  --radius-xl: 10px;
  --radius-2xl: 14px;
  --radius-3xl: 16px;
}

body {
  font-size: 13px;
} /* was 14px */
```

Every existing `bg-panel`, `text-muted`, `border-line` className now resolves to the design system instead of Tailwind defaults.

---

## Implementation order for Codex

1. **Add the `@theme` block** and drop `body` to 13px. Nothing else. Look at the result — a large share of the mismatch will resolve from this alone, because 566 classNames start resolving correctly.
2. **Swap the accent** teal → `#fc72ff`. Update `components/ui.tsx:39` (`color = "#4DE1C1"` default) and the OG card route literals in `app/cards/[filename]/route.tsx`.
3. **Apply the text ramp.** Audit components for secondary text currently using `--muted`; the design's most common secondary is `#9a9aa4` (`text-text-3`), with `#b4b4be` (`text-text-2`) above it.
4. **Apply line steps.** Anywhere a border is currently `--line`, check whether the design wants `line-strong` (`#22222a`) — it's used 37× vs 28×.
5. **Radii + weights.** Default component weight to 600, not 400/500. Standardise radii on 10px (cards/rows) and 16px (large containers).
6. **Sync the literals.** `candles.tsx` and the OG card route can't read CSS variables — satori and lightweight-charts both need literal hex. Keep a single exported constants object in `packages/core` that both the `@theme` block and those two files derive from, so they can't drift again.

Do **not** attempt 2–5 before 1. Without `@theme` those edits get silently overridden by Tailwind defaults and you'll be chasing ghosts.

---

## Verify

The design file is a full rendered page — open both side by side at the same viewport:

```sh
open "~/Downloads/Poolsinfo Design System/poolsinfo.html"
pnpm dev   # localhost:3100
```

Compare in this order: row density → text brightness steps → border contrast → accent → radii. That's roughly the order of perceptual impact.
