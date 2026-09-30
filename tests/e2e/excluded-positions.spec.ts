import { test, expect, type Page } from "@playwright/test";

// The saved dataset serves no `excludedByFlag` breakdown, so the reads are
// given one here: every third wallet has nothing to disclose, the others
// carry unattributed-swap exclusions beside one of another flag, which the
// caption must not count.
const breakdown = (index: number) => ({
  zero_cost_inflow: 1,
  unattributed_outflow: 0,
  unknown_basis: 0,
  unattributed_swap_activity: index % 3 === 2 ? 0 : index % 3 === 0 ? 52 : 1234,
});
const caption = (count: string) =>
  `${count} positions excluded (pooled or unattributed swap)`;

async function serveBreakdown(page: Page) {
  await page.route("**/api/product/leaderboard/**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    body.items = body.items.map((w: object, i: number) => ({
      ...w,
      excludedByFlag: breakdown(offset + i),
    }));
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/product/wallets/**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.wallet)
      body.wallet = { ...body.wallet, excludedByFlag: breakdown(0) };
    await route.fulfill({ response, json: body });
  });
}

test("the board discloses pooled-swap exclusions on the podium and every row inside their reserved heights", async ({
  page,
}) => {
  await serveBreakdown(page);
  await page.goto("/traders/?window=7d");
  const podium = page.locator(".trader-podium-card");
  await expect(
    podium.nth(0).locator(".trader-podium-card-excluded"),
  ).toHaveText(caption("52"));
  await expect(
    podium.nth(1).locator(".trader-podium-card-excluded"),
  ).toHaveText(caption("1,234"));
  // Nothing to disclose keeps the line blank, so the three cards match.
  await expect(
    podium.nth(2).locator(".trader-podium-card-excluded"),
  ).toHaveText("");
  const heights = await podium.evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect().height),
  );
  expect(new Set(heights).size).toBe(1);

  // Ranks 4, 5 and 6 are the list's first three rows (indexes 3, 4, 5).
  const phone = await page.locator(".mobile-traders").first().isVisible();
  const rows = phone
    ? page.locator(".mobile-traders .mobile-trader[data-row='resolved']")
    : page.locator(".desktop-traders tbody tr[data-row='resolved']");
  const captionOf = phone
    ? ".mobile-trader-excluded"
    : ".trader-excluded-caption";
  await expect(rows.nth(0).locator(captionOf)).toHaveText(caption("52"));
  await expect(rows.nth(1).locator(captionOf)).toHaveText(caption("1,234"));
  await expect(rows.nth(2).locator(captionOf)).toHaveCount(0);
  const rowGeometry = await rows.evaluateAll((nodes) =>
    nodes.slice(0, 3).map((row) => ({
      height: row.getBoundingClientRect().height,
      overflows: row.scrollHeight > row.getBoundingClientRect().height + 0.5,
    })),
  );
  const height = phone ? 101 : 60;
  expect(rowGeometry).toEqual(Array(3).fill({ height, overflows: false }));
});

test("the wallet header discloses the pooled-swap count, not the total", async ({
  page,
}) => {
  await serveBreakdown(page);
  await page.goto("/traders/?window=7d");
  const href = await page
    .locator("[data-row='resolved'] a[href^='/wallet/']")
    .first()
    .getAttribute("href");
  await page.goto(href!);
  await expect(page.locator(".wallet-excluded-note")).toHaveText(caption("52"));
});
