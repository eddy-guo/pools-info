import { test, expect, type Page, type TestInfo } from "@playwright/test";
import catalog from "../../data/catalog/chain.json";
import {
  crowdExplorePage,
  crowdLaunches,
  crowdPoolDetail,
} from "../support/crowd-launches";

/* The crowd launch contract's explore answer, mocked: 40 crowd launches,
   newest first, of which every third carries the ledger's market figures and
   the rest are listed but unmeasured, as they read during the crowd ledger's
   catch-up after the deploy. */
const launches = crowdLaunches(40, 3);
const measured = launches.filter((row) => row.stats.volumeWei !== null);
const unmeasured = launches.find((row) => row.stats.volumeWei === null)!;

const desktop = (testInfo: TestInfo) => testInfo.project.name === "desktop";
/* The phone bar is 390px wide, narrower than the mobile project's Pixel 7. */
test.beforeEach(async ({ page }, testInfo) => {
  if (!desktop(testInfo))
    await page.setViewportSize({ width: 390, height: 844 });
});

async function serveCrowd(page: Page) {
  await page.route("**/api/product/explore/**", (route) => {
    const json = crowdExplorePage(launches, route.request().url());
    return json ? route.fulfill({ json }) : route.continue();
  });
}
const rows = (page: Page, testInfo: TestInfo) =>
  page.locator(
    desktop(testInfo)
      ? ".explore-page .desktop-pools tbody tr[data-row='resolved']"
      : ".explore-page .mobile-pools article[data-row='resolved']",
  );
const tabs = (page: Page) =>
  page.locator(".explore-toolbar .table-tabs button");
const tab = (page: Page, name: string) =>
  page
    .locator(".explore-toolbar .table-tabs")
    .getByRole("button", { name, exact: true });
const search = (page: Page) => new URL(page.url()).searchParams;
const names = (page: Page, testInfo: TestInfo) =>
  rows(page, testInfo).locator(".token-cell strong").allTextContents();

test("the Crowd tab lists crowd launches, measured or not, each with its chip", async ({
  page,
}, testInfo) => {
  await serveCrowd(page);
  const sent = page.waitForRequest(
    (request) =>
      request.url().includes("/api/product/explore") &&
      request.url().includes("view=crowd"),
  );
  await page.goto("/?view=crowd&sort=launch");
  await sent;
  await expect(tabs(page)).toHaveText([
    "All",
    "Gainers",
    "New",
    "Crowd",
    "Watchlist",
  ]);
  await expect(tab(page, "Crowd")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page, testInfo)).toHaveCount(25);
  expect(await names(page, testInfo)).toEqual(
    launches.slice(0, 25).map((row) => row.name),
  );

  /* Every row is a crowd launch, and carries the export's chip beside its
     subtitle, whole: the line before it gives way instead. */
  const chips = rows(page, testInfo).locator(".token-cell small .mode-badge");
  await expect(chips).toHaveCount(25);
  await expect(chips.first()).toHaveText("Crowd");
  await expect(chips.first()).toHaveCSS("text-transform", "uppercase");
  const fits = await rows(page, testInfo)
    .locator(".token-cell small")
    .evaluateAll((smalls) =>
      smalls.map((small) => {
        const chip = small.querySelector(".mode-badge")!;
        const box = small.getBoundingClientRect(),
          own = chip.getBoundingClientRect();
        return (
          own.width > 0 &&
          own.left >= box.left - 0.5 &&
          own.right <= box.right + 0.5 &&
          own.height <= box.height + 0.5
        );
      }),
    );
  expect(fits, "each chip sits whole inside its subtitle line").toEqual(
    Array(25).fill(true),
  );

  /* A measured crowd launch reads its figures; an unmeasured one reads as
     any launch without market evidence does: its launch line, never a zero
     or an estimate in the figure columns. */
  const first = rows(page, testInfo).nth(0),
    second = rows(page, testInfo).nth(1);
  expect(launches[0].stats.volumeWei).not.toBeNull();
  expect(launches[1].stats.volumeWei).toBeNull();
  if (desktop(testInfo)) {
    await expect(first.locator(".launch-cell")).toHaveCount(0);
    await expect(first.locator("td")).toHaveCount(6);
    await expect(second.locator("td.launch-cell")).toContainText("Launched");
    await expect(second.locator(".price, .change, .number")).toHaveCount(0);
  } else {
    await expect(first.locator(".mobile-pool-price")).toHaveCount(1);
    await expect(first.locator(".mobile-pool-stats")).toContainText("trades");
    await expect(second.locator(".mobile-pool-price")).toHaveCount(0);
    await expect(second.locator("[data-launch-row='true']")).toContainText(
      "Launched",
    );
  }
  await expect(second).not.toContainText(/\b0(\.0+)? ETH\b/);

  /* A crowd row keeps every other row's height: the chip stands inside the
     subtitle's own line. */
  const heights = await rows(page, testInfo).evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height),
  );
  expect(new Set(heights)).toEqual(new Set([desktop(testInfo) ? 62 : 104]));
});

test("a volume order leaves the unmeasured crowd launches out as the read API does, and the screener re-sorts nothing", async ({
  page,
}, testInfo) => {
  await serveCrowd(page);
  await page.goto("/?view=crowd");
  await expect(rows(page, testInfo)).toHaveCount(measured.length);
  /* The mock answers in launch order, not by volume: the rows keep the
     server's order exactly. */
  expect(await names(page, testInfo)).toEqual(measured.map((row) => row.name));
});

test("the Crowd view lives in the URL: Show more, reload and Back restore it", async ({
  page,
}, testInfo) => {
  await serveCrowd(page);
  await page.goto("/?sort=launch");
  await expect(tab(page, "All")).toHaveAttribute("aria-pressed", "true");
  await tab(page, "Crowd").click();
  await expect(tab(page, "Crowd")).toHaveAttribute("aria-pressed", "true");
  expect(search(page).get("view")).toBe("crowd");
  await expect(rows(page, testInfo)).toHaveCount(measured.length);

  await page.goto("/?view=crowd&sort=launch");
  await expect(rows(page, testInfo)).toHaveCount(25);
  await page.getByRole("button", { name: /^Show \d+ more$/ }).click();
  /* The request is clamped to the 40 launches the first page already
     named, as every growable list does. */
  await expect
    .poll(() => search(page).get("limit"))
    .toBe(String(launches.length));
  await expect(rows(page, testInfo)).toHaveCount(launches.length);
  await expect(
    page.getByRole("button", { name: /^Show \d+ more$/ }),
  ).toHaveCount(0);

  await page.reload();
  await expect(tab(page, "Crowd")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page, testInfo)).toHaveCount(launches.length);

  await tab(page, "All").click();
  await expect.poll(() => search(page).get("view")).toBeNull();
  await expect(tab(page, "All")).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect.poll(() => search(page).get("view")).toBe("crowd");
  await expect(tab(page, "Crowd")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page, testInfo)).toHaveCount(launches.length);
  await expect(
    rows(page, testInfo).locator(".token-cell small .mode-badge"),
  ).toHaveCount(launches.length);
});

test("the Crowd view paints its mixed rows with no layout shift", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const state = { cls: 0, shifts: [] as unknown[] };
    Object.assign(window, { layoutMeasurement: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources?: {
            node?: Node;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        state.cls += shift.value;
        state.shifts.push({
          value: shift.value,
          sources: shift.sources?.map((source) => ({
            node:
              source.node instanceof Element
                ? `${source.node.tagName}.${[...source.node.classList].join(".")}`
                : source.node?.nodeName,
            previous: source.previousRect.toJSON(),
            current: source.currentRect.toJSON(),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  /* The static shell paints first, as a slow device paints it: the client
     scripts wait until its skeleton rows are on screen. */
  let releaseScripts!: () => void;
  const scripts = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scripts;
    await route.continue();
  });
  await serveCrowd(page);
  try {
    await page.goto("/?view=crowd&sort=launch", { waitUntil: "commit" });
    await expect(
      page.locator(".explore-page [data-row='skeleton']").first(),
    ).toBeVisible();
    releaseScripts();
    await expect(rows(page, testInfo)).toHaveCount(25);
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const measurement = await page.evaluate(
      () =>
        (
          window as unknown as {
            layoutMeasurement: { cls: number; shifts: unknown[] };
          }
        ).layoutMeasurement,
    );
    await testInfo.attach("layout-measurement", {
      body: JSON.stringify(measurement, null, 2),
      contentType: "application/json",
    });
    /* Under 0.001 is sub-pixel measurement noise, as in
       layout-stability.spec.ts. */
    expect(measurement.cls, JSON.stringify(measurement.shifts)).toBeLessThan(
      0.001,
    );
  } finally {
    releaseScripts();
  }
});

test("the pool header names the launch mode the read API serves, and claims none it does not", async ({
  page,
}) => {
  await page.route(`**/api/product/pools/${unmeasured.id}/**`, (route) =>
    route.fulfill({ json: crowdPoolDetail(unmeasured) }),
  );
  await page.goto(`/pool/${unmeasured.id}/`);
  const title = page.locator(".pool-identity-title");
  await expect(title.getByRole("heading", { level: 1 })).toHaveText(
    unmeasured.name,
  );
  await expect(title).toContainText("CROWD");
  await expect(title).not.toContainText("INSTANT");

  /* Every pool in the committed dataset is an Instant launch. */
  const instant = catalog.pools[0];
  await page.goto(`/pool/${instant.id}/`);
  await expect(title.getByRole("heading", { level: 1 })).toHaveText(
    instant.name,
  );
  await expect(title).toContainText("INSTANT");

  /* A pool the read API could not serve has no launch type to show. */
  await page.route(`**/api/product/pools/${unmeasured.id}/**`, (route) =>
    route.fulfill({ status: 503, json: { error: "data_unavailable" } }),
  );
  await page.goto(`/pool/${unmeasured.id}/`);
  await expect(page.locator(".nullable-pool-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(title).not.toContainText(/INSTANT|CROWD/);
});

test("a wallet's own launches carry the chip on a crowd launch only", async ({
  page,
}, testInfo) => {
  /* A launching wallet from the committed dataset, one of whose launches
     the mocked read API names a crowd launch. */
  const sender = catalog.pools[0].launchSender.toLowerCase();
  let crowdName = "";
  await page.route(`**/api/product/wallets/${sender}/**`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.launches[0].launchType = "crowd";
    crowdName = json.launches[0].name;
    await route.fulfill({ response, json });
  });
  await page.goto(`/wallet/${sender}/?tab=launches`);
  const list = page.locator(
    desktop(testInfo)
      ? ".wallet-launches-table tbody tr"
      : ".mobile-wallet-rows .mobile-wallet-row",
  );
  await expect(list.first()).toBeVisible();
  const chips = list.locator(".mode-badge");
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveText("Crowd");
  await expect(list.first()).toContainText(crowdName);
  const [chip, row] = await Promise.all([
    chips.boundingBox(),
    list.first().boundingBox(),
  ]);
  expect(
    chip!.x + chip!.width,
    "the chip sits whole inside its row",
  ).toBeLessThanOrEqual(row!.x + row!.width);
});
