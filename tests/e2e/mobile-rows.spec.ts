import { test, expect, type Page } from "@playwright/test";

/* W6: the phone rows read like the export - the screener card at 104px,
   with no coverage copy in the reserved row or the meta description. */

const rowHeights = (rows: ReturnType<Page["locator"]>) =>
  rows.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
  );

test("the document description carries no coverage phrase", async ({
  page,
}) => {
  await page.goto("/");
  const description = await page
    .locator('meta[name="description"]')
    .getAttribute("content");
  expect(description, "a plain product description").not.toBeNull();
  expect(description, "no coverage/methodology copy").not.toMatch(/coverage/i);
});

test("the screener phone card matches the export's 104px row, with no coverage text", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "desktop", "phone card only");
  await page.goto("/");
  const rows = page.locator(
    ".explore-page .mobile-pools .mobile-pool[data-row='resolved']",
  );
  await expect(rows.first()).toBeVisible();
  const heights = await rowHeights(rows);
  expect(heights.length, "the first page has cards").toBeGreaterThan(0);
  for (const height of heights) {
    expect(height, "104 ± 4px").toBeGreaterThanOrEqual(100);
    expect(height, "104 ± 4px").toBeLessThanOrEqual(108);
  }
  await expect(page.locator("main")).not.toContainText("Coverage pending");
  // The star stays a 44px tap target even on the shorter card.
  const star = rows.first().locator(".watch");
  expect(
    (await star.boundingBox())!.height,
    "44px tap target",
  ).toBeGreaterThanOrEqual(44);
});
