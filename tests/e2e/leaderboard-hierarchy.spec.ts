import { test, expect, type Locator } from "@playwright/test";

const px = (value: string) => Number.parseFloat(value);
const up = "rgb(63, 214, 140)",
  down = "rgb(255, 97, 105)",
  secondaryTone = "rgb(180, 180, 190)";

async function typography(locator: Locator) {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fontSize: style.fontSize,
      fontWeight: Number(style.fontWeight),
      color: style.color,
      numerals: style.fontVariantNumeric,
      align: style.textAlign,
    };
  });
}

test("leaderboard leads with signed realized, ROI and W/L over secondary columns", async ({
  page,
  request,
}) => {
  const payload = await (
    await request.get("/api/product/leaderboard/?window=All")
  ).json();
  const positive = payload.items.findIndex(
    (item: { roi: number | null }) => item.roi !== null && item.roi > 0,
  );
  const negative = payload.items.findIndex(
    (item: { roi: number | null }) => item.roi !== null && item.roi < 0,
  );
  expect(positive, "the saved fixture ranks a positive ROI").toBeGreaterThan(
    -1,
  );
  expect(negative, "the saved fixture ranks a negative ROI").toBeGreaterThan(
    -1,
  );
  await page.goto("/traders/?window=All");
  const desktop = page.locator(".desktop-traders");
  if (await desktop.isVisible()) {
    const rows = desktop.locator("tbody tr[data-row=resolved]");
    await expect(rows.first()).toBeVisible();
    const cells = (index: number) => rows.nth(index).locator("td");
    const roiUp = cells(positive).nth(3).locator(".change");
    const roiDown = cells(negative).nth(3).locator(".change");
    await expect(roiUp).toHaveText(
      `+${payload.items[positive].roi.toFixed(2)}%`,
    );
    await expect(roiDown).toHaveText(
      `${payload.items[negative].roi.toFixed(2)}%`,
    );
    await expect(roiUp).toHaveCSS("color", up);
    await expect(roiDown).toHaveCSS("color", down);
    const realized = await typography(cells(positive).nth(2));
    const roi = await typography(cells(positive).nth(3));
    const record = await typography(cells(positive).nth(4));
    const secondary = await Promise.all(
      [5, 6, 7, 8, 9].map((index) => typography(cells(positive).nth(index))),
    );
    for (const primary of [realized, roi, record]) {
      expect(primary.align).toBe("right");
      expect(primary.numerals).toBe("tabular-nums");
      for (const cell of secondary) {
        expect(px(primary.fontSize)).toBeGreaterThan(px(cell.fontSize));
        expect(primary.fontWeight).toBeGreaterThan(cell.fontWeight);
        expect(cell.align).toBe("right");
        expect(cell.numerals).toBe("tabular-nums");
        expect(cell.color).toBe(secondaryTone);
      }
    }
    await expect(cells(positive).nth(2).locator(".number")).toHaveCSS(
      "color",
      up,
    );
    await expect(cells(positive).nth(8).locator(".number")).not.toHaveCSS(
      "color",
      up,
    );
    expect(
      await rows.first().evaluate((row) => row.getBoundingClientRect().height),
    ).toBe(62);
    return;
  }
  const cards = page.locator(".mobile-trader");
  await expect(cards.nth(positive).locator(".mobile-trader-key")).toBeVisible();
  const roiUp = cards.nth(positive).locator(".mobile-trader-key .change");
  const roiDown = cards.nth(negative).locator(".mobile-trader-key .change");
  await expect(roiUp).toHaveText(`+${payload.items[positive].roi.toFixed(2)}%`);
  await expect(roiDown).toHaveText(
    `${payload.items[negative].roi.toFixed(2)}%`,
  );
  await expect(roiUp).toHaveCSS("color", up);
  await expect(roiDown).toHaveCSS("color", down);
  const key = await Promise.all(
    [0, 1].map((index) =>
      typography(
        cards.nth(positive).locator(".mobile-trader-key strong").nth(index),
      ),
    ),
  );
  const stats = await Promise.all(
    [0, 1, 2].map((index) =>
      typography(
        cards.nth(positive).locator(".mobile-trader-stats strong").nth(index),
      ),
    ),
  );
  for (const primary of key)
    for (const stat of stats) {
      expect(px(primary.fontSize)).toBeGreaterThan(px(stat.fontSize));
      expect(primary.fontWeight).toBeGreaterThan(stat.fontWeight);
      expect(stat.numerals).toBe("tabular-nums");
      expect(stat.color).toBe(secondaryTone);
    }
  expect(
    await cards
      .nth(positive)
      .evaluate((card) => card.scrollHeight <= card.clientHeight),
    "the card content fits its reserved height",
  ).toBe(true);
});

/* Between the phone rows and a wide panel the fixed numeric columns used to
   squeeze the auto-width Trader column to nothing (0px at 768 and 1024, 27px
   at 1180), so the address chip drew over the realized PnL beside it. */
for (const width of [768, 1024, 1280]) {
  test(`the Trader column holds its address chip clear of the PnL at ${width}px`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "the phone rows have no Trader column");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/traders/?window=All");
    const row = page
      .locator(".desktop-traders tbody tr[data-row=resolved]")
      .first();
    await expect(row).toBeVisible();
    const geometry = await row.evaluate((node) => {
      const [, trader, pnl] = [...node.children] as HTMLElement[];
      const chip = trader.querySelector(".address-chip")!;
      let chipRight = chip.getBoundingClientRect().right;
      for (const part of chip.querySelectorAll("*")) {
        const box = part.getBoundingClientRect();
        if (box.width) chipRight = Math.max(chipRight, box.right);
      }
      const walker = document.createTreeWalker(pnl, NodeFilter.SHOW_TEXT);
      let pnlLeft = Infinity;
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        pnlLeft = Math.min(pnlLeft, range.getBoundingClientRect().left);
      }
      const cell = trader.getBoundingClientRect();
      return {
        traderWidth: cell.width,
        chipOverCell:
          chipRight -
          (cell.right - parseFloat(getComputedStyle(trader).paddingRight)),
        chipToPnl: pnlLeft - chipRight,
      };
    });
    expect(
      geometry.chipOverCell,
      `the chip stays inside its ${geometry.traderWidth}px cell`,
    ).toBeLessThanOrEqual(0);
    expect(
      geometry.chipToPnl,
      "the PnL text starts past the chip",
    ).toBeGreaterThan(0);
  });
}
