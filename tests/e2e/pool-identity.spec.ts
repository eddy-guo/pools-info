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
