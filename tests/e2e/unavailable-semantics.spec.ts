import { expect, test } from "@playwright/test";
import axe from "axe-core";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

const routes = [
  { name: "home", path: "/", settled: ".pool-table [data-row='resolved']" },
  { name: "traders", path: "/traders/", settled: ".desktop-traders [data-row='resolved']" },
  {
    name: "pool",
    path: poolHref(chain.markets[0]),
    settled: ".nullable-pool-page[aria-busy='false']",
  },
  { name: "creators", path: "/creators/", settled: ".creators-page [data-row='resolved']" },
] as const;

for (const route of routes) {
  test(`${route.name} gives unavailable values and headers valid semantics`, async ({
    page,
    isMobile,
  }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route.path);
    await expect(page.locator(route.settled).first()).toBeAttached();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const result = await (
        window as typeof window & { axe: typeof axe }
      ).axe.run(document, {
        runOnly: {
          type: "rule",
          values: [
            "aria-prohibited-attr",
            "aria-allowed-attr",
            "empty-table-header",
          ],
        },
      });
      return result.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
      }));
    });
    expect(violations).toEqual([]);
    const unreadableUnavailable = await page
      .locator(".unavailable[data-pending='false']")
      .evaluateAll((slots) =>
        slots
          .filter(
            (slot) =>
              slot.querySelector(".sr-only")?.textContent !== "Unavailable",
          )
          .map((slot) => slot.outerHTML),
      );
    expect(unreadableUnavailable).toEqual([]);
    if (route.name === "home") {
      await expect(
        page.getByRole("columnheader", { name: "Watchlist", includeHidden: true }),
      ).toHaveCount(1);
      await expect(page.locator(".row-subtitle[aria-label]")).toHaveCount(0);
    }
    if (route.name === "traders") {
      await expect(page.getByRole("columnheader", { name: "Follow", includeHidden: true })).toHaveCount(1);
    }
  });
}
