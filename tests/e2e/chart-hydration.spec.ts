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
  const updated = structuredClone(chain);
  updated.markets[0].name = "Refreshed chart market";
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
    const interval = page.getByLabel("Candle interval", { exact: true });
    const display = page.getByLabel("Chart display", { exact: true });
    const range = page.getByRole("button", { name: "6h", exact: true });
    const fit = page.getByRole("button", { name: "Fit loaded history" });
    await expect(interval).toBeVisible();
    await expect(page.locator(".interactive-chart canvas")).toHaveCount(0);
    await expect(interval).toBeDisabled();
    await expect(display).toBeDisabled();
    await expect(range).toBeDisabled();
    await expect(fit).toBeDisabled();

    releaseScripts();
    await interval.selectOption("1s");
    await expect(
      page.locator(".interactive-chart canvas").first(),
    ).toBeVisible();
    await display.selectOption("FDV");
    await range.click();
    await expect(
      page.getByRole("img", { name: /FDV candle chart/ }),
    ).toBeVisible();
    await expect(interval).toHaveValue("1s");
    await expect(range).toHaveAttribute("aria-pressed", "true");
    await expect(fit).toBeEnabled();

    const refreshed = page.waitForResponse((response) =>
      response.url().includes(`/api/markets/${market.id}/?`),
    );
    releaseMarket();
    await refreshed;
    await expect(
      page.getByRole("heading", { name: updated.markets[0].name, exact: true }),
    ).toBeVisible();
    await expect(interval).toHaveValue("1s");
    await expect(display).toHaveValue("FDV");
    await expect(range).toHaveAttribute("aria-pressed", "true");
  } finally {
    releaseScripts();
    releaseMarket();
  }
});
