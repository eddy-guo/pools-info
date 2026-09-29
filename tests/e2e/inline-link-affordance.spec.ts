import { test, expect } from "@playwright/test";
import axe from "axe-core";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

const routes = [
  { name: "not-found", path: "/nope/", link: ".footer-credit" },
  {
    name: "pool",
    path: poolHref(chain.markets[0]),
    link: ".pool-launch-meta",
  },
] as const;

for (const route of routes) {
  test(`${route.name} distinguishes inline links without color alone`, async ({
    page,
    isMobile,
  }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      (
        window as typeof window & { layoutShiftScore: number }
      ).layoutShiftScore = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };
          if (!shift.hadRecentInput) {
            (
              window as typeof window & { layoutShiftScore: number }
            ).layoutShiftScore += shift.value;
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(route.path);
    const line = page.locator(route.link);
    await expect(line.getByRole("link")).toBeVisible();
    if (route.name === "pool") {
      await expect(page.locator(".nullable-pool-page")).toHaveAttribute(
        "aria-busy",
        "false",
      );
    }

    const phase = process.env.A11Y_EVIDENCE_PHASE;
    if (phase === "before" || phase === "after") {
      await line.screenshot({
        path: `docs/evidence/a11y-2026-09-29/f2-inline-link-affordance/${phase}-${route.name}-${isMobile ? 390 : 1440}.png`,
      });
    }

    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const injectedAxe = (window as typeof window & { axe: typeof axe }).axe;
      const result = await injectedAxe.run(document, {
        runOnly: { type: "rule", values: ["link-in-text-block"] },
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
    });
    expect(violations).toEqual([]);
    const cls = await page.evaluate(
      () =>
        (window as typeof window & { layoutShiftScore: number })
          .layoutShiftScore,
    );
    expect(cls).toBeLessThan(0.001);
  });
}
