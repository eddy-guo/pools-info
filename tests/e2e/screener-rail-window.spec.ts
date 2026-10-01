import { expect, test } from "@playwright/test";
import { settledRoute, settleRoutes } from "../support/settled-route";

// The last leaderboard read can still be in flight when the test ends.
test.afterEach(({ page }) => settleRoutes(page));

test("Top traders follows every screener window without moving its rail", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "mobile")
    await page.setViewportSize({ width: 390, height: 844 });

  await page.addInitScript(() => {
    const shifts = { score: 0 };
    Object.assign(window, { railWindowShifts: shifts });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        shifts.score += (entry as PerformanceEntry & { value: number }).value;
    }).observe({ type: "layout-shift", buffered: true });
  });

  const requests: string[] = [];
  await settledRoute(page, "**/api/product/leaderboard/**", async (route) => {
    const window = new URL(route.request().url()).searchParams.get("window");
    requests.push(window ?? "missing");
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await page.goto("/?window=24h");
  const rail = page.locator(".explore-leaders");
  const rows = rail.locator(".explore-leader-rows > a");
  const tabs = page.locator('.explore-toolbar [aria-label="Time window"]');
  await expect(rows).toHaveCount(5);
  /* The rail remounts when the list above it releases rows
     (lib/list-release.ts), and a locator resolves its node and measures it in
     separate round trips, so a remount between them reads a detached node's
     0; one evaluate finds and measures whichever rail is mounted. */
  const railHeight = () =>
    page.evaluate(
      () =>
        document.querySelector(".explore-leaders")!.getBoundingClientRect()
          .height,
    );
  const originalHeight = await railHeight();
  await page.evaluate(() => {
    (window as typeof window & { railWindowShifts: { score: number } })
      .railWindowShifts.score = 0;
  });

  for (const window of ["7d", "30d", "All", "1h", "24h"] as const) {
    const railWindow = window === "1h" ? "24h" : window;
    await tabs.getByRole("button", { name: window, exact: true }).click();
    await expect(rail.getByRole("heading")).toHaveText(
      `Top traders · ${railWindow}`,
    );
    await expect.poll(() => requests.at(-1)).toBe(railWindow);
    await expect(
      rail.getByRole("link", { name: "Full leaderboard ↗" }),
    ).toHaveAttribute("href", `/traders/?window=${railWindow}`);
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toHaveAttribute(
      "href",
      new RegExp(`\\?window=${railWindow}$`),
    );
    expect(await railHeight()).toBe(originalHeight);
  }
  const cls = await page.evaluate(
    () =>
      (window as typeof window & { railWindowShifts: { score: number } })
        .railWindowShifts.score,
  );
  expect(
    cls,
    `rail window changes at ${page.viewportSize()?.width}px`,
  ).toBeLessThan(0.001);

  // 6h is accepted by the URL but has no screener tab or matching board.
  await page.goto("/?window=6h");
  await expect(rail.getByRole("heading")).toHaveText("Top traders · 24h");
  await expect.poll(() => requests.at(-1)).toBe("24h");
  await expect(
    rail.getByRole("link", { name: "Full leaderboard ↗" }),
  ).toHaveAttribute("href", "/traders/?window=24h");
});
