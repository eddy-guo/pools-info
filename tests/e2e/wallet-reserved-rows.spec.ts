import { test, expect, type Page } from "@playwright/test";

/* The wallet's positions table holds 25 rows open for the page height. Once
   the profile resolves, a row with no position behind it is blank, as the
   screener's reserved rows are: it never reads as three unavailable values,
   and it keeps the height of a real row so the page does not shift. A phone
   shows the same rows as cards, held open the same way. */

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

test("a settled wallet blanks the rows it held open under its positions", async ({
  page,
}, testInfo) => {
  await settled(page, `/wallet/${wallet}/?window=All`);
  const resolved = await rows(page, "resolved").count();
  const reserved = await rows(page, "reserved").count();
  expect(resolved, "the wallet has positions").toBeGreaterThan(0);
  expect(reserved, "rows are held open under them").toBeGreaterThan(0);
  const heights = await page.evaluate((shown) => {
    const heights = (state: string) => [
      ...new Set(
        [
          ...document.querySelectorAll<HTMLElement>(
            `.page ${shown}[data-row="${state}"]`,
          ),
        ]
          .filter((row) => row.offsetParent !== null)
          .map((row) => row.getBoundingClientRect().height),
      ),
    ];
    return { resolved: heights("resolved"), reserved: heights("reserved") };
  }, shown);
  await testInfo.attach("row-heights", {
    body: JSON.stringify({ resolved, reserved, heights }),
    contentType: "application/json",
  });
  await expect(rows(page, "reserved").filter({ hasText: "N/A" })).toHaveCount(
    0,
  );
  await expect(rows(page, "reserved").locator(".unavailable")).toHaveCount(0);
  expect(
    heights.reserved,
    "every reserved row keeps the height of a real row",
  ).toEqual(heights.resolved);
});

test("the wallet's launches tab shows no unavailable marks in a reserved row", async ({
  page,
}) => {
  await settled(page, `/wallet/${wallet}/?window=All&tab=launches`);
  await expect(rows(page, "reserved").filter({ hasText: "N/A" })).toHaveCount(
    0,
  );
});

// The Trades tab was cut with the ledger's wallet route, which serves no
// per-wallet trade list: a bookmark to it opens the Positions tab, as any
// unknown tab always did, with no error.
test("a bookmarked trades tab falls to the positions tab", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await settled(page, `/wallet/${wallet}/?window=All&tab=trades`);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(
    /^Positions/,
  );
  await expect(page.getByRole("tab", { name: /^Trades/ })).toHaveCount(0);
  expect(await rows(page, "resolved").count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
