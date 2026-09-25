import { test, expect, type Page } from "@playwright/test";

/* All launches, in the Just launched caption, is the screener's New tab
   reached from the rail above the list. The rail sits at the top of the
   page and the list under it, so the click brings the list's own head up
   under the site header with New pressed: the change lands where the reader
   is looking, the All tab beside it undoes it, and nothing moves on its own
   while the launches read lands. */

async function trackShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0, sources: [] as unknown[] };
    Object.assign(window, { shiftMeasurement: state });
    new PerformanceObserver((entries) => {
      for (const raw of entries.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources?: {
            node: Element | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        state.cls += shift.value;
        state.sources.push({
          value: shift.value,
          at: Math.round(shift.startTime),
          nodes: (shift.sources ?? []).map((source) => ({
            node: source.node
              ? `${source.node.tagName}.${source.node.className}`
              : null,
            from: source.previousRect.toJSON(),
            to: source.currentRect.toJSON(),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}
const shifts = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          shiftMeasurement: { cls: number; sources: unknown[] };
        }
      ).shiftMeasurement,
  );
const resetShifts = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        shiftMeasurement: { cls: number; sources: unknown[] };
      }
    ).shiftMeasurement;
    state.cls = 0;
    state.sources = [];
  });
/** The list's head against the sticky site header, and where the page sits. */
const placement = (page: Page) =>
  page.evaluate(() => ({
    panel: document
      .querySelector(".explore-page .panel")!
      .getBoundingClientRect().top,
    header: document.querySelector(".site-header")!.getBoundingClientRect()
      .bottom,
    scrollY: Math.round(window.scrollY),
  }));
/** The gap `headIntoView` in product-explore.tsx leaves under the header. */
const HEAD_GAP = 12;
const tabs = (page: Page) => page.locator(".explore-page .table-tabs");
const tab = (page: Page, name: string) =>
  page.locator(".table-tabs").getByRole("button", { name, exact: true });
const resolvedRows = (page: Page) =>
  page.locator(
    ".explore-page :is(.desktop-pools tbody tr, .mobile-pools .mobile-pool)[data-row='resolved']",
  );

test("All launches brings the list into view with New pressed, undone by All, at CLS 0", async ({
  page,
}) => {
  await trackShifts(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/product/explore/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    /* The launches read waits past the click's input window, so the rows it
       lands are measured for shift like any other response. */
    if (params.get("view") === "new" && params.get("limit") !== "6") await held;
    await route.continue().catch(() => {
      /* A superseded request is aborted by the page; nothing to answer. */
    });
  });
  await page.goto("/");
  await expect(resolvedRows(page).first()).toBeAttached();
  await expect(
    page.locator(".launch-card[href^='/pool']").first(),
  ).toBeVisible();
  await expect(tab(page, "All")).toHaveAttribute("aria-pressed", "true");
  const before = await placement(page);
  expect(before.scrollY, "the reader starts at the top of the page").toBe(0);
  expect(before.panel, "the list's head starts below the rail").toBeGreaterThan(
    before.header + 100,
  );
  await resetShifts(page);

  const link = page
    .getByRole("region", { name: "Just launched" })
    .getByRole("link", { name: "All launches" });
  await expect(link).toHaveAttribute("href", "/?view=new");
  await link.click();

  await expect(page).toHaveURL(/[?&]view=new(?:&|$)/);
  await expect(tab(page, "New")).toHaveAttribute("aria-pressed", "true");
  await expect(tab(page, "New")).toHaveClass(/\bactive\b/);
  await expect(tab(page, "All")).toHaveAttribute("aria-pressed", "false");
  await expect(
    tab(page, "New"),
    "focus follows to the tab it pressed",
  ).toBeFocused();
  await expect
    .poll(
      async () => {
        const { panel, header } = await placement(page);
        return panel - header;
      },
      { message: "the list's head settles just under the site header" },
    )
    .toBeCloseTo(HEAD_GAP, 0);
  await expect(tabs(page)).toBeInViewport();
  await page.waitForTimeout(600);
  release();
  await expect(resolvedRows(page).first()).toBeAttached();
  await expect(
    page.locator(".explore-page [data-stale-rows='true']"),
  ).toHaveCount(0);
  await page.waitForTimeout(300);
  const measured = await shifts(page);
  expect(measured.cls, JSON.stringify(measured.sources)).toBeLessThan(0.001);

  /* The list's own All tab, now on screen, takes the reader back. */
  await tab(page, "All").click();
  await expect(page).toHaveURL(/[?&]view=all(?:&|$)/);
  await expect(tab(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(tab(page, "New")).toHaveAttribute("aria-pressed", "false");

  /* The destination is URL state: a reload of it lands on New. */
  await page.goto("/?view=new");
  await expect(tab(page, "New")).toHaveAttribute("aria-pressed", "true");
});

test("All launches jumps rather than scrolls under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.locator(".launch-card[href^='/pool']").first(),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Just launched" })
    .getByRole("link", { name: "All launches" })
    .click();
  /* No animation frame is needed: the page is already where it lands. */
  const { panel, header } = await placement(page);
  expect(panel - header).toBeCloseTo(HEAD_GAP, 0);
  await expect(tab(page, "New")).toHaveAttribute("aria-pressed", "true");
});
