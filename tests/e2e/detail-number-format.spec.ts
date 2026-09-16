import { test, expect, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

for (const entry of [
  { roi: 274.3, text: "+274.3%", tone: "positive", token: "--color-up" },
  { roi: -12.34, text: "-12.3%", tone: "negative", token: "--color-down" },
]) {
  test(`wallet Realized ROI reads ${entry.text} in the ${entry.tone} tone`, async ({
    page,
    request,
  }) => {
    const payload = await (
      await request.get(`/api/product/wallets/${wallet}?window=All`)
    ).json();
    await page.route(`**/api/product/wallets/${wallet}?**`, (route) =>
      route.fulfill({
        json: { ...payload, wallet: { ...payload.wallet, roi: entry.roi } },
      }),
    );
    await page.goto(`/wallet/${wallet}/?window=All`);
    const stat = page
      .locator(".stat")
      .filter({ hasText: "Realized ROI" })
      .locator("strong");
    await expect(stat).toHaveText(entry.text);
    await expect(stat.locator(`.${entry.tone}`)).toHaveCSS(
      "color",
      await tokenColor(page, entry.token),
    );
    expect(
      await tokenColor(page, "--color-accent"),
      "up/down colours stay separate from the accent",
    ).not.toBe(await tokenColor(page, entry.token));
  });
}

test("pool price subscript uses the muted token like the screener", async ({
  page,
}) => {
  await page.goto(poolHref(chain.markets[0]));
  const sub = page.locator(".live-price-heading > .price sub");
  await expect(sub).toBeVisible();
  await expect(sub).toHaveCSS("color", await tokenColor(page, "--color-muted"));
});
