import { test, expect } from "@playwright/test";

/*
 * The wallet page's rule-change disclosure: the date on which a sell routed
 * through a pooled swap came to be attributed to each contributor
 * (`pooledSwapsAttributedSince` on the wallet read, the ledger's own swap-in
 * date). The fixture deployment serves none, so the served state is exercised
 * by rewriting the route's own response, as wallet-trades.spec.ts does for the
 * Trades tab; the slot lives inside the fixed-height positions context row,
 * so the line's arrival moves nothing and the row keeps its height in both
 * states.
 */
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const walletRead = /\/api\/product\/wallets\/0x[0-9a-f]{40}\/\?window=/;
/** 1 Oct 2026 12:00 UTC: the day is named in UTC whatever the browser's zone. */
const since = Date.UTC(2026, 9, 1, 12) / 1000;

test("the positions row discloses the attribution date the read serves, and nothing when it serves none", async ({
  page,
}) => {
  await page.goto(`/wallet/${wallet}/?window=All`);
  const row = page.locator(".wallet-positions-context");
  await expect(row).toContainText("Still held");
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  const note = row.locator(".wallet-rule-note");
  await expect(note).toHaveText("");
  const bare = await row.boundingBox();

  await page.route(walletRead, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, pooledSwapsAttributedSince: since },
    });
  });
  await page.goto(`/wallet/${wallet}/?window=All`);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(row.locator(".wallet-rule-note")).toHaveText(
    "Pooled-sell rule changed 1 Oct 2026",
  );
  await expect(row).toContainText("Still held");
  const disclosed = await row.boundingBox();
  expect(disclosed!.height).toBe(bare!.height);
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
});

test("the disclosure yields to the Still held figure on a phone rather than widening the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(walletRead, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, pooledSwapsAttributedSince: since },
    });
  });
  await page.goto(`/wallet/${wallet}/?window=All`);
  const row = page.locator(".wallet-positions-context");
  await expect(row.locator(".wallet-rule-note")).toContainText(
    "Pooled-sell rule",
  );
  await expect(row).toContainText("Still held");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
