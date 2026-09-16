import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

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
      const pill = await page
        .locator(".header-actions .currency-pill")
        .boundingBox();
      expect(box!.x, "the control clears the ETH pill").toBeGreaterThanOrEqual(
        pill!.x + pill!.width,
      );
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
