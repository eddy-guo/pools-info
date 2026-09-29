import { expect, test } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";

test("production audit scope has no committed fixture pools", async ({
  page,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_PRODUCT_FIXTURES !== "0",
    "The production-mode build and server are required",
  );
  const market = chain.markets[0];
  await page.route("**/api/markets/**", (route) =>
    route.fulfill({ status: 503, json: { error: "data_unavailable" } }),
  );
  await page.goto(`/traders/?pool=${market.id}&launch=${market.launchTx}`);
  await expect(
    page.getByText(
      "This pool could not be loaded within the current scan limits.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Audit pool" })).toHaveCount(
    0,
  );
  const options = await page.locator("main option").allTextContents();
  for (const fixture of chain.markets)
    expect(
      options.some((option) => option.startsWith(`${fixture.symbol} ·`)),
    ).toBe(false);
});
