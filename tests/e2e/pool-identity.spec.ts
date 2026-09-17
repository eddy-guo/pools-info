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
  const sentinel = page.locator(".nullable-pool-page .workspace-grid");
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
  await expect(
    page.getByRole("link", { name: "Launch transaction ↗" }),
  ).toHaveAttribute("href", new RegExp(`/tx/${launchOnly.launchTx}$`, "i"));
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
    ETH unit, the signed change and the range control on one row with no
    select anywhere in the panel; the panel opens high enough for the whole
    canvas to show without scrolling on the desktop; the stat cards under it
    are the export's 95px. */
async function expectChartPanelLikeExport(page: Page, project: Project) {
  const panel = page.locator(".pool-chart-panel");
  await expect(
    panel.locator(".interactive-chart canvas").first(),
  ).toBeVisible();
  await expect(panel.locator("select")).toHaveCount(0);
  const rows = await page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().toJSON();
    return {
      panel: rect(".pool-chart-panel"),
      price: rect(".pool-chart-head .price"),
      unit: rect(".pool-chart-head .price small"),
      change: rect(".pool-chart-head .live-price-heading .change"),
      control: rect(".pool-chart-head .segmented"),
      canvas: rect(".pool-chart-region"),
      stats: [...document.querySelectorAll(".live-six-stats .stat")].map(
        (stat) => stat.getBoundingClientRect().height,
      ),
      tabs: rect(".pool-page .live-section"),
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
  ).toHaveText(/^[+-]\d+\.\d{2}%$/);
  const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
  for (const [name, box] of [
    ["unit", rows.unit],
    ["change", rows.change],
  ] as const)
    expect(
      Math.abs(centre(box) - centre(rows.price)),
      `the ${name} sits on the price's row`,
    ).toBeLessThanOrEqual(4);
  expect(rows.stats.length).toBeGreaterThanOrEqual(5);
  for (const height of rows.stats)
    expect(Math.abs(height - 95), "a 95px stat card").toBeLessThanOrEqual(4);
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
      rows.tabs.y,
      "the tabs panel starts by the first screen's end",
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
