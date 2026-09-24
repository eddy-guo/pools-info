import { test, expect } from "@playwright/test";

/* A token's subtitle stays inside its own cell, and never truncates
   mid-segment - not even where the export's fixed 132/112/140/190px right-
   hand tracks (the accepted layout contract, PR #141) leave the Token
   column too narrow for `SYMBOL · age · N trades` in full. Instead, in that
   band (roughly 1163-1245px of table width; see globals.css's
   `pool-list (width < 868px)` query), the trailing trade count drops out as
   a whole unit - never a half-abbreviated number, never a dangling
   separator - leaving the untouched `SYMBOL · age`. The full line still
   reaches assistive tech and a mouse hover as `.row-subtitle`'s
   title/aria-label, so no information is lost, only not always shown. The
   mobile card keeps its symbol and launch date (trade count is never sent
   there) and is checked against its price slot too. */

const desktopWidths = [1163, 1200, 1245, 1280, 1440];
/** Below this table-driven band, the trailing trade count is expected to
    have dropped out; at and above it, the full line is expected to fit. */
const compactBelow = 1245;

test("a token subtitle never truncates mid-segment on page one, compacting its trade count instead", async ({
  page,
}, testInfo) => {
  const desktop = testInfo.project.name === "desktop";
  for (const width of desktop ? desktopWidths : [390]) {
    await page.setViewportSize({ width, height: desktop ? 1000 : 844 });
    await page.goto("/");
    const layout = desktop ? ".desktop-pools" : ".mobile-pools";
    await expect(
      page.locator(`${layout} [data-row='resolved'] .price`).first(),
    ).toBeVisible();
    const rows = await page.evaluate(async (layout) => {
      await document.fonts.ready;
      return [
        ...document.querySelectorAll(`${layout} [data-row='resolved']`),
      ].map((row) => {
        const subtitle = row.querySelector(".token-cell small")!;
        const rowSubtitle = row.querySelector(".row-subtitle");
        const trades = row.querySelector(".row-subtitle-trades");
        const price = row
          .querySelector(".price")!
          .closest(layout === ".desktop-pools" ? "td" : ".mobile-pool-price")!;
        /* The text's own extent, cut to the subtitle's box when that box
           clips its overflow. */
        const range = document.createRange();
        range.selectNodeContents(subtitle);
        const text = range.getBoundingClientRect();
        const box = subtitle.getBoundingClientRect();
        const clips = getComputedStyle(subtitle).overflowX !== "visible";
        const shown = {
          left: clips ? Math.max(text.left, box.left) : text.left,
          right: clips ? Math.min(text.right, box.right) : text.right,
          top: text.top,
          bottom: text.bottom,
        };
        const cell = price.getBoundingClientRect();
        return {
          /* What actually paints, unlike textContent, which still reports a
             display:none descendant's text. */
          visibleText: (subtitle as HTMLElement).innerText,
          fullTitle: rowSubtitle?.getAttribute("title") ?? null,
          fullAriaLabel: rowSubtitle?.getAttribute("aria-label") ?? null,
          tradesVisible: !!trades && trades.getClientRects().length > 0,
          truncated: subtitle.scrollWidth > subtitle.clientWidth,
          intersects:
            shown.left < cell.right &&
            shown.right > cell.left &&
            shown.top < cell.bottom &&
            shown.bottom > cell.top,
          height: Math.round(row.getBoundingClientRect().height),
        };
      });
    }, layout);
    await testInfo.attach(`subtitles-${width}`, {
      body: JSON.stringify(rows, null, 2),
      contentType: "application/json",
    });
    expect(rows.length, "page one has rows").toBeGreaterThan(0);
    for (const row of rows)
      expect(row.intersects, `${row.fullTitle} at ${width}px`).toBe(false);
    if (desktop) {
      expect(
        [...new Set(rows.map((row) => row.height))],
        "rows keep 62px",
      ).toEqual([62]);
      for (const row of rows) {
        // Never a browser ellipsis mid-segment, whatever the compaction
        // tier chose to show.
        expect(
          row.truncated,
          `${row.fullTitle} reads whole at ${width}px`,
        ).toBe(false);
        // The full line - trade count included, even where it is compacted
        // away visually - always reaches assistive tech and a hover.
        expect(row.fullTitle, `full title at ${width}px`).toMatch(
          /^.+ · (<1m|\d+[mhd]) · [\d,]+ trades$/,
        );
        expect(row.fullAriaLabel, `aria-label at ${width}px`).toBe(
          row.fullTitle,
        );
        if (width < compactBelow) {
          // Symbol and age are never touched; only the trailing trade
          // count drops, as a whole unit with its separator - never a
          // half-abbreviated count and never a dangling " · ".
          expect(
            row.tradesVisible,
            `${row.fullTitle} drops its trade count at ${width}px`,
          ).toBe(false);
          expect(row.visibleText, `${row.fullTitle} at ${width}px`).toMatch(
            /^.+ · (<1m|\d+[mhd])$/,
          );
        } else {
          expect(
            row.tradesVisible,
            `${row.fullTitle} keeps its trade count at ${width}px`,
          ).toBe(true);
          expect(row.visibleText, `${row.fullTitle} at ${width}px`).toBe(
            row.fullTitle,
          );
        }
      }
    }
  }
});
