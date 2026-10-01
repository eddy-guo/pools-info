import { test, expect } from "@playwright/test";
import path from "node:path";

const axe = path.resolve(
  "node_modules/.pnpm/axe-core@4.13.0/node_modules/axe-core/axe.min.js",
);
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

for (const entry of [
  { name: "home", desktop: "/", mobile: "/?view=new" },
  { name: "traders", desktop: "/traders/", mobile: "/traders/" },
  {
    name: "wallet",
    desktop: `/wallet/${wallet}/`,
    mobile: `/wallet/${wallet}/`,
  },
]) {
  test(`${entry.name} has no undersized targets`, async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name === "mobile";
    await page.setViewportSize({
      width: mobile ? 390 : 1440,
      height: mobile ? 844 : 1000,
    });
    await page.goto(mobile ? entry.mobile : entry.desktop);
    if (entry.name === "home")
      await expect(
        page
          .locator(
            mobile
              ? ".mobile-pools [data-row='resolved'] .address-chip"
              : ".desktop-pools [data-row='resolved'] .address-chip",
          )
          .first(),
      ).toBeVisible();
    if (entry.name === "traders")
      await expect(
        page.locator(".leaderboard-panel .address-chip").first(),
      ).toBeVisible();
    if (entry.name === "wallet")
      await expect(page.locator(".wallet-meta .address-label")).toBeVisible();
    await page.addScriptTag({ path: axe });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as typeof window & {
          axe: {
            run: (
              root: Element,
              options: unknown,
            ) => Promise<{
              violations: { id: string; nodes: { target: string[] }[] }[];
            }>;
          };
        }
      ).axe;
      const result = await axe.run(document.documentElement, {
        runOnly: { type: "rule", values: ["target-size"] },
      });
      return result.violations.flatMap((violation) =>
        violation.nodes.map((node) => ({
          rule: violation.id,
          target: node.target,
        })),
      );
    });
    expect(violations, "axe target-size violations").toEqual([]);
  });
}

test("compact icon targets keep rows and first-paint geometry at 320, 390 and 1440", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { iconTargetLayout: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const entry of [
      {
        url: width === 1440 ? "/" : "/?view=new",
        row:
          width === 1440
            ? ".desktop-pools [data-row='resolved']:has(.address-chip)"
            : ".mobile-pools [data-row='resolved']:has(.address-chip)",
        height: width === 1440 ? 62 : 104,
      },
      {
        url: "/traders/",
        row:
          width === 1440
            ? ".desktop-traders [data-row='resolved']:has(.address-chip)"
            : ".mobile-traders .mobile-trader:has(.address-chip)",
        height: width === 1440 ? 60 : 101,
      },
    ]) {
      await page.goto(entry.url);
      const row = page.locator(entry.row).first();
      await expect(row).toBeVisible();
      expect((await row.boundingBox())?.height, `${width}px row height`).toBe(
        entry.height,
      );
      const measurement = await page.evaluate(() => ({
        cls: (window as typeof window & { iconTargetLayout: { cls: number } })
          .iconTargetLayout.cls,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      expect(measurement.cls, `${width}px CLS`).toBeLessThan(0.001);
      expect(
        measurement.scrollWidth,
        `${width}px page fits`,
      ).toBeLessThanOrEqual(measurement.viewportWidth);
    }
  }
});
