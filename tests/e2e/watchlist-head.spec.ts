import { expect, test } from "@playwright/test";
import captures from "../../data/pools/index.json";

const savedId = Object.keys(captures.snapshots)[0];

for (const populated of [false, true]) {
  test(`watchlist head keeps its first-paint position with ${populated ? "saved" : "no"} pools`, async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === "mobile")
      await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (id) => {
        if (id)
          localStorage.setItem("poolsinfo.watchlist.v1", JSON.stringify([id]));
        else localStorage.removeItem("poolsinfo.watchlist.v1");
        const state = { cls: 0 };
        Object.assign(window, { watchlistLayout: state });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            };
            if (!shift.hadRecentInput) state.cls += shift.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      },
      populated ? savedId : null,
    );
    let releaseScripts!: () => void;
    const scripts = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    await page.route("**/_next/static/**/*.js", async (route) => {
      await scripts;
      await route.continue();
    });

    await page.goto("/?view=watchlist", { waitUntil: "domcontentloaded" });
    const head = page.getByRole("region", { name: "Saved watchlist" });
    const table = page.locator(".explore-page .table-region");
    await expect(head.locator("strong")).toHaveText("Your watchlist");
    const beforeHead = await head.boundingBox();
    const beforeTable = await table.boundingBox();
    expect(beforeHead).not.toBeNull();
    expect(beforeTable).not.toBeNull();

    releaseScripts();
    await expect(head.locator("strong")).toHaveText(
      `Your watchlist · ${populated ? "1 pool" : "0 pools"}`,
    );
    await page.waitForLoadState("networkidle");
    expect(await head.boundingBox()).toMatchObject({
      y: beforeHead!.y,
      height: beforeHead!.height,
    });
    expect(await table.boundingBox()).toMatchObject({ y: beforeTable!.y });
    const cls = await page.evaluate(
      () =>
        (window as unknown as { watchlistLayout: { cls: number } })
          .watchlistLayout.cls,
    );
    expect(cls, "watchlist load CLS").toBe(0);
  });
}
