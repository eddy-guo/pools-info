import { test, expect, type Page } from "@playwright/test";

/* The wallet's positions table holds 25 rows open for the page height. Once
   the profile resolves, a row with no position behind it is blank, as the
   screener's reserved rows are: it never reads as three unavailable values,
   and it keeps the height of a real row so the page does not shift. */

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

async function settled(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}

const rows = (page: Page, state: "resolved" | "reserved") =>
  page.locator(`.page tbody tr[data-row="${state}"]`);

test("a settled wallet blanks the rows it held open under its positions", async ({
  page,
}, testInfo) => {
  await settled(page, `/wallet/${wallet}/?window=All`);
  const resolved = await rows(page, "resolved").count();
  const reserved = await rows(page, "reserved").count();
  expect(resolved, "the wallet has positions").toBeGreaterThan(0);
  expect(reserved, "rows are held open under them").toBeGreaterThan(0);
  const heights = await page.evaluate(() => {
    const height = (row: Element) => row.getBoundingClientRect().height;
    return {
      resolved: [
        ...new Set(
          [
            ...document.querySelectorAll('.page tbody tr[data-row="resolved"]'),
          ].map(height),
        ),
      ],
      reserved: [
        ...new Set(
          [
            ...document.querySelectorAll('.page tbody tr[data-row="reserved"]'),
          ].map(height),
        ),
      ],
    };
  });
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

for (const tab of ["trades", "launches"]) {
  test(`the wallet's ${tab} tab shows no unavailable marks in a reserved row`, async ({
    page,
  }) => {
    await settled(page, `/wallet/${wallet}/?window=All&tab=${tab}`);
    await expect(rows(page, "reserved").filter({ hasText: "N/A" })).toHaveCount(
      0,
    );
  });
}
