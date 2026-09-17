import { test, expect } from "@playwright/test";

/* A token's subtitle stays inside its own cell. On the desktop the export's
   `SYMBOL · age · N trades` line has a 250px column at both widths (the table
   holds its 1030px and scrolls below it), so page one reads whole, with no
   ellipsis; the mobile card keeps its symbol and launch date and is checked
   against its price slot too. */

const widths = { desktop: [1200, 1440], mobile: [390] };

test("a token subtitle never reaches the price on page one", async ({
  page,
}, testInfo) => {
  const desktop = testInfo.project.name === "desktop";
  for (const width of desktop ? widths.desktop : widths.mobile) {
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
        const price = row
          .querySelector(".price")!
          .closest(layout === ".desktop-pools" ? "td" : "span:not(.price)")!;
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
          subtitle: subtitle.textContent,
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
      body: JSON.stringify(rows),
      contentType: "application/json",
    });
    expect(rows.length, "page one has rows").toBeGreaterThan(0);
    for (const row of rows)
      expect(row.intersects, `${row.subtitle} at ${width}px`).toBe(false);
    if (desktop) {
      expect(
        [...new Set(rows.map((row) => row.height))],
        "rows keep 62px",
      ).toEqual([62]);
      for (const row of rows) {
        expect(row.subtitle, `${row.subtitle} at ${width}px`).toMatch(
          /^.+ · (<1m|\d+[mhd]) · [\d,]+ trades$/,
        );
        expect(row.truncated, `${row.subtitle} reads whole at ${width}px`).toBe(
          false,
        );
      }
    }
  }
});
