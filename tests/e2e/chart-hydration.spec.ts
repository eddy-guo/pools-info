import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref, type ChainMarket } from "@pools/core";

const market = chain.markets[0] as ChainMarket;

test("chart accepts its first selection only once hydration can retain it", async ({
  page,
}) => {
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  let releaseMarket!: () => void;
  const marketReady = new Promise<void>((resolve) => {
    releaseMarket = resolve;
  });
  /* The pool's identity comes from its own read; this route serves the
     accounted cut the chart is drawn from, so the refresh is observed
     through the price that cut carries. */
  const updated = structuredClone(chain);
  updated.markets[0].priceWei = "2000000000000000000";
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scriptsReady;
    await route.continue();
  });
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route(`**/api/markets/${market.id}/?*`, async (route) => {
    await marketReady;
    await route.fulfill({ json: updated });
  });
  try {
    await page.goto(poolHref(market), { waitUntil: "commit" });
    const control = page.locator(".pool-chart-head .segmented");
    const range = control.getByRole("button", { name: "6h", exact: true });
    const all = control.getByRole("button", { name: "All", exact: true });
    await expect(control).toBeVisible();
    await expect(page.locator(".interactive-chart canvas")).toHaveCount(0);
    await expect(range).toBeDisabled();
    await expect(all).toBeDisabled();

    releaseScripts();
    await range.click();
    await expect(
      page.locator(".interactive-chart canvas").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: /Price candle chart/ }),
    ).toBeVisible();
    await expect(range).toHaveAttribute("aria-pressed", "true");
    await expect(all).toHaveAttribute("aria-pressed", "false");

    const refreshed = page.waitForResponse((response) =>
      response.url().includes(`/api/markets/${market.id}/?`),
    );
    releaseMarket();
    await refreshed;
    await expect(page.locator(".live-price-heading .price")).toHaveText(
      "2 ETH",
    );
    await expect(
      page.getByRole("heading", { name: market.name, exact: true }),
      "the pool keeps the identity its own read named",
    ).toBeVisible();
    await expect(range).toHaveAttribute("aria-pressed", "true");
  } finally {
    releaseScripts();
    releaseMarket();
  }
});
