import { test, expect } from "@playwright/test";

/* Copy the captain removed from the screener; it lives in the API only. */
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
  "Observed windows",
  "Historical market rebuild",
  "Broad swaps",
  "Deep market",
  "Covered window",
  "Partial metrics",
  "Market unavailable",
  "Launch only",
  "All discovered launches",
  "Updates delayed",
  "Checking every",
  "Loading recent trades",
  "Waiting for the first live capture",
  "temporarily unavailable",
  "No swaps in the saved",
  "Tx initiator",
];

for (const [name, url] of [
  ["measured", "/"],
  ["launches", "/?view=new"],
] as const)
  test(`the ${name} screener reaches its first rows within the first viewport`, async ({
    page,
  }, testInfo) => {
    await page.goto(url, { waitUntil: "commit" });
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
      const rail = document.querySelector(".trade-stream")!;
      return {
        tableHead: top(".explore-page .desktop-pools thead"),
        firstCard: top(".explore-page .mobile-pools .mobile-pool"),
        rowsVisible: [
          ...document.querySelectorAll(".explore-page .desktop-pools tbody tr"),
        ].filter((row) => row.getBoundingClientRect().bottom <= innerHeight)
          .length,
        /* The rail's head is followed by its rows, not by a status box. */
        railHeadBottom: rail
          .querySelector(".panel-heading")!
          .getBoundingClientRect().bottom,
        railRowsTop: rail
          .querySelector(".panel-heading + .activity-list")
          ?.getBoundingClientRect().top,
      };
    });
    await testInfo.attach("first-paint", {
      body: JSON.stringify(firstPaint),
      contentType: "application/json",
    });
    if (testInfo.project.name === "desktop") {
      expect(firstPaint.tableHead, "table head top").toBeLessThanOrEqual(420);
      expect(firstPaint.rowsVisible, "rows visible").toBeGreaterThanOrEqual(8);
    } else {
      expect(firstPaint.firstCard, "first card top").toBeLessThanOrEqual(600);
    }
    expect(firstPaint.railRowsTop, "trade rows start under the head").toBe(
      firstPaint.railHeadBottom,
    );
    await expect(page.locator(".explore-page .launch-rail")).toBeVisible();
    await expect(page.locator(".explore-page .stats-grid")).toHaveCount(0);
    const resolved = page.locator(".explore-page [data-row='resolved']");
    await expect(resolved.first()).toBeAttached();
    if (testInfo.project.name !== "desktop" && name === "measured") {
      /* The card's reserved height fits a measured card's two stat rows with
         no coverage line; a launch card's single row shares that height. */
      const fit = await resolved
        .filter({ visible: true })
        .first()
        .evaluate((node) => {
          const card = node.getBoundingClientRect();
          return (
            card.height -
            (node.lastElementChild!.getBoundingClientRect().bottom -
              card.top +
              parseFloat(getComputedStyle(node).paddingBottom))
          );
        });
      expect(Math.abs(fit), "no hole under the card's stats").toBeLessThan(1);
    }
    await expect(page.locator(".trade-stream").getByRole("status")).toHaveText(
      /^(streaming|paused|delayed)$/,
    );
    for (const text of removedCopy)
      await expect(page.locator("main"), text).not.toContainText(text);
  });
