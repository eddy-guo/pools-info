import { test, expect } from "@playwright/test";

/* Copy the captain removed from the screener top; it lives in the API only. */
const removedCopy = [
  "Explore every discovered Pools launch",
  "Trader leaderboard",
  "with saved analytics",
  "Latest captured data",
  "Coverage and methodology",
  "Pools discovered",
  "Matching pools",
  "% covered",
  "discovered pools",
  "Pool coverage pending",
];

test("the screener reaches its first rows within the first viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.locator(".explore-page .workspace-grid")).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const firstPaint = await page.evaluate(() => {
    const top = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().top ?? null;
    return {
      tableHead: top(".explore-page .desktop-pools thead"),
      firstCard: top(".explore-page .mobile-pools .mobile-pool"),
      rowsVisible: [
        ...document.querySelectorAll(".explore-page .desktop-pools tbody tr"),
      ].filter((row) => row.getBoundingClientRect().bottom <= innerHeight)
        .length,
    };
  });
  await testInfo.attach("first-paint", {
    body: JSON.stringify(firstPaint),
    contentType: "application/json",
  });
  if (testInfo.project.name === "desktop") {
    expect(firstPaint.tableHead, "table head top").toBeLessThanOrEqual(500);
    expect(firstPaint.rowsVisible, "rows visible").toBeGreaterThanOrEqual(6);
  } else {
    expect(firstPaint.firstCard, "first card top").toBeLessThanOrEqual(720);
  }
  await expect(page.locator(".explore-page .launch-rail")).toBeVisible();
  await expect(page.locator(".explore-page .stats-grid")).toHaveCount(0);
  await expect(
    page.locator(".explore-page [data-row='resolved']").first(),
  ).toBeAttached();
  for (const text of removedCopy)
    await expect(page.locator("main"), text).not.toContainText(text);
});
