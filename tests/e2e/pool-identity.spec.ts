import { test, expect, type Locator, type Page } from "@playwright/test";
import { shortAddress } from "@pools/core";
import catalog from "../../data/catalog/chain.json";
import chain from "../../data/snapshots/chain.json";
import captures from "../../data/pools/index.json";
import { methodologyCopy } from "../support/pool-copy";

/** The read API does not publish every catalog pool's detail. */
const notPublished = {
  error: "This item is outside available saved coverage.",
};
/** Coverage talk the pool page must never carry back to the reader. */
const explanations =
  /outside current coverage|retry to check coverage|does not prove|no available saved publication|coverage limit/i;
const published = new Set([
  ...chain.markets.map((market) => market.id),
  ...Object.values(captures.snapshots).flatMap((snapshot) =>
    snapshot.markets.map((market) => market.id),
  ),
]);
const launchOnly = catalog.pools
  .filter((pool) => !published.has(pool.id))
  .sort((a, b) => b.launchedAt - a.launchedAt)[0];
/* A pool the screener ranks on a measured market, served from its own capture
   rather than from the preloaded snapshot the measured page reads. */
const measured = Object.values(captures.snapshots).find(
  (snapshot) => !chain.markets.some((m) => m.id === snapshot.markets[0].id),
)!.markets[0];

/** Holds the pool's detail back so the page can be measured before it answers. */
async function withheldDetail(page: Page, poolId: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/product/pools/${poolId}/*`, async (route) => {
    await gate;
    await route.fulfill({ status: 404, json: notPublished });
  });
  return release;
}
async function openFromScreener(
  page: Page,
  pool: { id: string; token: string },
) {
  /* The launches view keeps rows a metric sort would drop. */
  await page.goto(`/?view=new&q=${pool.token}`);
  const row = page
    .locator(`a.token-cell[href*="${pool.id}"]`)
    .filter({ visible: true })
    .first();
  await expect(row).toBeVisible();
  await row.click();
  const sentinel = page.locator(".nullable-pool-page .live-six-stats");
  await expect(sentinel).toBeVisible();
  return sentinel;
}
const boxes = (locators: Locator[]) =>
  Promise.all(locators.map((locator) => locator.boundingBox()));
/** The page has heard back about the pool, published or not. */
const settled = (page: Page) =>
  expect(page.locator(".nullable-pool-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );

test("a pool whose detail is unpublished keeps the identity its row showed", async ({
  page,
}, testInfo) => {
  const release = await withheldDetail(page, launchOnly.id);
  const sentinel = await openFromScreener(page, launchOnly);
  const region = page.locator(".pool-chart-region");
  await expect(region).toHaveAttribute("data-chart", "empty");
  const before = await boxes([sentinel, region]);
  release();
  await settled(page);
  await expect(
    page.getByRole("heading", { name: launchOnly.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pool-identity-title")).toContainText(
    launchOnly.symbol,
  );
  const address = page.locator(".pool-address-slot");
  await expect(address).toContainText(
    new RegExp(shortAddress(launchOnly.token), "i"),
  );
  await expect(address.getByRole("button")).toBeVisible();
  await expect(
    address.getByRole("link", { name: "Open address on explorer" }),
  ).toHaveAttribute("href", new RegExp(`/address/${launchOnly.token}$`, "i"));
  const launchMeta = page.locator(".pool-launch-meta");
  await expect(launchMeta).toHaveText(
    new RegExp(
      `^launched (<1m|\\d+[mhd]) ago by ${shortAddress(launchOnly.launchSender)}$`,
    ),
  );
  await expect(launchMeta.locator("time")).toHaveAttribute(
    "title",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/,
  );
  await expect(launchMeta.getByRole("link")).toHaveAttribute(
    "href",
    `/creators/${launchOnly.launchSender.toLowerCase()}/`,
  );
  await expect(page.locator("body")).not.toContainText(explanations);
  await expect(page.locator("body")).not.toContainText(methodologyCopy);
  await expect(page.getByText("Price chart unavailable")).toBeVisible();
  await expect(page.locator(".interactive-chart")).toHaveCount(0);
  expect(
    (await region.boundingBox())!.height,
    "the chart region holds the empty state, not a chart of nothing",
  ).toBeLessThan(200);
  await page.screenshot({
    path: testInfo.outputPath("unpublished-pool.png"),
    fullPage: false,
  });
  expect(
    await boxes([sentinel, region]),
    "the page and its chart region keep their first-paint geometry",
  ).toEqual(before);
});

test("a measured row holds its chart region when the detail is unpublished", async ({
  page,
}) => {
  await page.route("**/api/markets/**", (route) =>
    route.fulfill({ status: 503, json: notPublished }),
  );
  const release = await withheldDetail(page, measured.id);
  const sentinel = await openFromScreener(page, measured);
  const region = page.locator(".pool-chart-region");
  await expect(region).toHaveAttribute("data-chart", "reserved");
  const before = await boxes([sentinel, region]);
  release();
  await settled(page);
  await expect(
    page.getByRole("heading", { name: measured.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Price chart unavailable")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(explanations);
  await expect(page.locator("body")).not.toContainText(methodologyCopy);
  expect(
    await boxes([sentinel, region]),
    "the page and its chart region keep their first-paint geometry",
  ).toEqual(before);
});

test("a pool opened by URL alone states plain unavailable values", async ({
  page,
}) => {
  await page.route("**/api/product/pools/**", (route) =>
    route.fulfill({ status: 404, json: notPublished }),
  );
  await page.goto(`/pool/${launchOnly.id}/`);
  await settled(page);
  await expect(
    page.getByRole("heading", { name: "Pool name unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pool-address-slot")).toHaveText(
    "Token address unavailable",
  );
  await expect(page.locator(".pool-launch-meta")).toHaveText(
    "launch unavailable",
  );
  await expect(page.locator("body")).not.toContainText(explanations);
  await expect(page.locator("body")).not.toContainText(methodologyCopy);
  await expect(page.getByText("Price chart unavailable")).toBeVisible();
});

/* The header at the product viewports. The phone is the 390px the design's
   mobile frames use, narrower than the mobile project's device. */
const viewports = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
} as const;
type Project = keyof typeof viewports;

async function trackShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { poolHeaderShifts: state });
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
}
/** Shift entries arrive after the frame that moved, so two frames settle first. */
const shifts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(
              (window as unknown as { poolHeaderShifts: { cls: number } })
                .poolHeaderShifts.cls,
            ),
          ),
        ),
      ),
  );
const resetShifts = (page: Page) =>
  page.evaluate(() => {
    (
      window as unknown as { poolHeaderShifts: { cls: number } }
    ).poolHeaderShifts.cls = 0;
  });

/** Nothing scrolls sideways, every control is on screen, each reserved slot
    holds its content, the launch mode badge shares the name's row on desktop
    and wraps under it on the phone, and the address shows the form that fits. */
async function expectHeaderFits(page: Page, token: string, project: Project) {
  const { width } = viewports[project];
  const header = await page.evaluate(() => {
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    const slot = (selector: string) => {
      const node = document.querySelector(selector)!;
      return {
        selector,
        fits:
          node.scrollWidth <= node.clientWidth &&
          node.scrollHeight <= node.clientHeight,
      };
    };
    return {
      scrollWidth: document.documentElement.scrollWidth,
      controls: [
        ...document.querySelectorAll(".page-heading a, .page-heading button"),
      ].map(rect),
      name: rect(document.querySelector(".pool-identity-title h1")!),
      tile: rect(document.querySelector(".pool-image-slot")!),
      copy: rect(document.querySelector(".pool-heading-copy")!),
      /* The launch mode badge follows the symbol. */
      badges: [...document.querySelectorAll(".pool-identity-title > span")]
        .slice(1)
        .map(rect),
      slots: [
        ".pool-identity-title",
        ".pool-address-slot",
        ".pool-launch-meta",
      ].map(slot),
    };
  });
  expect(header.scrollWidth, "the page is the viewport's width").toBe(width);
  expect(header.controls.length).toBeGreaterThanOrEqual(5);
  for (const control of header.controls) {
    expect(control.left, "control inside the viewport").toBeGreaterThanOrEqual(
      0,
    );
    expect(control.right, "control inside the viewport").toBeLessThanOrEqual(
      width,
    );
  }
  for (const slot of header.slots)
    expect(slot.fits, `${slot.selector} holds its content`).toBe(true);
  // The 54px tile sits beside the name it belongs to: its top within the
  // name's line, the copy starting right after it. A phone stacks the copy
  // to several rows, where a tile centred on the column would hang a line
  // and a half under the name beside an empty gutter.
  expect(header.copy.left, "the copy starts after the tile").toBeGreaterThan(
    header.tile.right,
  );
  expect(
    header.tile.top,
    "the tile hangs from the name's line",
  ).toBeGreaterThanOrEqual(header.name.top - 1);
  expect(header.tile.top, "the tile hangs from the name's line").toBeLessThan(
    header.name.bottom,
  );
  expect(header.badges).toHaveLength(1);
  for (const badge of header.badges)
    if (project === "desktop")
      expect(badge.top, "the badge shares the name's row").toBeLessThan(
        header.name.bottom,
      );
    else
      expect(
        badge.top,
        "the badge wraps under the name",
      ).toBeGreaterThanOrEqual(header.name.bottom);
  const address = page.locator(".pool-address-slot");
  await expect(address.locator(".mono").filter({ visible: true })).toHaveText(
    new RegExp(`^${shortAddress(token)}$`, "i"),
  );
  await expect(
    address.getByRole("button", { name: "Copy address" }),
  ).toBeVisible();
  await expect(
    address.getByRole("link", { name: "Open address on explorer" }),
  ).toBeVisible();
}

/** The chart panel as the export lays it out: its head holds the price, the
    ETH unit and the range control on one row with no
    select anywhere in the panel; the panel opens high enough for the whole
    canvas to show without scrolling on the desktop; the stat cards under it
    are the export's 95px, and nothing follows them. */
async function expectChartPanelLikeExport(page: Page, project: Project) {
  const panel = page.locator(".pool-chart-panel");
  await expect(
    panel.locator(".interactive-chart canvas").first(),
  ).toBeVisible();
  await expect(panel.locator("select")).toHaveCount(0);
  // The library's own attribution mark (an `a#tv-attr-logo` it lays over the
  // volume pane) is off; the footer's credit line carries its notice and link.
  await expect(page.locator("#tv-attr-logo")).toHaveCount(0);
  const rows = await page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().toJSON();
    return {
      panel: rect(".pool-chart-panel"),
      price: rect(".pool-chart-head .price"),
      unit: rect(".pool-chart-head .price small"),
      windows: [...document.querySelectorAll(".live-changes > span")].map(
        (node) => ({
          text: node.textContent,
          box: node.getBoundingClientRect().toJSON(),
          fits: node.scrollWidth <= node.clientWidth,
        }),
      ),
      windowsFit: (() => {
        const node = document.querySelector(".live-changes")!;
        return node.scrollWidth <= node.clientWidth;
      })(),
      control: rect(".pool-chart-head .segmented"),
      canvas: rect(".pool-chart-region"),
      stats: [...document.querySelectorAll(".live-six-stats .stat")].map(
        (stat) => ({
          label: stat.querySelector(":scope > span")!.textContent,
          height: stat.getBoundingClientRect().height,
        }),
      ),
      statsTop: rect(".live-six-stats").y,
      last: document.querySelector(".pool-page")!.lastElementChild!.className,
      scrollWidth: document.documentElement.scrollWidth,
      innerHeight: window.innerHeight,
    };
  });
  expect(rows.scrollWidth, "the page is the viewport's width").toBe(
    viewports[project].width,
  );
  await expect(page.locator(".pool-chart-head .price")).toContainText("ETH");
  await expect(
    page.locator(".pool-chart-head .live-price-heading .change"),
  ).toHaveCount(0);
  const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(
    Math.abs(centre(rows.unit) - centre(rows.price)),
    "the unit sits on the price's row",
  ).toBeLessThanOrEqual(4);
  // Every window's figure is legible without sideways scrolling: on the
  // desktop the four share the price panel's one line; on a phone that line
  // cannot hold them, so they take two rows of two rather than a clipped
  // last figure.
  expect(rows.windowsFit, "the window changes fit their row").toBe(true);
  expect(rows.windows.length).toBeGreaterThan(0);
  for (const window of rows.windows) {
    expect(window.text).toMatch(/^\S+ [+-]?\d+\.\d{2}%$/);
    expect(window.fits, `${window.text} is shown whole`).toBe(true);
    expect(window.box.right, `${window.text} is on screen`).toBeLessThanOrEqual(
      viewports[project].width,
    );
  }
  if (project !== "desktop" && rows.windows.length > 2)
    expect(
      rows.windows[2].box.top,
      "the third window starts the second row",
    ).toBeGreaterThan(rows.windows[0].box.bottom - 1);
  expect(rows.stats.map((stat) => stat.label)).toEqual([
    "FDV",
    "Volume 24h",
    "Creator fee",
  ]);
  for (const { height } of rows.stats)
    expect(Math.abs(height - 95), "a 95px stat card").toBeLessThanOrEqual(4);
  expect(rows.last, "the stat cards end the page").toContain("live-six-stats");
  if (project === "desktop") {
    expect(
      rows.control.y,
      "the range control shares the price row",
    ).toBeLessThan(rows.price.y + rows.price.height);
    expect(rows.control.height, "a 32px segmented control").toBe(32);
    expect(
      rows.panel.y,
      "the chart panel opens near the header",
    ).toBeLessThanOrEqual(240);
    expect(rows.panel.height, "the export's 498px panel").toBeLessThanOrEqual(
      520,
    );
    expect(
      rows.canvas.height,
      "a canvas at least as tall as the export's",
    ).toBeGreaterThanOrEqual(360);
    expect(
      rows.canvas.y + rows.canvas.height,
      "the whole chart shows without scrolling",
    ).toBeLessThanOrEqual(rows.innerHeight);
    expect(
      rows.statsTop,
      "the stat cards start by the first screen's end",
    ).toBeLessThanOrEqual(1000);
  } else
    expect(
      rows.panel.y,
      "the chart panel opens near the export's 529px",
    ).toBeLessThanOrEqual(560);
}

test.describe("the pool header fits the viewport", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.setViewportSize(viewports[testInfo.project.name as Project]);
    await trackShifts(page);
  });

  test("on a served pool", async ({ page }, testInfo) => {
    await page.goto(`/pool/${measured.id}/`);
    await expect(
      page.getByRole("heading", { name: measured.name, exact: true }),
    ).toBeVisible();
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    await expectHeaderFits(
      page,
      measured.token,
      testInfo.project.name as Project,
    );
    expect(await shifts(page), "layout shift").toBe(0);
  });

  test("on a measured pool opened from its screener row, with the export's chart panel", async ({
    page,
  }, testInfo) => {
    await openFromScreener(page, measured);
    await resetShifts(page);
    await settled(page);
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    await expectHeaderFits(
      page,
      measured.token,
      testInfo.project.name as Project,
    );
    await expectChartPanelLikeExport(page, testInfo.project.name as Project);
    expect(await shifts(page), "layout shift as the market lands").toBe(0);
  });

  test("the phone chart starts at the export's 529px landmark before and after detail resolves", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile");

    let release!: () => void;
    let detailRequested!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      detailRequested = resolve;
    });
    await page.route(`**/api/product/pools/${measured.id}/*`, async (route) => {
      detailRequested();
      await gate;
      await route.continue();
    });

    await page.goto(`/?view=new&q=${measured.token}`);
    const row = page
      .locator(`a.token-cell[href*="${measured.id}"]`)
      .filter({ visible: true })
      .first();
    await expect(row).toBeVisible();
    await row.click();
    await requested;
    await expect(page.locator(".nullable-pool-page")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.locator(".pool-chart-panel")).toBeVisible();
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    expect(
      (await page.locator(".pool-chart-panel").boundingBox())!.y,
      "pending chart top",
    ).toBe(529);

    await resetShifts(page);
    release();
    await settled(page);
    expect(
      (await page.locator(".pool-chart-panel").boundingBox())!.y,
      "resolved chart top",
    ).toBe(529);
    expect(await shifts(page), "layout shift as the detail lands").toBe(0);
  });

  test("on a measured row whose detail is unpublished", async ({
    page,
  }, testInfo) => {
    await page.route("**/api/markets/**", (route) =>
      route.fulfill({ status: 503, json: notPublished }),
    );
    const release = await withheldDetail(page, measured.id);
    await openFromScreener(page, measured);
    await resetShifts(page);
    release();
    await settled(page);
    await expectHeaderFits(
      page,
      measured.token,
      testInfo.project.name as Project,
    );
    expect(await shifts(page), "layout shift as the response lands").toBe(0);
  });

  test("the window changes hold the sweep's four figures whole", async ({
    page,
  }, testInfo) => {
    /* The fixture's markets span minutes, so no served pool carries four
       windows of three-digit changes; the row is measured with the exact
       figures the sweep clipped on production (`7d +37…` cut at 390px). */
    const project = testInfo.project.name as Project;
    await page.goto(`/pool/${measured.id}/`);
    await expect(page.locator(".live-changes > span").first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    const rows = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".live-changes")!;
      const figures = [
        ["1h", "+376.09%"],
        ["6h", "+376.09%"],
        ["24h", "+376.09%"],
        ["7d", "+376.09%"],
      ];
      row.replaceChildren(
        ...figures.map(([window, change]) => {
          const span = document.createElement("span");
          const b = document.createElement("b");
          b.textContent = window;
          const value = document.createElement("span");
          value.className = "number change positive";
          value.textContent = change;
          span.append(b, " ", value);
          return span;
        }),
      );
      return {
        fits:
          row.scrollWidth <= row.clientWidth &&
          row.scrollHeight <= row.clientHeight,
        height: row.getBoundingClientRect().height,
        bottom: row.getBoundingClientRect().bottom,
        windows: [...row.children].map((node) => ({
          text: node.textContent,
          box: node.getBoundingClientRect().toJSON(),
          fits: node.scrollWidth <= node.clientWidth,
        })),
      };
    });
    expect(rows.fits, "the row holds all four without overflow").toBe(true);
    for (const window of rows.windows) {
      expect(window.fits, `${window.text} is shown whole`).toBe(true);
      expect(
        window.box.bottom,
        `${window.text} sits inside the row's box`,
      ).toBeLessThanOrEqual(rows.bottom);
      expect(
        window.box.left,
        `${window.text} is on screen`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        window.box.right,
        `${window.text} is on screen`,
      ).toBeLessThanOrEqual(viewports[project].width);
    }
    if (project === "desktop") {
      expect(rows.height, "one 17px line").toBe(17);
      for (const window of rows.windows)
        expect(window.box.top, "the four share one line").toBe(
          rows.windows[0].box.top,
        );
    } else {
      expect(rows.height, "two reserved 17px lines").toBe(34);
      expect(rows.windows[1].box.top, "two per row").toBe(
        rows.windows[0].box.top,
      );
      expect(
        rows.windows[2].box.top,
        "the third starts the second row",
      ).toBeGreaterThanOrEqual(rows.windows[0].box.bottom - 1);
      expect(rows.windows[3].box.top).toBe(rows.windows[2].box.top);
    }
  });

  test("on a launch-only row whose detail is unpublished", async ({
    page,
  }, testInfo) => {
    const release = await withheldDetail(page, launchOnly.id);
    await openFromScreener(page, launchOnly);
    await resetShifts(page);
    release();
    await settled(page);
    await expectHeaderFits(
      page,
      launchOnly.token,
      testInfo.project.name as Project,
    );
    expect(await shifts(page), "layout shift as the response lands").toBe(0);
  });
});
