import { test, expect, type Page } from "@playwright/test";

const resolved = (page: Page) =>
  page.locator(".explore-page [data-row='resolved']").filter({ visible: true });

test.describe("screener column room", () => {
  test.skip(
    ({ isMobile }) => !!isMobile,
    "desktop column geometry is covered in the desktop project",
  );

  for (const width of [1440, 1280, 1163])
    test(`keeps deliberate numeric and sender tracks at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/");
      await expect(resolved(page).first()).toBeVisible();
      const measured = await page
        .locator(".explore-page .desktop-pools")
        .evaluate((root) => {
          const table = root.querySelector("table")!;
          const scroll = table.parentElement!;
          const row = table.querySelector("tbody tr[data-row='resolved']")!;
          const cells = [...row.querySelectorAll("td")];
          const heads = [...table.querySelectorAll("thead th")];
          const chip = row.querySelector(".address-chip")!;
          const link = chip.querySelector(".address-chip-link")!;
          const actions = chip.querySelector(".address-chip-actions")!;
          const controls = [...actions.children];
          const box = (node: Element) => {
            const rect = node.getBoundingClientRect();
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              right: rect.right,
              bottom: rect.bottom,
            };
          };
          return {
            columns: cells.map((cell) => box(cell).width),
            headAlignment: heads.map(
              (head) => getComputedStyle(head).textAlign,
            ),
            cellAlignment: cells.map(
              (cell) => getComputedStyle(cell).textAlign,
            ),
            numericVariants: cells
              .slice(2, 5)
              .map((cell) => getComputedStyle(cell).fontVariantNumeric),
            sender: {
              chip: box(chip),
              link: box(link),
              actions: box(actions),
              controls: controls.map(box),
              labels: controls.map((control) =>
                (control.matches("button, a")
                  ? control
                  : control.querySelector("button, a")
                )?.getAttribute("aria-label"),
              ),
            },
            overflow: scroll.scrollWidth - scroll.clientWidth,
          };
        });

      expect(measured.columns.slice(2), "four right tracks").toEqual([
        132, 112, 140, 190,
      ]);
      expect(
        measured.columns[1],
        "Token leaves room for the right side",
      ).toBeLessThan(
        measured.columns.slice(2).reduce((sum, value) => sum + value, 0),
      );
      expect(
        measured.overflow,
        "the list never scrolls sideways",
      ).toBeLessThanOrEqual(0);
      for (const index of [2, 3, 4]) {
        expect(measured.headAlignment[index]).toBe("right");
        expect(measured.cellAlignment[index]).toBe("right");
        expect(measured.numericVariants[index - 2]).toContain("tabular-nums");
      }
      expect(
        Math.abs(measured.sender.link.y - measured.sender.actions.y),
        "address, copy and explorer share one line",
      ).toBeLessThanOrEqual(1);
      expect(measured.sender.actions.x).toBeGreaterThanOrEqual(
        measured.sender.link.right,
      );
      expect(measured.sender.actions.right).toBeLessThanOrEqual(
        measured.sender.chip.right + 0.5,
      );
      expect(measured.sender.labels).toEqual([
        "Copy address",
        "Open address on explorer",
      ]);
      for (const control of measured.sender.controls) {
        expect(
          control.width,
          "inline action keeps its existing hit target",
        ).toBeGreaterThanOrEqual(16);
        expect(
          control.height,
          "inline action keeps its existing hit target",
        ).toBeGreaterThanOrEqual(16);
      }
    });
});

test("the true 390px frame keeps the mobile cards and no horizontal overflow", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "phone presentation is covered in the mobile project");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(resolved(page).first()).toBeVisible();
  expect(await page.evaluate(() => innerWidth)).toBe(390);
  await expect(page.locator(".desktop-pools")).toBeHidden();
  await expect(page.locator(".mobile-pools")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
    "the page does not scroll sideways",
  ).toBe(0);
  const card = await resolved(page).first().boundingBox();
  expect(card?.width).toBe(360);
  expect(card?.height).toBe(104);
});

test("a young pool names its missing comparison without inventing a percentage", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { screenerShift: state });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const shift = entry as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.route("**/api/product/explore/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") === "6") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    const now = Math.floor(Date.now() / 1000);
    Object.assign(payload.items[0], { launchedAt: now - 8 * 60 });
    Object.assign(payload.items[0].stats, {
      change: null,
      completeWindow: false,
    });
    if (payload.items[0].marketCoverage)
      payload.items[0].marketCoverage.priceBaseline = null;
    Object.assign(payload.items[1].stats, { change: 12.34 });
    Object.assign(payload.items[2], { launchedAt: now - 3 * 86400 });
    Object.assign(payload.items[2].stats, {
      change: null,
      completeWindow: false,
    });
    if (payload.items[2].marketCoverage)
      payload.items[2].marketCoverage.priceBaseline = null;
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/");
  await expect(resolved(page)).toHaveCount(9);
  const young = resolved(page).nth(0).locator(".change-age");
  await expect(young).toHaveText(/^new · [78]m$/);
  await expect(young).toHaveAttribute(
    "aria-label",
    /^No 24h change yet; launched [78]m ago$/,
  );
  await expect(young, "no fabricated zero percentage").not.toContainText("%");
  const normal = resolved(page).nth(1).locator(".change");
  await expect(normal).toHaveText("+12.34%");
  await expect(normal).toHaveClass(/positive/);
  await expect(normal).toHaveCSS("font-variant-numeric", /tabular-nums/);
  const unknown = resolved(page).nth(2).locator(".change");
  await expect(unknown, "an older unknown stays unknown").toHaveText("");
  await expect(unknown).toHaveAttribute(
    "aria-label",
    "Unavailable: No opening price observation",
  );
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { screenerShift: { cls: number } }).screenerShift
          .cls,
    ),
    "the young label resolves at CLS 0",
  ).toBe(0);
});
