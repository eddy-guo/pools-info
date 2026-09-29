import { expect, test, type Page } from "@playwright/test";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const explanation = "Own launches are not ranked";
const boardRule =
  "Top 100 by realized, at least 10 supported trades, own launches excluded";

async function observeShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { rankingExplanationShifts: state });
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
}

async function capture(page: Page, name: string, project: string) {
  const phase = process.env.FIGURES_AUDIT_CAPTURE;
  if (!phase) return;
  await page.screenshot({
    path: `docs/evidence/figures-audit-2026-09-29/d3/${phase}-${name}-${project}.png`,
    fullPage: false,
  });
}

test("an unranked wallet with launches explains its badge without moving the page", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(
    testInfo.project.name === "mobile"
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
  await observeShifts(page);
  await page.route(`**/api/product/wallets/${wallet}**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        wallet: { ...body.wallet, rank: null },
        launches: [
          {
            id: `0x${"1".padStart(64, "0")}`,
            token: `0x${"1".padStart(40, "0")}`,
            name: "Fixture launch",
            symbol: "FIX",
            launchTx: `0x${"2".padStart(64, "0")}`,
            launchSender: wallet,
            launchBlock: 65841861,
            launchedAt: 1789695885,
          },
        ],
      },
    });
  });

  await page.goto(`/wallet/${wallet}/?window=All`);
  await expect(page.locator(".wallet-page .page-heading")).toContainText(
    "UNRANKED",
  );
  await expect(page.getByRole("tab", { name: /Launches\s+1/ })).toBeVisible();
  await expect(page.locator(".wallet-page .page-heading")).toContainText(
    explanation,
  );
  await capture(page, "wallet", testInfo.project.name);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { rankingExplanationShifts: { cls: number } })
          .rankingExplanationShifts.cls,
    ),
  ).toBe(0);
});

test("a wallet without launches keeps its existing unranked badge", async ({
  page,
}) => {
  await page.route(`**/api/product/wallets/${wallet}**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, wallet: { ...body.wallet, rank: null }, launches: [] },
    });
  });
  await page.goto(`/wallet/${wallet}/?window=All`);
  await expect(page.locator(".wallet-page .page-heading")).toContainText(
    "UNRANKED",
  );
  await expect(page.locator(".wallet-page .page-heading")).not.toContainText(
    explanation,
  );
});

test("the trader board states its ranking rule under the window tabs", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(
    testInfo.project.name === "mobile"
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
  await observeShifts(page);
  await page.goto("/traders/");
  const rule = page.getByText(boardRule, { exact: true });
  await expect(rule).toBeVisible();
  const tabs = (await page
    .locator(".traders-controls .segmented")
    .last()
    .boundingBox())!;
  const caption = (await rule.boundingBox())!;
  expect(caption.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
  await capture(page, "board", testInfo.project.name);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { rankingExplanationShifts: { cls: number } })
          .rankingExplanationShifts.cls,
    ),
  ).toBe(0);
});
