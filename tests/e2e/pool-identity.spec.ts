import { test, expect, type Locator, type Page } from "@playwright/test";
import { shortAddress } from "@pools/core";
import catalog from "../../data/catalog/chain.json";
import chain from "../../data/snapshots/chain.json";
import captures from "../../data/pools/index.json";

/** The read API does not publish every catalog pool's detail. */
const notPublished = { error: "This item is outside available saved coverage." };
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
async function openFromScreener(page: Page, pool: { id: string; token: string }) {
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

test("a pool whose detail is unpublished keeps the identity its row showed", async ({
  page,
}, testInfo) => {
  const release = await withheldDetail(page, launchOnly.id);
  const sentinel = await openFromScreener(page, launchOnly);
  const region = page.locator(".pool-chart-region");
  await expect(region).toHaveAttribute("data-chart", "empty");
  const before = await boxes([sentinel, region]);
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "Pool data is unavailable." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: launchOnly.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pool-identity-title")).toContainText(
    launchOnly.symbol,
  );
  const address = page.locator(".pool-address-slot");
  await expect(address).toContainText(new RegExp(launchOnly.token, "i"));
  await expect(address.getByRole("button")).toBeVisible();
  await expect(
    address.getByRole("link", { name: "Open address on explorer" }),
  ).toHaveAttribute("href", new RegExp(`/address/${launchOnly.token}$`, "i"));
  await expect(page.locator(".pool-launch-meta")).toContainText(
    new RegExp(
      `Launched \\d{4}-\\d{2}-\\d{2}.+${shortAddress(launchOnly.launchSender)}`,
    ),
  );
  await expect(
    page.getByRole("link", { name: "Launch transaction ↗" }),
  ).toHaveAttribute("href", new RegExp(`/tx/${launchOnly.launchTx}$`, "i"));
  await expect(page.locator("body")).not.toContainText(explanations);
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
  await expect(
    page.getByRole("status").filter({ hasText: "Pool data is unavailable." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: measured.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Price chart unavailable")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(explanations);
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
  await expect(
    page.getByRole("status").filter({ hasText: "Pool data is unavailable." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pool name unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pool-address-slot")).toHaveText(
    "Token address unavailable",
  );
  await expect(page.locator(".pool-launch-meta")).toHaveText(
    "Launch time unavailable · sender unavailable",
  );
  await expect(page.locator(".pool-coverage-note")).toHaveText("");
  await expect(page.locator("body")).not.toContainText(explanations);
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
    holds its content, the badges share the name's row on desktop and wrap
    under it on the phone, and the address shows the form that fits. */
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
      /* The launch mode and the evidence badge follow the symbol. */
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
  expect(header.badges).toHaveLength(2);
  for (const badge of header.badges)
    if (project === "desktop")
      expect(badge.top, "badges share the name's row").toBeLessThan(
        header.name.bottom,
      );
    else
      expect(badge.top, "badges wrap under the name").toBeGreaterThanOrEqual(
        header.name.bottom,
      );
  const address = page.locator(".pool-address-slot");
  await expect(address.locator(".mono").filter({ visible: true })).toHaveText(
    new RegExp(`^${project === "desktop" ? token : shortAddress(token)}$`, "i"),
  );
  await expect(
    address.getByRole("button", { name: "Copy address" }),
  ).toBeVisible();
  await expect(
    address.getByRole("link", { name: "Open address on explorer" }),
  ).toBeVisible();
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
    await expect(
      page.getByRole("status").filter({ hasText: "Pool data is unavailable." }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("status").filter({ hasText: "Pool data is unavailable." }),
    ).toBeVisible();
    await expectHeaderFits(
      page,
      launchOnly.token,
      testInfo.project.name as Project,
    );
    expect(await shifts(page), "layout shift as the response lands").toBe(0);
  });
});
