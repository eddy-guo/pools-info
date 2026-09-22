import { test, expect } from "@playwright/test";

/* Copy the captain removed from the screener; it lives in the API only. */
const removedCopy = [
  "Explore every discovered Pools launch",
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
  "Live trades",
  "Feed not running",
  "Pause feed",
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
      const workspace = document.querySelector(
        ".explore-page .workspace-grid",
      )!;
      const mainPanel = workspace.querySelector(":scope > div > .panel")!;
      const sidebar = workspace.querySelector(".explore-sidebar")!;
      const leaders = sidebar.querySelector(".explore-leaders")!;
      return {
        tableHead: top(".explore-page .desktop-pools thead"),
        firstCard: top(".explore-page .mobile-pools .mobile-pool"),
        rowsVisible: [
          ...document.querySelectorAll(".explore-page .desktop-pools tbody tr"),
        ].filter((row) => row.getBoundingClientRect().bottom <= innerHeight)
          .length,
        mainPanelTop: mainPanel.getBoundingClientRect().top,
        leadersTop: leaders.getBoundingClientRect().top,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        leadersWidth: leaders.getBoundingClientRect().width,
        sidebarChildren: sidebar.childElementCount,
        leadersAreFirst: sidebar.firstElementChild === leaders,
      };
    });
    await testInfo.attach("first-paint", {
      body: JSON.stringify(firstPaint),
      contentType: "application/json",
    });
    if (testInfo.project.name === "desktop") {
      expect(firstPaint.tableHead, "table head top").toBeLessThanOrEqual(420);
      expect(firstPaint.rowsVisible, "rows visible").toBeGreaterThanOrEqual(8);
      expect(
        Math.abs(firstPaint.leadersTop - firstPaint.mainPanelTop),
        "Top traders starts alongside the screener with no retired-panel hole",
      ).toBeLessThanOrEqual(1);
    } else {
      expect(firstPaint.firstCard, "first card top").toBeLessThanOrEqual(600);
    }
    expect(firstPaint.sidebarChildren, "only Top traders remains").toBe(1);
    expect(
      firstPaint.leadersAreFirst,
      "Top traders is the first rail panel",
    ).toBe(true);
    expect(
      Math.abs(firstPaint.leadersWidth - firstPaint.sidebarWidth),
      "Top traders fills the remaining rail",
    ).toBeLessThanOrEqual(1);
    await expect(page.locator(".explore-page .launch-rail")).toBeVisible();
    await expect(page.locator(".explore-page .stats-grid")).toHaveCount(0);
    const resolved = page.locator(".explore-page [data-row='resolved']");
    await expect(resolved.first()).toBeAttached();
    if (testInfo.project.name !== "desktop" && name === "measured") {
      /* The card's reserved height fits the identity/price row and the one
         Vol and trade count line with no coverage text; a launch card's
         single line shares that height. */
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
    await expect(page.locator(".trade-stream, .subnav-live")).toHaveCount(0);
    for (const text of removedCopy)
      await expect(page.locator("main"), text).not.toContainText(text);
  });
