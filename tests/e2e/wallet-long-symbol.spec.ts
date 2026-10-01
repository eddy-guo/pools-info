import { test, expect, type Page } from "@playwright/test";

/* A token names itself with whatever string it likes: production's rank-1
   wallet holds a 20-glyph emoji symbol. The positions table repeats the
   symbol after the holding quantity in a fixed 150px column, so a symbol that
   long must ellipsise inside that cell rather than draw over Cost beside it,
   the way the phone row's token line already does. */

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const symbol = "🤑💰💵💴💶🪙💳🧾🏦💹💱📇🗃💼📊📋🖊🔍🔎📰";

async function serveLongSymbol(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { layoutMeasurement: state });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.route(`**/api/product/wallets/${wallet}/**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const held = body.positions.findIndex(
      (p: { position: unknown; decimals: unknown }) =>
        p.position && p.decimals !== null,
    );
    expect(held, "the wallet has a position with a holding").toBeGreaterThan(
      -1,
    );
    body.positions[held] = { ...body.positions[held], symbol };
    await route.fulfill({ response, json: body });
  });
}

for (const width of [1440, 1024]) {
  test(`a long emoji symbol stays inside its own cells at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the table is desktop's");
    await page.setViewportSize({ width, height: 1000 });
    await serveLongSymbol(page);
    await page.goto(`/wallet/${wallet}/?window=All`);
    const row = page
      .locator(".wallet-positions-table tbody tr[data-row='resolved']")
      .filter({ hasText: symbol });
    await expect(row).toHaveCount(1, { timeout: 20000 });
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);

    const cells = await row.evaluate((tr) =>
      // Every cell on show: under 780px the Cost column drops out.
      [...tr.querySelectorAll("td")]
        .filter((td) => getComputedStyle(td).display !== "none")
        .map((td) => {
          const box = td.getBoundingClientRect();
          const style = getComputedStyle(td);
          const right = box.right - parseFloat(style.paddingRight);
          return {
            text: td.textContent,
            // Every descendant box stays inside the cell's content box, and
            // nothing overflows the cell itself.
            escapes: [...td.querySelectorAll("*")].filter(
              (node) => node.getBoundingClientRect().right > right + 0.5,
            ).length,
            overflows: td.scrollWidth > td.clientWidth,
          };
        }),
    );
    // The whole symbol stays in the text, for the accessible name and copy.
    expect(cells[0].text).toContain(symbol);
    expect(cells[1].text).toContain(symbol);
    expect(
      cells.map(({ escapes, overflows }) => ({ escapes, overflows })),
    ).toEqual(Array(cells.length).fill({ escapes: 0, overflows: false }));
    // The quantity itself is never the part that is cut.
    const quantity = row.locator("td:nth-child(2) .wallet-holding-quantity");
    expect(
      await quantity.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);

    const cls = await page.evaluate(
      () =>
        (window as unknown as { layoutMeasurement: { cls: number } })
          .layoutMeasurement.cls,
    );
    expect(cls).toBeLessThan(0.001);
  });
}
