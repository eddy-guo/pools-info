import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  poolHref,
  shortAddress,
  type AnalyticsPoolRow,
  type CreatorRow,
  type CreatorsResponse,
} from "@pools/core";
import {
  creatorAddress,
  creatorLaunches,
  creatorLaunchesPage,
} from "../support/creator-launches";

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

/** The board draws its table where the table fits and its rows where it does
    not: the desktop project's 1440px shows the table, the Pixel 7's rows. */
const boardRows = (panel: Locator, isMobile: boolean) =>
  panel.locator(isMobile ? ".mobile-creator" : "tbody tr");

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
  isMobile,
}) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const footer = panel.locator(".pagination");
  const count = footer.locator(".pagination-count");
  const showMore = footer.getByRole("button", { name: "Show 25 more" });
  const rowsLocator = boardRows(panel, isMobile);

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
  await expect(rowsLocator.getByText("BOUGHT OWN")).toHaveCount(1);

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
  isMobile,
}) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const showMore = panel.locator(".pagination").getByRole("button", {
    name: "Show 25 more",
  });
  const rowsLocator = boardRows(panel, isMobile);

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

test("reload and Back restore the shown count", async ({ page, isMobile }) => {
  await serveCreators(page);
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const footer = panel.locator(".pagination");
  const count = footer.locator(".pagination-count");
  const showMore = footer.getByRole("button", { name: "Show 25 more" });
  const rowsLocator = boardRows(panel, isMobile);

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

test("creators rows match the export's cell shapes: rank colour, chip, still-trading bar and right-aligned figures", async ({
  page,
  isMobile,
}) => {
  const goldAddress = "0x00000000000000000000000000000000000aa1";
  const silverAddress = "0x00000000000000000000000000000000000bb2";
  const bronzeAddress = "0x00000000000000000000000000000000000cc3";
  const plainAddress = "0x00000000000000000000000000000000000dd4";
  const unmeasuredAddress = "0x00000000000000000000000000000000000ee5";
  const bestLaunch = (
    address: string,
    symbol: string,
    volumeWei: string,
  ): NonNullable<CreatorRow["bestLaunch"]> => ({
    id: `0x${symbol.toLowerCase()}`.padEnd(66, "0"),
    token: `0x${symbol.toLowerCase()}t`.padEnd(42, "0"),
    name: symbol,
    symbol,
    launchTx: `0x${symbol.toLowerCase()}x`.padEnd(66, "0"),
    launchSender: address,
    launchBlock: 1,
    launchedAt: 1_700_000_000,
    volumeWei,
  });
  const items: CreatorRow[] = [
    {
      address: goldAddress,
      launches: 14,
      measured: 14,
      traded: 9,
      volumeWei: "412800000000000000000",
      medianVolumeWei: "18400000000000000000",
      bestLaunch: bestLaunch(goldAddress, "ORBIT", "412800000000000000000"),
      boughtOwnLaunch: true,
    },
    {
      address: silverAddress,
      launches: 11,
      measured: 11,
      traded: 7,
      volumeWei: "388100000000000000000",
      medianVolumeWei: "22000000000000000000",
      bestLaunch: bestLaunch(silverAddress, "KITE", "388100000000000000000"),
      boughtOwnLaunch: false,
    },
    {
      address: bronzeAddress,
      launches: 9,
      measured: 9,
      traded: 6,
      volumeWei: "301400000000000000000",
      medianVolumeWei: "26700000000000000000",
      bestLaunch: bestLaunch(bronzeAddress, "LILY", "301400000000000000000"),
      boughtOwnLaunch: false,
    },
    {
      address: plainAddress,
      launches: 21,
      measured: 4,
      traded: 4,
      volumeWei: "266900000000000000000",
      medianVolumeWei: "6200000000000000000",
      bestLaunch: bestLaunch(plainAddress, "SUND", "266900000000000000000"),
      boughtOwnLaunch: false,
    },
    {
      address: unmeasuredAddress,
      launches: 3,
      measured: 0,
      traded: 0,
      volumeWei: null,
      medianVolumeWei: null,
      bestLaunch: null,
      boughtOwnLaunch: null,
    },
  ];
  await page.route("**/api/product/creators**", async (route) => {
    await route.fulfill({
      json: {
        coverage,
        broadMarketCutoff: null,
        window: "All",
        sort: "launches",
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
        note: "",
        items,
        total: items.length,
        nextOffset: null,
      } satisfies CreatorsResponse,
    });
  });
  await page.goto("/creators/");
  const panel = page.locator(".creators-panel");
  const goldShort = shortAddress(goldAddress);
  if (isMobile) {
    // The screener's phone row: rank, chip and badge with the launch count at
    // the right, then Vol and the still-trading bar on one line beneath.
    const cards = panel.locator('.mobile-creator[data-row="resolved"]');
    await expect(cards).toHaveCount(5);
    await expect(panel.locator(".desktop-creators")).toBeHidden();
    const rank = (n: number) => cards.nth(n).locator(".rank-number");
    await expect(rank(0)).toHaveCSS("color", "rgb(224, 180, 92)");
    await expect(rank(1)).toHaveCSS("color", "rgb(201, 203, 212)");
    await expect(rank(2)).toHaveCSS("color", "rgb(201, 138, 92)");
    await expect(rank(3)).toHaveCSS("color", "rgb(154, 154, 164)");
    const first = cards.first();
    await expect(first.locator(".address-chip .mono")).toHaveText(goldShort);
    await expect(first.getByText("BOUGHT OWN")).toBeVisible();
    await expect(cards.nth(1).getByText("BOUGHT OWN")).toHaveCount(0);
    await expect(first.locator(".mobile-creator-launches strong")).toHaveText(
      "14",
    );
    const stats = first.locator(".mobile-creator-stats");
    await expect(stats).toContainText("Vol 412.8 ETH");
    await expect(stats.locator(".still-trading-label")).toHaveText(
      "9 of 14 · 64%",
    );
    const unmeasured = cards.nth(4).locator(".mobile-creator-stats");
    await expect(unmeasured).not.toContainText("Vol");
    await expect(unmeasured.locator(".unavailable")).toHaveAttribute(
      "aria-label",
      "Unavailable: No measured launch",
    );
    // A creator with launches the read has no figure for shows no bar: its
    // "4 of 4" would read as a survival rate over the 21 launches beside it.
    const partial = cards.nth(3).locator(".mobile-creator-stats");
    await expect(partial).toContainText("Vol 266.9 ETH");
    await expect(partial.locator(".still-trading")).toHaveCount(0);
    await expect(partial.locator(".unavailable")).toHaveAttribute(
      "aria-label",
      "Unavailable: Not every launch measured",
    );
    await expect(cards.locator(".still-trading")).toHaveCount(3);
    await expect(page.getByText("N/A")).toHaveCount(0);
    for (const card of await cards.all()) {
      const box = await card.evaluate((node) => {
        const top = node.querySelector(".mobile-creator-top")!;
        const launches = node.querySelector(".mobile-creator-launches")!;
        return {
          height: node.getBoundingClientRect().height,
          fits:
            node.scrollHeight <= node.clientHeight &&
            top.scrollWidth <= top.clientWidth,
          launchesRight: launches.getBoundingClientRect().right,
          topRight: top.getBoundingClientRect().right,
        };
      });
      expect(box.height).toBe(104);
      expect(box.fits, "the row's content fits its box").toBe(true);
      expect(box.launchesRight, "the launch count sits at the right").toBe(
        box.topRight,
      );
    }
    return;
  }
  // The panel reserves its default 25-row shape; only the first five carry
  // this fixture's data, the rest render as empty reserved rows.
  const rowsLocator = panel.locator('tbody tr[data-row="resolved"]');
  await expect(rowsLocator).toHaveCount(5);

  // Head labels: 11.5/400, and no FEES column until phase 4 has the data.
  const head = panel.locator(".data-table th");
  await expect(head).toHaveCount(7);
  await expect(head.first()).toHaveCSS("font-size", "11.5px");
  await expect(head.first()).toHaveCSS("font-weight", "400");
  for (const column of [2, 3, 4, 5, 6])
    await expect(head.nth(column)).toHaveCSS("text-align", "right");

  // Row height, and rank mono 12.5/400 in gold, silver and bronze for 1-3.
  await expect(rowsLocator.first()).toHaveCSS("height", "62px");
  const rank = (n: number) => rowsLocator.nth(n).locator(".rank-number");
  await expect(rank(0)).toHaveCSS("font-size", "12.5px");
  await expect(rank(0)).toHaveCSS("color", "rgb(224, 180, 92)");
  await expect(rank(1)).toHaveCSS("color", "rgb(201, 203, 212)");
  await expect(rank(2)).toHaveCSS("color", "rgb(201, 138, 92)");
  await expect(rank(3)).toHaveCSS("color", "rgb(154, 154, 164)");

  // The creator cell: a 28px monogram, the short address as both the name
  // and the mono address line beneath it (no ENS-style name source exists
  // anywhere in this app), and the BOUGHT OWN chip only where the API says so.
  const firstChip = rowsLocator.first().locator(".address-chip");
  await expect(firstChip.locator(".avatar")).toHaveCSS("width", "28px");
  await expect(firstChip.locator(".avatar")).toHaveCSS("height", "28px");
  await expect(firstChip.locator(".address-chip-name")).toHaveText(goldShort);
  await expect(firstChip.locator(".address-chip-lines .mono")).toHaveText(
    goldShort,
  );
  await expect(firstChip.locator(".address-chip-name")).toHaveCSS(
    "font-size",
    "14px",
  );
  await expect(firstChip.locator(".address-chip-name")).toHaveCSS(
    "font-weight",
    "500",
  );
  await expect(rowsLocator.first().getByText("BOUGHT OWN")).toBeVisible();
  await expect(rowsLocator.nth(1).getByText("BOUGHT OWN")).toHaveCount(0);

  // Launches right-aligned at 14/400.
  const launchesCell = rowsLocator.first().locator("td").nth(2);
  await expect(launchesCell).toHaveText("14");
  await expect(launchesCell).toHaveCSS("text-align", "right");
  await expect(launchesCell).toHaveCSS("font-size", "14px");
  await expect(launchesCell).toHaveCSS(
    "font-variant-numeric",
    "tabular-nums",
  );

  // Still trading: the 132x5 bar plus "traded of measured · pct%" beneath it.
  const stillCell = rowsLocator.first().locator("td").nth(3);
  await expect(stillCell.locator(".still-trading-bar")).toHaveCSS(
    "width",
    "132px",
  );
  await expect(stillCell.locator(".still-trading-bar")).toHaveCSS(
    "height",
    "5px",
  );
  await expect(stillCell.locator(".still-trading-bar > span")).toHaveAttribute(
    "style",
    /width:\s*64%/,
  );
  await expect(stillCell.locator(".still-trading-label")).toHaveText(
    "9 of 14 · 64%",
  );
  await expect(stillCell).toHaveCSS("text-align", "right");
  await expect(stillCell.locator(".still-trading-label")).toHaveCSS(
    "font-variant-numeric",
    "tabular-nums",
  );
  // A creator with no measured launch renders the cell empty, never "N/A".
  const unmeasuredCell = rowsLocator.nth(4).locator("td").nth(3);
  await expect(unmeasuredCell).toHaveText("");
  await expect(unmeasuredCell.locator(".unavailable")).toHaveAttribute(
    "aria-label",
    "Unavailable: No measured launch",
  );
  // So does one whose measured launches are fewer than its launches: the
  // export's fraction is "traded of launches", and "4 of 4" beside a launch
  // count of 21 would read as a survival rate the figures do not support.
  const partialCell = rowsLocator.nth(3).locator("td").nth(3);
  await expect(rowsLocator.nth(3).locator("td").nth(2)).toHaveText("21");
  await expect(partialCell).toHaveText("");
  await expect(partialCell.locator(".still-trading")).toHaveCount(0);
  await expect(partialCell.locator(".unavailable")).toHaveAttribute(
    "aria-label",
    "Unavailable: Not every launch measured",
  );
  await expect(rowsLocator.locator(".still-trading")).toHaveCount(3);
  await expect(page.getByText("N/A")).toHaveCount(0);

  // Volume and median: 14/400 in the secondary numeric colour, right-aligned.
  const volumeCell = rowsLocator.first().locator("td").nth(4);
  await expect(volumeCell).toHaveCSS("font-size", "14px");
  await expect(volumeCell).toHaveCSS("color", "rgb(180, 180, 190)");
  await expect(volumeCell).toHaveCSS("text-align", "right");
  await expect(volumeCell.locator(".number")).toHaveCSS(
    "font-variant-numeric",
    "tabular-nums",
  );

  // Best: the token symbol, mono 12.5/400 muted, linking to the pool.
  const bestCell = rowsLocator.first().locator("td").nth(6);
  const bestLink = bestCell.locator("a");
  await expect(bestLink).toHaveText("ORBIT");
  await expect(bestLink).toHaveCSS("font-size", "12.5px");
  await expect(bestLink).toHaveCSS("color", "rgb(138, 138, 148)");
  await expect(bestCell).toHaveCSS("text-align", "right");
  await expect(bestLink).toHaveAttribute(
    "href",
    poolHref(items[0].bestLaunch!),
  );
});

async function serveCreatorLaunches(
  page: Page,
  launches: AnalyticsPoolRow[],
  reads: { offset: number; limit: number }[] = [],
) {
  await page.route("**/api/product/explore/?**", async (route) => {
    const read = creatorLaunchesPage(launches, route.request().url());
    if (!read) return route.continue();
    reads.push({ offset: read.offset, limit: read.limit });
    await route.fulfill({ json: read.json });
  });
}

test("a creator's unmeasured launches show their identity and launch time with empty figures, under the launch count", async ({
  page,
  isMobile,
}) => {
  const launches = creatorLaunches(10, 4);
  await serveCreatorLaunches(page, launches);
  await page.goto(`/creators/${creatorAddress}/`);
  const panel = page.locator(".creator-launches");
  const rows = panel.locator(
    isMobile
      ? '.mobile-launch[data-row="resolved"]'
      : 'tbody tr[data-row="resolved"]',
  );
  await expect(rows).toHaveCount(10);
  // The page reserves its default 25-row shape from the URL; the rows past
  // this creator's ten stay blank rather than shimmering for nothing.
  await expect(
    panel.locator(isMobile ? ".mobile-launch" : "tbody tr"),
  ).toHaveCount(25);
  await expect(
    panel.locator(
      isMobile
        ? '.mobile-launch[data-row="reserved"]'
        : 'tbody tr[data-row="reserved"]',
    ),
  ).toHaveCount(15);
  await expect(panel.locator(".pagination-count")).toHaveText(
    "Showing 10 of 10",
  );
  await expect(panel.getByRole("button", { name: /^Show/ })).toHaveCount(0);
  // The badge is the count the read names, never a coverage claim.
  await expect(panel.locator(".panel-heading .badge")).toHaveText("10");
  await expect(panel).not.toContainText("covered");
  // No launch waits on a pass that will not come: an unmeasured launch keeps
  // its identity and launch time and leaves its figure cells empty.
  await expect(panel).not.toContainText("Processing");
  await expect(panel).not.toContainText("N/A");
  const measured = rows.first();
  const unmeasured = rows.nth(1);
  await expect(measured.locator("a").first()).toHaveText("Launch 10 (L10)");
  await expect(unmeasured.locator("a").first()).toHaveText("Launch 9 (L9)");
  const utc = (seconds: number) =>
    new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ") +
    " UTC";
  if (isMobile) {
    await expect(measured.locator(".mobile-launch-top .number")).toHaveText(
      "1 ETH",
    );
    await expect(measured.locator(".mobile-launch-stats")).toHaveText(
      `${utc(launches[0].launchedAt)} · No swap observed`,
    );
    await expect(unmeasured.locator(".mobile-launch-top .number")).toHaveText(
      "",
    );
    await expect(unmeasured.locator(".mobile-launch-stats")).toHaveText(
      utc(launches[1].launchedAt),
    );
    return;
  }
  const cells = (row: Locator) => row.locator("td");
  await expect(cells(measured)).toHaveText([
    "Launch 10 (L10)",
    utc(launches[0].launchedAt),
    "No swap observed",
    "1 ETH",
    "",
  ]);
  await expect(cells(unmeasured)).toHaveText([
    "Launch 9 (L9)",
    utc(launches[1].launchedAt),
    "",
    "",
    "",
  ]);
  await expect(
    cells(unmeasured).nth(2).locator(".unavailable"),
    "the empty activity cell still says why",
  ).toHaveAttribute("aria-label", "Unavailable: No measured activity");
});

test("a creator's launches take the shared 25-row Show more, never the whole history at once", async ({
  page,
  isMobile,
}) => {
  const launches = creatorLaunches(60, 3);
  const reads: { offset: number; limit: number }[] = [];
  await serveCreatorLaunches(page, launches, reads);
  await page.goto(`/creators/${creatorAddress}/`);
  const panel = page.locator(".creator-launches");
  const rows = panel.locator(isMobile ? ".mobile-launch" : "tbody tr");
  const resolved = panel.locator(
    isMobile
      ? '.mobile-launch[data-row="resolved"]'
      : 'tbody tr[data-row="resolved"]',
  );
  const footer = panel.locator(".pagination");
  const count = footer.locator(".pagination-count");
  const showMore = footer.getByRole("button", { name: /^Show \d+ more$/ });

  await expect(resolved).toHaveCount(25);
  await expect(rows).toHaveCount(25);
  await expect(panel.locator(".panel-heading .badge")).toHaveText("60");
  await expect(count).toHaveText("Showing 25 of 60");
  await expect(showMore).toHaveText("Show 25 more");
  expect(reads, "one read of the first page").toEqual([
    { offset: 0, limit: 25 },
  ]);
  // Newest first, as the explore launch order serves them.
  await expect(resolved.first().locator("a").first()).toHaveText(
    "Launch 60 (L60)",
  );

  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(rows).toHaveCount(50);
  await expect(resolved).toHaveCount(50);
  await expect(count).toHaveText("Showing 50 of 60");
  expect(reads[1], "the next page is read from where the rows end").toEqual({
    offset: 25,
    limit: 25,
  });
  await expect(
    resolved.nth(25).locator("a").first(),
    "focus lands on the first newly revealed launch",
  ).toBeFocused();

  // The last page asks for what remains, and the control goes with it.
  await expect(showMore).toHaveText("Show 10 more");
  await showMore.click();
  await expect(page).toHaveURL(/[?&]limit=60(?:&|$)/);
  await expect(rows).toHaveCount(60);
  await expect(resolved).toHaveCount(60);
  await expect(count).toHaveText("Showing 60 of 60");
  await expect(showMore).toHaveCount(0);
  expect(reads).toHaveLength(3);

  // A reload restores the same rows from the URL.
  await page.reload();
  await expect(resolved).toHaveCount(60);
  await expect(count).toHaveText("Showing 60 of 60");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the page fits the viewport",
  ).toBe(true);
});
