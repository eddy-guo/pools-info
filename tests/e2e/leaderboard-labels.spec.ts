import { test, expect, type Page } from "@playwright/test";

// Evidence and method copy the captain struck from the leaderboard; a real
// user sees the ranking, never how it was assembled.
const removedCopy = [
  "covered pools",
  "Covered pools",
  "Transfer-verified",
  "History incomplete",
  "Swap-based estimate",
  "Mixed evidence",
  "Accounting pending",
  "eligible",
  "excluded",
  "Refresh saved rankings",
  "purchase basis",
  "zero cost",
];

async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}

async function expectStripped(page: Page) {
  const main = page.locator("main");
  const text = await main.innerText();
  for (const copy of removedCopy) expect(text, copy).not.toContain(copy);
  await expect(main.locator(".evidence-badge")).toHaveCount(0);
  await expect(main.getByRole("button", { name: /refresh/i })).toHaveCount(0);
}

test("the leaderboard carries no evidence labels across its window controls", async ({
  page,
}) => {
  await page.goto("/traders/?window=All");
  await settled(page);
  await expectStripped(page);
  const main = page.locator("main");
  const podium = main.locator(".live-podium > a");
  await expect(podium).toHaveCount(3);
  for (const card of await podium.all())
    await expect(card.locator("small")).toHaveText(/^#\d+$/);
  const desktop = main.locator(".desktop-traders");
  if (await desktop.isVisible()) {
    const row = desktop.locator("tbody tr[data-row=resolved]").first();
    const trader = row.locator("td").nth(1);
    // The address link is the whole cell: nothing sits under it.
    await expect(trader.locator("> *")).toHaveCount(1);
    await expect(trader.locator("> a")).toHaveText(
      /^0x[0-9a-f]{4}…[0-9a-f]{4}$/,
    );
    await expect(row.locator("td").nth(7)).toHaveText(/^\d+$/);
  } else {
    const card = main.locator(".mobile-trader").first();
    await expect(card.locator(".mobile-trader-heading > *")).toHaveCount(2);
    await expect(card.locator(".panel-footnote")).toHaveCount(0);
    expect(
      await card.evaluate((node) => node.scrollHeight <= node.clientHeight),
      "the card content fits its reserved height",
    ).toBe(true);
  }
  for (const window of ["24h", "7d", "30d"]) {
    await main.getByRole("button", { name: window, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]window=${window}(?:&|$)`));
    await settled(page);
    await expectStripped(page);
  }
});

test("an empty window asks for a wider one and nothing else", async ({
  page,
}) => {
  await page.route("**/api/product/leaderboard/**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: { ...payload, items: [], total: 0, nextOffset: null },
    });
  });
  await page.goto("/traders/?window=24h");
  await settled(page);
  const empty = page.locator("main .empty-state");
  await expect(empty.locator("h3")).toHaveText(
    "No qualifying traders in this window",
  );
  await expect(empty.locator("p")).toHaveText("Try a wider window.");
  await expectStripped(page);
});
