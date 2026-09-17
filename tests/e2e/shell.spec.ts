import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { formatMoney, poolHref } from "@pools/core";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const routes = [
  "/",
  poolHref(chain.markets[0]),
  "/traders/",
  "/creators/",
  `/creators/${chain.markets[0].launchSender.toLowerCase()}/`,
  "/wallet/",
  `/wallet/${wallet}/`,
];

for (const route of routes) {
  test(`${route} keeps the shell to the network context, search and a quiet wallet placeholder`, async ({
    page,
    isMobile,
  }) => {
    await page.goto(route);
    const strip = page.locator(".network-subnav");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveText("v4 · Robinhood Chain");
    await expect(page.locator('a[href="/methodology/"]')).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link")).toHaveText([
      "Pools",
      "Traders",
      "Creators",
    ]);
    await expect(page.locator(".header-actions .search-trigger")).toBeVisible();
    const connect = page.locator(".header-actions .connect-button");
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute("aria-disabled", "true");
    await expect(connect).toHaveAccessibleName("Connect wallet, coming soon");
    const search = await page
      .locator(".header-actions .search-trigger")
      .boundingBox();
    const box = await connect.boundingBox();
    expect(box!.x, "the placeholder sits right of search").toBeGreaterThan(
      search!.x + search!.width,
    );
    if (isMobile) {
      // Under 768 px the control is an icon-only 44 px square: its name
      // carries the coming-soon note and no chip text is drawn.
      expect((await connect.innerText()).trim()).toBe("");
      expect(box!.width).toBe(44);
      expect(box!.height).toBe(44);
      const toggle = await page
        .locator(".header-actions .unit-toggle")
        .boundingBox();
      expect(
        box!.x,
        "the control clears the unit toggle",
      ).toBeGreaterThanOrEqual(toggle!.x + toggle!.width);
    } else {
      await expect(connect).toContainText("Connect wallet");
      await expect(connect).toContainText("Soon");
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
    await connect.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".footer")).toContainText(
      "Independent analytics. Not affiliated with Uniswap Labs.",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

const ethPriceFixture = {
  usdPerEth: 4218.44,
  asOf: "2026-09-17T00:00:00.000Z",
  source: "coinbase" as const,
};
const toggle = (page: import("@playwright/test").Page) =>
  page.locator(".header-actions .unit-toggle");

test.describe("ETH/USD unit toggle", () => {
  test("defaults to ETH, shows the strip's rate once the read resolves, switches figures and persists across reload", async ({
    page,
  }) => {
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: ethPriceFixture }),
    );
    await page.goto("/");
    const ethButton = toggle(page).getByRole("button", { name: "ETH" });
    const usdButton = toggle(page).getByRole("button", { name: "USD" });
    await expect(ethButton).toHaveAttribute("aria-pressed", "true");
    await expect(usdButton).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".subnav-eth-price")).toHaveText(
      "ETH $4,218.44",
    );
    await usdButton.click();
    await expect(usdButton).toHaveAttribute("aria-pressed", "true");
    await expect(ethButton).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(
      toggle(page).getByRole("button", { name: "USD" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("renders the exact USD value of a known wei figure on the screener", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "the desktop table carries the figure this asserts");
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: ethPriceFixture }),
    );
    await page.goto("/");
    const row = page
      .locator(".explore-page .desktop-pools [data-row='resolved']")
      .first();
    await expect(row).toBeAttached();
    const cell = row.locator("td").nth(4).locator(".number");
    const wei = (await cell.getAttribute("title"))!.replace(" wei", "");
    await toggle(page).getByRole("button", { name: "USD" }).click();
    await expect(cell).toHaveText(
      formatMoney(wei, "USD", ethPriceFixture.usdPerEth),
    );
  });

  test("leaves ETH figures unchanged and marks USD unavailable when the price read fails", async ({
    page,
    isMobile,
  }) => {
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({
        status: 503,
        headers: { "Retry-After": "30" },
        json: { error: "price_unavailable" },
      }),
    );
    await page.goto("/");
    const usdButton = toggle(page).getByRole("button", { name: "USD" });
    await expect(usdButton).toHaveAccessibleName(/unavailable/i);
    const row = isMobile
      ? page
          .locator(".explore-page .mobile-pools [data-row='resolved']")
          .first()
      : page
          .locator(".explore-page .desktop-pools [data-row='resolved']")
          .first();
    await expect(row).toBeAttached();
    const cell = row.locator(".number").first();
    const before = await cell.innerText();
    await usdButton.click();
    await expect(usdButton).toHaveAttribute("aria-pressed", "true");
    await expect(cell).toHaveText(before);
    await expect(page.locator(".subnav-eth-price")).toHaveText("");
    await expect(page.locator(".network-subnav")).not.toContainText("$");
  });
});

test("the retired methodology route lands on the screener", async ({
  page,
  request,
}) => {
  const response = await request.get("/methodology/", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/");
  await page.goto("/methodology/");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByRole("heading", { name: "Pools." })).toBeVisible();
});
