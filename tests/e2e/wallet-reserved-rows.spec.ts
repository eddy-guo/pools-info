import { test, expect, type Page } from "@playwright/test";

/* The wallet's positions table holds 25 rows open while the profile is
   pending, each at the height of a real row. Once it resolves, a wallet with
   fewer positions keeps only the rows they fill: no blank row is left under
   them. A phone shows the same rows as cards, held open the same way. */

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

async function settled(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}

const shown = ":is(tbody tr, .mobile-position)";
const rows = (page: Page, state: "resolved" | "reserved") =>
  page.locator(`.page ${shown}[data-row="${state}"]`).filter({ visible: true });
const heights = (page: Page, state: "resolved" | "reserved") =>
  page.evaluate(
    ({ shown, state }) => [
      ...new Set(
        [
          ...document.querySelectorAll<HTMLElement>(
            `.page ${shown}[data-row="${state}"]`,
          ),
        ]
          .filter((row) => row.offsetParent !== null)
          .map((row) => row.getBoundingClientRect().height),
      ),
    ],
    { shown, state },
  );

test("a pending wallet holds rows open at a real row's height, and a settled one keeps only its positions", async ({
  page,
}, testInfo) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/product/wallets/${wallet}/**`, async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(`/wallet/${wallet}/?window=All`);
  await expect(rows(page, "reserved")).toHaveCount(25);
  const pending = await heights(page, "reserved");
  release();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(rows(page, "resolved").first()).toBeVisible();
  const resolved = await rows(page, "resolved").count();
  const resolvedHeights = await heights(page, "resolved");
  await testInfo.attach("row-heights", {
    body: JSON.stringify({ resolved, pending, resolvedHeights }),
    contentType: "application/json",
  });
  expect(resolved, "the wallet has positions").toBeGreaterThan(0);
  expect(
    resolved,
    "fewer than a page, so the release is exercised",
  ).toBeLessThan(25);
  await expect(
    rows(page, "reserved"),
    "no blank row is left under the positions",
  ).toHaveCount(0);
  expect(pending, "every reserved row keeps the height of a real row").toEqual(
    resolvedHeights,
  );
});

test("the wallet's launches tab shows no unavailable marks in a reserved row", async ({
  page,
}) => {
  await settled(page, `/wallet/${wallet}/?window=All&tab=launches`);
  await expect(rows(page, "reserved").filter({ hasText: "N/A" })).toHaveCount(
    0,
  );
});

// The Trades tab reads the explorer's own history endpoint, on demand only
// (see readWalletTradeHistory): with no read API configured, exactly the e2e
// suite's own setup, it answers unavailable rather than falling back to
// another tab or a stored substitute. tests/e2e/wallet-trades.spec.ts covers
// its loaded, empty and retry states behind route interception.
test("a bookmarked trades tab opens the trades tab", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/wallet/${wallet}/?window=All&tab=trades`);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/^Trades/);
  await expect(
    page.getByText("Trade history unavailable", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
