import { test, expect } from "@playwright/test";

// Copy the captain removed from the leaderboard header; it must not come back.
const removedCopy = [
  "Follow the wallets. Understand the performance.",
  "Look up your wallet",
  "Connect to see your rank",
  "Wallet profiles are public. Personal ranking is coming later.",
  "View my rank",
  "with saved analytics",
  "Latest captured data",
  "Coverage and methodology",
  "Ranked before pagination",
  "Minimum swaps",
];

test("the trader leaderboard header holds only the title and its ranking controls", async ({
  page,
}) => {
  await page.goto("/traders/");
  const main = page.locator("main");
  const panel = main.locator(".leaderboard-panel");
  await expect(panel).toBeVisible();
  for (const copy of removedCopy)
    await expect(main.getByText(copy), copy).toHaveCount(0);
  await expect(main.getByLabel("Minimum swaps")).toHaveCount(0);
  await expect(main.locator(".personal-rank")).toHaveCount(0);
  const viewport = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(box.y, "the leaderboard begins within the first screen").toBeLessThan(
    viewport.height,
  );
  expect(new URL(page.url()).searchParams.has("minTrades")).toBe(false);

  const metric = main.getByRole("button", { name: "Net ETH", exact: true });
  await metric.click();
  await expect(metric).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]metric=net(?:&|$)/);

  const window = main.getByRole("button", { name: "30d", exact: true });
  await window.click();
  await expect(window).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]window=30d(?:&|$)/);
  await expect(page).toHaveURL(/[?&]metric=net(?:&|$)/);
  expect(new URL(page.url()).searchParams.has("minTrades")).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the header controls fit the viewport",
  ).toBe(true);
});

// The podium always holds ranks 1-3, so the flat list's own row count runs
// three behind the "shown" total the pagination count and URL track.
const LIST_OFFSET = 3;

test("the trader leaderboard grows with a Show more button and a running Gmail-style count", async ({
  page,
  request,
}) => {
  const total: number = (
    await (
      await request.get("/api/product/leaderboard/?window=All&limit=100")
    ).json()
  ).total;
  expect(
    total,
    "the saved fixture ranks enough wallets to grow past one click",
  ).toBeGreaterThan(50);

  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { clickMeasurement: state });
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

  await page.goto("/traders/?window=All");
  const panel = page.locator("main .leaderboard-panel");
  const pagination = panel.locator(".pagination");
  const count = pagination.locator(".pagination-count");
  const more = pagination.getByRole("button", { name: /^Show \d+ more$/ });
  const desktopRows = panel.locator(".desktop-traders tbody tr");
  const mobileRows = panel.locator(".mobile-trader");
  const isDesktop = await panel.locator(".desktop-traders").isVisible();
  const rows = isDesktop ? desktopRows : mobileRows;

  await expect(count).toHaveText(`Showing 25 of ${total.toLocaleString()}`);
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  await expect(desktopRows).toHaveCount(25 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(25 - LIST_OFFSET);
  await expect(more).toBeVisible();

  // First click: the next 25, the URL, the running count, the reserved row
  // area, and focus landing on the first row that was not there before.
  await more.click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  const shown50 = Math.min(50, total);
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(desktopRows).toHaveCount(shown50 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(shown50 - LIST_OFFSET);
  await expect(
    rows.nth(25 - LIST_OFFSET).locator(".address-chip-link"),
  ).toBeFocused();

  // Reload restores the exact shown count from the URL, in one request.
  await page.reload();
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(desktopRows).toHaveCount(shown50 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(shown50 - LIST_OFFSET);

  // Back, after navigating away, restores the same state too.
  await rows.first().locator(".address-chip-link").click();
  await expect(page).toHaveURL(/\/wallet\//);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );

  // Click through to the fixture's real ceiling: the button disappears once
  // nothing more remains, never past it, and every step keeps the layout
  // shift the button's appearing and disappearing would otherwise cause at 0.
  let shown = shown50;
  while (shown < Math.min(total, 100) && (await more.count())) {
    const next = Math.min(shown + 25, total, 100);
    await more.click();
    await expect(page).toHaveURL(new RegExp(`[?&]limit=${next}(?:&|$)`));
    await expect(count).toHaveText(
      `Showing ${next.toLocaleString()} of ${total.toLocaleString()}`,
    );
    await expect(desktopRows).toHaveCount(next - LIST_OFFSET);
    await expect(mobileRows).toHaveCount(next - LIST_OFFSET);
    await expect(
      rows.nth(shown - LIST_OFFSET).locator(".address-chip-link"),
    ).toBeFocused();
    shown = next;
  }
  if (total <= 100) await expect(more).toHaveCount(0);
  else await expect(more).toBeVisible();

  // Reload restores the exhausted state too: the same count, no button back.
  await page.reload();
  await expect(count).toHaveText(
    `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`,
  );
  if (total <= 100) await expect(more).toHaveCount(0);
  else await expect(more).toBeVisible();

  // A metric change is a fresh list: it resets the shown count to 25.
  const metric = page
    .locator("main")
    .getByRole("button", { name: "Net ETH", exact: true });
  await metric.click();
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(count).toHaveText(`Showing 25 of ${total.toLocaleString()}`);
  await expect(desktopRows).toHaveCount(25 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(25 - LIST_OFFSET);

  const measurement = await page.evaluate(
    () =>
      (window as unknown as { clickMeasurement: { cls: number } })
        .clickMeasurement,
  );
  expect(
    measurement.cls,
    "every non-input layout shift across the whole flow",
  ).toBe(0);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the show-more bar fits the viewport",
  ).toBe(true);
});

// The count line reads the same top-100 ceiling the button stops at, never
// the API's raw total (sweep s6 defect 12: "Showing 100 of 1,405" with no
// button and no way to reach the rest).
test("the trader leaderboard never requests past its 100-row cap, even when more exist", async ({
  page,
}) => {
  const seenCeilings: number[] = [];
  await page.route("**/api/product/leaderboard/**", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 0);
    seenCeilings.push(offset + limit);
    await route.fulfill({ response, json: { ...json, total: 1405 } });
  });

  await page.goto("/traders/?window=All");
  const panel = page.locator("main .leaderboard-panel");
  const pagination = panel.locator(".pagination");
  const count = pagination.locator(".pagination-count");
  const more = pagination.getByRole("button", { name: /^Show \d+ more$/ });

  await expect(count).toHaveText("Showing 25 of 100");
  await expect(count).not.toContainText("1,405");
  for (const target of [50, 75, 100]) {
    await more.click();
    await expect(page).toHaveURL(new RegExp(`[?&]limit=${target}(?:&|$)`));
    await expect(count).toHaveText(`Showing ${target.toLocaleString()} of 100`);
  }
  await expect(more).toHaveCount(0);
  await expect(count, "the count and the button agree on where the list ends")
    .toHaveText("Showing 100 of 100");
  expect(
    Math.max(...seenCeilings),
    "no request ever asks for a row past the 100th",
  ).toBeLessThanOrEqual(100);
});

// The export's "YOU · RANK N" row above the podium: a quiet prompt until this
// browser marks a wallet as its own, then the wallet read's real rank. Both
// states hold the same height, so the panel below never moves.
const topWallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

async function settled(page: import("@playwright/test").Page) {
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}

test("without a wallet the leaderboard's you row is the quiet prompt", async ({
  page,
}) => {
  await page.goto("/traders/?window=All");
  await settled(page);
  const row = page.locator(".my-rank");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("href", "/wallet/");
  await expect(row.locator(".my-rank-chip")).toHaveText("YOU");
  await expect(row.locator(".my-rank-summary")).toHaveText(
    "Mark your wallet on its page to see your rank here",
  );
  await expect(row.locator(".my-rank-link")).toHaveText("Find your wallet →");
  await expect(row, "no rank is invented").not.toContainText(/RANK|\d/);
  await expect(row.locator(".my-rank-empty")).toHaveCount(1);
  await expect(row.locator(".avatar")).toHaveCount(0);
});

test("with a wallet marked as mine the you row reads its real rank", async ({
  page,
}, testInfo) => {
  await page.goto("/traders/?window=All");
  await settled(page);
  const row = page.locator(".my-rank");
  const panel = page.locator(".leaderboard-panel");
  const prompt = (await row.boundingBox())!;
  const panelTop = (await panel.boundingBox())!.y;
  await page.evaluate((address) => {
    localStorage.setItem("poolsinfo.my-wallet.v1", address);
    window.dispatchEvent(new Event("poolsinfo-my-wallet-changed"));
  }, topWallet);
  await settled(page);
  await expect(row).toHaveAttribute("href", `/wallet/${topWallet}/?window=All`);
  await expect(row.locator(".my-rank-address")).toHaveText("0x4745…bce1");
  await expect(row.locator(".my-rank-chip")).toHaveText("YOU · RANK 1");
  await expect(row.locator(".my-rank-summary")).toHaveText(
    "realized +0.0114711 ETH across 11 trades",
  );
  await expect(row.locator(".my-rank-summary .positive")).toHaveCSS(
    "color",
    "rgb(63, 214, 140)",
  );
  await expect(row.locator(".my-rank-link")).toHaveText("Your wallet →");
  expect(
    (await row.boundingBox())!.height,
    "the ranked row holds the prompt's height",
  ).toBe(prompt.height);
  expect(
    (await panel.boundingBox())!.y,
    "the leaderboard keeps its position",
  ).toBe(panelTop);
  expect(prompt.height).toBe(testInfo.project.name === "mobile" ? 84 : 54);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${topWallet}/`));
  await expect(page.locator(".page-heading h1")).toHaveText("Portfolio");
});

// The server paints the prompt and hydration swaps in the stored wallet, then
// its read resolves: neither step may move anything on screen.
test("a stored wallet's you row resolves with no layout shift", async ({
  page,
}) => {
  await page.addInitScript((address) => {
    localStorage.setItem("poolsinfo.my-wallet.v1", address);
    const state = { cls: 0 };
    Object.assign(window, { layoutMeasurement: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, topWallet);
  await page.goto("/traders/?window=7d");
  await settled(page);
  const row = page.locator(".my-rank");
  await expect(row.locator(".my-rank-chip")).toHaveText("YOU · RANK 1");
  await expect(row).toHaveAttribute("href", `/wallet/${topWallet}/?window=7d`);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { layoutMeasurement: { cls: number } })
          .layoutMeasurement.cls,
    ),
    "every non-input layout shift since navigation",
  ).toBe(0);
});
