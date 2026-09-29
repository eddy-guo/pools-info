import { test, expect } from "@playwright/test";

const rankedAddress = "0x1212121212121212121212121212121212121212";
const unrankedAddress = "0x3434343434343434343434343434343434343434";
const coverage = { scope: "indexed", pools: 1, fromBlock: 1, toBlock: 100 };

test("search shows only a ranked wallet's chip without moving rows", async ({
  page,
}, testInfo) => {
  const width = testInfo.project.name === "mobile" ? 390 : 1440;
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.addInitScript(() => {
    const state = { score: 0 };
    Object.assign(window, { rankShift: state });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!shift.hadRecentInput) state.score += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  let release: () => void = () => {};
  let requested = false;
  await page.route("**/api/product/search/?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query !== "wallet:rank-fixture") {
      await route.fulfill({
        json: { entries: [], total: 0, kind: "text", coverage },
      });
      return;
    }
    requested = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        entries: [
          {
            id: `wallet:${rankedAddress}`,
            group: "Wallets",
            address: rankedAddress,
            title: "Ranked wallet",
            context: "Saved wallet",
            terms: [rankedAddress],
            href: `/wallet/${rankedAddress}/`,
            traderRank: {
              rank: 12,
              window: "7d",
              metric: "realized",
              asOf: 1790000000,
            },
          },
          {
            id: `wallet:${unrankedAddress}`,
            group: "Wallets",
            address: unrankedAddress,
            title: "Unranked wallet",
            context: "Saved wallet",
            terms: [unrankedAddress],
            href: `/wallet/${unrankedAddress}/`,
          },
        ],
        total: 2,
        kind: "text",
        coverage,
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search Pools Info" });
  await dialog.getByRole("textbox").fill("wallet:rank-fixture");
  await expect.poll(() => requested).toBe(true);
  await expect(dialog.locator('[data-skeleton="search"]')).toBeVisible();
  const footer = dialog.locator(".search-dialog-footer");
  const pendingFooterY = (await footer.boundingBox())!.y;
  // Let Chrome's recent-input window expire before releasing the answer.
  // Otherwise it suppresses a real footer shift from the CLS score.
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    (window as Window & { rankShift: { score: number } }).rankShift.score = 0;
  });
  release();
  const ranked = dialog.locator(`a[href="/wallet/${rankedAddress}/"]`);
  const unranked = dialog.locator(`a[href="/wallet/${unrankedAddress}/"]`);
  await expect(ranked).toBeVisible();
  await expect(unranked).toBeVisible();
  const chip = ranked.locator(".search-rank-chip");
  await expect(chip).toHaveText("#12");
  await expect(chip).toHaveAttribute("aria-label", "rank 12, 7d realized");
  await expect(unranked.locator(".search-rank-chip")).toHaveCount(0);
  const rankedBox = await ranked.boundingBox();
  const unrankedBox = await unranked.boundingBox();
  expect(rankedBox?.height).toBe(unrankedBox?.height);
  expect((await footer.boundingBox())!.y).toBe(pendingFooterY);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(
      () =>
        (window as Window & { rankShift: { score: number } }).rankShift.score,
    ),
  ).toBe(0);
});
