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
  await expect(desktopRows).toHaveCount(25);
  await expect(mobileRows).toHaveCount(25);
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
  await expect(desktopRows).toHaveCount(50);
  await expect(mobileRows).toHaveCount(50);
  await expect(rows.nth(25).locator(".address-chip-link")).toBeFocused();

  // Reload restores the exact shown count from the URL, in one request.
  await page.reload();
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(desktopRows).toHaveCount(50);
  await expect(mobileRows).toHaveCount(50);

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
    await expect(desktopRows).toHaveCount(next);
    await expect(mobileRows).toHaveCount(next);
    await expect(rows.nth(shown).locator(".address-chip-link")).toBeFocused();
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
  await expect(desktopRows).toHaveCount(25);
  await expect(mobileRows).toHaveCount(25);

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
    await route.fulfill({ response, json: { ...json, total: 500 } });
  });

  await page.goto("/traders/?window=All");
  const panel = page.locator("main .leaderboard-panel");
  const pagination = panel.locator(".pagination");
  const count = pagination.locator(".pagination-count");
  const more = pagination.getByRole("button", { name: /^Show \d+ more$/ });

  await expect(count).toHaveText("Showing 25 of 500");
  for (const target of [50, 75, 100]) {
    await more.click();
    await expect(page).toHaveURL(new RegExp(`[?&]limit=${target}(?:&|$)`));
    await expect(count).toHaveText(`Showing ${target.toLocaleString()} of 500`);
  }
  await expect(more).toHaveCount(0);
  expect(
    Math.max(...seenCeilings),
    "no request ever asks for a row past the 100th",
  ).toBeLessThanOrEqual(100);
});
