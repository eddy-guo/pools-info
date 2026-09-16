import { test, expect } from "@playwright/test";

/* A token's subtitle (symbol and launch date) stays inside its own cell: the
   desktop token column sits at its floor up to 1440px, so the longest symbols
   on page one would otherwise run under the price beside them. The mobile card
   is checked against its price slot too. */

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
      if (width === 1200)
        expect(
          rows.some((row) => row.truncated),
          "page one carries a subtitle longer than its cell",
        ).toBe(true);
    }
  }
});
