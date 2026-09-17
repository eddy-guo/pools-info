import { test, expect, type Page } from "@playwright/test";
import type { CreatorRow, CreatorsResponse } from "@pools/core";

const coverage: CreatorsResponse["coverage"] = {
  catalogPools: 130,
  processedPools: 130,
  asOf: 1_700_000_000,
  oldestAsOf: 1_700_000_000,
  generatedAt: "2026-09-17T00:00:00.000Z",
  complete: false,
  registryExhaustive: false,
  pnlScope: "observed_initiator_and_verified_positions",
};

/** 130 creators, one measured launch group excluded every ninth row, one bought-own address. */
const TOTAL = 130;
const rows: CreatorRow[] = Array.from({ length: TOTAL }, (_, i) => {
  const address = `0x${(i + 1).toString(16).padStart(40, "0")}`;
  const measured = i % 9 === 0 ? 0 : 3;
  const volumeWei = measured
    ? (BigInt(TOTAL - i) * 10n ** 15n).toString()
    : null;
  const medianVolumeWei = measured
    ? (BigInt(TOTAL - i) * 5n ** 14n).toString()
    : null;
  return {
    address,
    // Constant across rows so sort=launches ties break on volume, which is
    // itself monotonic in i: both give the same predictable index order.
    launches: 5,
    measured,
    traded: measured ? 2 : 0,
    volumeWei,
    medianVolumeWei,
    bestLaunch: measured
      ? {
          id: `0x${(i + 1).toString(16).padStart(64, "3")}`,
          token: `0x${(i + 1).toString(16).padStart(40, "4")}`,
          name: `Pool ${i}`,
          symbol: `P${i}`,
          launchTx: `0x${(i + 1).toString(16).padStart(64, "5")}`,
          launchSender: address,
          launchBlock: 1_000_000 + i,
          launchedAt: 1_700_000_000 + i,
          volumeWei: volumeWei!,
        }
      : null,
    boughtOwnLaunch: measured === 0 ? null : i === 1,
  };
});

/** The 24h window is thin: exhausted well before the 100 cap, to exercise the button disappearing early. */
const THIN_WINDOW_TOTAL = 12;

function creatorsPage(
  window: string,
  sort: string,
  offset: number,
  limit: number,
): CreatorsResponse {
  const universe = window === "24h" ? rows.slice(0, THIN_WINDOW_TOTAL) : rows;
  const scoped =
    sort === "launches" ? universe : universe.filter((r) => r.measured > 0);
  const metric = sort === "median" ? "medianVolumeWei" : "volumeWei";
  const sorted = [...scoped].sort((a, b) => {
    if (sort === "launches" && a.launches !== b.launches)
      return b.launches - a.launches;
    const av = BigInt(a[metric] ?? "0"),
      bv = BigInt(b[metric] ?? "0");
    return av === bv ? a.address.localeCompare(b.address) : bv > av ? 1 : -1;
  });
  const items = sorted.slice(offset, offset + limit);
  return {
    coverage,
    broadMarketCutoff: null,
    window: window as CreatorsResponse["window"],
    sort: sort as CreatorsResponse["sort"],
    direction: "desc",
    attribution: "launch_transaction_initiator",
    measuredFigures: [
      "measured",
      "traded",
      "volumeWei",
      "medianVolumeWei",
      "bestLaunch",
      "boughtOwnLaunch",
    ],
    note: "launches counts every discovered launch by the sender; measured, traded, volumeWei, medianVolumeWei, bestLaunch and boughtOwnLaunch come from measured launches only.",
    items,
    total: sorted.length,
    nextOffset: offset + limit < sorted.length ? offset + limit : null,
  };
}

async function serveCreators(page: Page) {
  await page.route("**/api/product/creators**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json: creatorsPage(
        params.get("window") ?? "All",
        params.get("sort") ?? "launches",
        Number(params.get("offset") ?? 0),
        Number(params.get("limit") ?? 25),
      ),
    });
  });
}

const removedCopy = [
  "Loading creators",
  "Load more",
  "pools ·",
  "launch_transaction_initiator",
  "coverage",
  "methodology",
  "Previous",
  "Next",
];

test("creators reveal 25 more at a click, up to a top-100 leaderboard, with the bought-own chip", async ({
  page,
}) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const footer = panel.locator(".pagination");
  const count = footer.locator(".pagination-count");
  const showMore = footer.getByRole("button", { name: "Show 25 more" });
  const rowsLocator = panel.locator("tbody tr");

  for (const copy of removedCopy)
    await expect(page.getByText(copy), copy).toHaveCount(0);
  // No page-size choice remains: only the sort segmented control and the window tabs.
  await expect(
    page.getByRole("button", { name: "50", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "100", exact: true }),
  ).toHaveCount(0);

  await expect(count).toHaveText("Showing 25 of 100");
  await expect(rowsLocator).toHaveCount(25);
  await expect(showMore).toBeEnabled();
  // Only the fixture's one true row (index 1) carries the chip.
  await expect(panel.getByText("BOUGHT OWN")).toHaveCount(1);

  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  await expect(count).toHaveText("Showing 50 of 100");
  await expect(rowsLocator).toHaveCount(50);

  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=75(?:&|$)/);
  await expect(count).toHaveText("Showing 75 of 100");
  await expect(rowsLocator).toHaveCount(75);

  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=100(?:&|$)/);
  await expect(count).toHaveText("Showing 100 of 100");
  await expect(rowsLocator).toHaveCount(100);
  // The page never requests beyond 100, regardless of the fixture's larger total.
  await expect(showMore).toHaveCount(0);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the pagination bar fits the viewport",
  ).toBe(true);
});

test("Show more moves focus to the first newly revealed row", async ({
  page,
}) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const showMore = panel.locator(".pagination").getByRole("button", {
    name: "Show 25 more",
  });
  const rowsLocator = panel.locator("tbody tr");

  await expect(rowsLocator).toHaveCount(25);
  await showMore.click();
  await expect(rowsLocator).toHaveCount(50);
  await expect(rowsLocator.nth(25).locator(".address-chip-link")).toBeFocused();
});

test("creators sort and window map onto the read API's keys and reset the reveal to 25", async ({
  page,
}) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const footer = panel.locator(".pagination");
  const count = footer.locator(".pagination-count");
  const showMore = footer.getByRole("button", { name: "Show 25 more" });
  const volume = page.getByRole("button", { name: "Volume", exact: true });
  const median = page.getByRole("button", { name: "Median", exact: true });
  const launches = page.getByRole("button", { name: "Launches", exact: true });
  const window24h = page.getByRole("button", { name: "24h", exact: true });
  const windowAll = page.getByRole("button", { name: "All", exact: true });

  await expect(launches).toHaveAttribute("aria-pressed", "true");
  await expect(windowAll).toHaveAttribute("aria-pressed", "true");

  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);

  await volume.click();
  await expect(page).toHaveURL(/[?&]sort=volume(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(volume).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText("Showing 25 of 100");
  // Rows with no measured launch are excluded under a metric sort.
  await expect(panel.locator("tbody tr").first()).not.toContainText("N/A");

  await median.click();
  await expect(page).toHaveURL(/[?&]sort=median(?:&|$)/);
  await expect(median).toHaveAttribute("aria-pressed", "true");

  await launches.click();
  await expect(page).not.toHaveURL(/[?&]sort=/);
  await expect(launches).toHaveAttribute("aria-pressed", "true");

  // A thin window exhausts before the cap: the button disappears once its own total is shown.
  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await window24h.click();
  await expect(page).toHaveURL(/[?&]window=24h(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(window24h).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText(
    `Showing ${THIN_WINDOW_TOTAL} of ${THIN_WINDOW_TOTAL}`,
  );
  await expect(showMore).toHaveCount(0);

  await windowAll.click();
  await expect(page).toHaveURL(/[?&]window=All(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(windowAll).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText("Showing 25 of 100");
});

test("reload and Back restore the shown count", async ({ page }) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const footer = panel.locator(".pagination");
  const count = footer.locator(".pagination-count");
  const showMore = footer.getByRole("button", { name: "Show 25 more" });
  const rowsLocator = panel.locator("tbody tr");

  await showMore.click();
  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=75(?:&|$)/);
  await expect(rowsLocator).toHaveCount(75);

  // Reload restores the exact shown count from the URL.
  await page.reload();
  await expect(page).toHaveURL(/[?&]limit=75(?:&|$)/);
  await expect(rowsLocator).toHaveCount(75);
  await expect(count).toHaveText("Showing 75 of 100");

  // Back, after navigating to a creator profile, restores the same state too.
  const firstLink = rowsLocator.first().locator(".address-chip-link");
  const href = (await firstLink.getAttribute("href"))!;
  await firstLink.click();
  await expect(page).toHaveURL(new RegExp(href));
  await page.goBack();
  await expect(page).toHaveURL(/[?&]limit=75(?:&|$)/);
  await expect(rowsLocator).toHaveCount(75);
});
