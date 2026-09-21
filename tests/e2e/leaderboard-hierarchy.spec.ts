import { test, expect, type Locator } from "@playwright/test";

const px = (value: string) => Number.parseFloat(value);
const up = "rgb(63, 214, 140)",
  down = "rgb(255, 97, 105)",
  secondaryTone = "rgb(180, 180, 190)";

/** The podium always holds ranks 1-3, so a saved-fixture row index maps to
    the flat list's own position (data-row-index, and `rows.nth(...)`) three
    ranks later. */
const LIST_OFFSET = 3;

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
  const items: { roi: number | null }[] = payload.items;
  // Ranks 1-3 live in the podium, not the flat list, so the search starts
  // past them.
  const positive =
    LIST_OFFSET +
    items
      .slice(LIST_OFFSET)
      .findIndex((item) => item.roi !== null && item.roi > 0);
  const negative =
    LIST_OFFSET +
    items
      .slice(LIST_OFFSET)
      .findIndex((item) => item.roi !== null && item.roi < 0);
  expect(positive, "the saved fixture ranks a positive ROI").toBeGreaterThan(
    LIST_OFFSET - 1,
  );
  expect(negative, "the saved fixture ranks a negative ROI").toBeGreaterThan(
    LIST_OFFSET - 1,
  );
  await page.goto("/traders/?window=All");
  const desktop = page.locator(".desktop-traders");
  if (await desktop.isVisible()) {
    const rows = desktop.locator("tbody tr[data-row=resolved]");
    await expect(rows.first()).toBeVisible();
    const listPositive = positive - LIST_OFFSET,
      listNegative = negative - LIST_OFFSET;
    const cells = (index: number) => rows.nth(index).locator("td");
    const roiUp = cells(listPositive).nth(3).locator(".change");
    const roiDown = cells(listNegative).nth(3).locator(".change");
    await expect(roiUp).toHaveText(
      `+${payload.items[positive].roi.toFixed(2)}%`,
    );
    await expect(roiDown).toHaveText(
      `${payload.items[negative].roi.toFixed(2)}%`,
    );
    await expect(roiUp).toHaveCSS("color", up);
    await expect(roiDown).toHaveCSS("color", down);
    const realized = await typography(cells(listPositive).nth(2));
    const roi = await typography(cells(listPositive).nth(3));
    const record = await typography(cells(listPositive).nth(4));
    const secondary = await Promise.all(
      [5, 6, 7, 8, 9].map((index) =>
        typography(cells(listPositive).nth(index)),
      ),
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
    await expect(cells(listPositive).nth(2).locator(".number")).toHaveCSS(
      "color",
      up,
    );
    await expect(cells(listPositive).nth(8).locator(".number")).not.toHaveCSS(
      "color",
      up,
    );
    expect(
      await rows.first().evaluate((row) => row.getBoundingClientRect().height),
    ).toBe(60);
    return;
  }
  const cards = page.locator(".mobile-trader");
  const listPositive = positive - LIST_OFFSET,
    listNegative = negative - LIST_OFFSET;
  await expect(
    cards.nth(listPositive).locator(".mobile-trader-pnl"),
  ).toBeVisible();
  const roiUp = cards.nth(listPositive).locator(".mobile-trader-pnl .change");
  const roiDown = cards.nth(listNegative).locator(".mobile-trader-pnl .change");
  await expect(roiUp).toHaveText(`+${payload.items[positive].roi.toFixed(2)}%`);
  await expect(roiDown).toHaveText(
    `${payload.items[negative].roi.toFixed(2)}%`,
  );
  await expect(roiUp).toHaveCSS("color", up);
  await expect(roiDown).toHaveCSS("color", down);
  const pnl = await typography(
    cards.nth(listPositive).locator(".mobile-trader-pnl .number:not(.change)"),
  );
  const foot = await typography(
    cards.nth(listPositive).locator(".mobile-trader-foot-stat").first(),
  );
  expect(px(pnl.fontSize)).toBeGreaterThan(px(foot.fontSize));
  expect(pnl.fontWeight).toBeGreaterThan(foot.fontWeight);
  expect(foot.numerals).toBe("tabular-nums");
  expect(
    await cards
      .nth(listPositive)
      .evaluate((card) => card.scrollHeight <= card.clientHeight),
    "the card content fits its reserved height",
  ).toBe(true);
});

/* Between the phone rows and a wide panel the fixed numeric columns used to
   squeeze the auto-width Trader column to nothing (0px at 768 and 1024, 27px
   at 1180), so the address chip drew over the realized PnL beside it. A board
   too narrow for the table now shows its rows, which have no Trader column. */
for (const width of [768, 1024, 1280]) {
  test(`the Trader column holds its address chip clear of the PnL at ${width}px`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "the phone rows have no Trader column");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/traders/?window=All");
    const cards = page.locator(".mobile-traders .mobile-trader");
    const row = page
      .locator(".desktop-traders tbody tr[data-row=resolved]")
      .first();
    await expect(
      row.or(cards.first()).filter({ visible: true }).first(),
    ).toBeVisible();
    if (await cards.first().isVisible()) {
      await expect(page.locator(".desktop-traders")).toBeHidden();
      return;
    }
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

test("the podium shows a rank medallion, chip, PnL, realized/ROI line, win/loss bar and record in that order, 180±4px tall", async ({
  page,
}) => {
  await page.goto("/traders/?window=All");
  const cards = page.locator(".trader-podium-card");
  await expect(cards).toHaveCount(3);
  const first = cards.first();
  await expect(first).toBeVisible();

  // The follow toggle is a top-3 wallet's own row control, not part of the
  // export's measured content order, so it is excluded from this check.
  const order = await first.evaluate((node) =>
    Array.from(node.children)
      .map((child) => child.className)
      .filter((cls) => !cls.includes("follow-toggle")),
  );
  expect(order).toEqual([
    "trader-podium-card-head",
    "trader-podium-card-pnl",
    "trader-podium-card-meta",
    "wl-bar",
    "trader-podium-card-record",
  ]);

  // 180±4px is the export's own measurement at 1440; the phone card grows a
  // little for the chip's 44px touch targets, so only the desktop viewport
  // is held to that exact band.
  const height = await first.evaluate(
    (node) => node.getBoundingClientRect().height,
  );
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 1440) {
    expect(height).toBeGreaterThanOrEqual(176);
    expect(height).toBeLessThanOrEqual(184);
  } else {
    expect(height).toBeGreaterThan(0);
  }

  const rank = await typography(first.locator(".trader-podium-card-rank"));
  expect(rank.fontSize).toBe("13px");
  expect(rank.fontWeight).toBe(700);
  const rankBox = await first
    .locator(".trader-podium-card-rank")
    .evaluate((node) => node.getBoundingClientRect());
  expect(rankBox.width).toBe(34);
  expect(rankBox.height).toBe(34);
  await expect(first.locator(".trader-podium-card-rank")).toHaveCSS(
    "border-radius",
    "10px",
  );

  const chip = await typography(first.locator(".address-chip .mono").first());
  expect(chip.fontSize).toBe("14px");
  expect(chip.fontWeight).toBe(500);
  const address = await first
    .locator(".address-chip-link")
    .getAttribute("title");
  expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  const podiumIdentity = await first
    .locator(".address-chip .avatar")
    .evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        initials: node.getAttribute("data-initials"),
        hidden: node.getAttribute("aria-hidden"),
        pseudo: getComputedStyle(node, "::before").content,
        background: style.backgroundColor,
        color: style.color,
        width: rect.width,
        height: rect.height,
      };
    });
  expect(podiumIdentity).toMatchObject({
    initials: address!.slice(2, 4).toUpperCase(),
    hidden: "true",
    width: 30,
    height: 30,
  });
  expect(podiumIdentity.pseudo).toContain(podiumIdentity.initials);

  const pnl = await typography(
    first.locator(".trader-podium-card-pnl .number"),
  );
  expect(pnl.fontSize).toBe("27px");
  expect(pnl.fontWeight).toBe(600);
  await expect(first.locator(".trader-podium-card-pnl .number")).toHaveCSS(
    "letter-spacing",
    "-0.81px",
  ); // -0.03em of 27px

  const meta = await typography(first.locator(".trader-podium-card-meta"));
  expect(meta.fontSize).toBe("12.5px");
  expect(meta.fontWeight).toBe(400);

  const barHeight = await first
    .locator(".wl-bar")
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(barHeight).toBe(5);

  const record = await typography(first.locator(".trader-podium-card-record"));
  expect(record.fontSize).toBe("12px");
  expect(record.fontWeight).toBe(400);
  await expect(first.locator(".trader-podium-card-record")).toHaveText(
    /^\d+W · \d+L\d+ trades$/,
  );

  // The board uses the wallet header's canonical monogram rather than a
  // second identity algorithm.
  await page.goto(`/wallet/${address}/?window=All`);
  const walletIdentity = await page
    .locator(".page-heading .avatar")
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        initials: node.getAttribute("data-initials"),
        background: style.backgroundColor,
        color: style.color,
      };
    });
  expect(walletIdentity).toEqual({
    initials: podiumIdentity.initials,
    background: podiumIdentity.background,
    color: podiumIdentity.color,
  });
});

test("the flat list starts at rank 4 when the podium shows, with a bar and relative age in every row", async ({
  page,
}) => {
  await page.goto("/traders/?window=All");
  const desktop = page.locator(".desktop-traders");
  if (await desktop.isVisible()) {
    const firstRow = desktop.locator("tbody tr[data-row=resolved]").first();
    await expect(firstRow.locator("td").first()).toHaveText("#4");
    const wl = firstRow.locator("td").nth(4);
    await expect(wl.locator(".wl-bar")).toHaveCount(1);
    await expect(wl).toHaveText(/^\d+W · \d+L$/);
    const last = firstRow.locator("td").nth(9);
    await expect(last.locator("span")).toHaveText(/^\d+[smhd]$/);
    const title = await last.locator("span").getAttribute("title");
    expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  } else {
    const firstCard = page.locator(".mobile-trader").first();
    await expect(
      firstCard.locator(".mobile-trader-identity .rank-number"),
    ).toHaveText("#4");
  }
});
