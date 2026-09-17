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

test("the trader leaderboard paginates classically, with a page-size choice and Gmail-style count", async ({
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
    "the saved fixture ranks enough wallets for a partial page at size 50",
  ).toBeGreaterThan(50);

  await page.goto("/traders/?window=All");
  const panel = page.locator("main .leaderboard-panel");
  const pagination = panel.locator(".pagination");
  const count = pagination.locator(".pagination-count");
  const size = (n: number) =>
    pagination.getByRole("button", { name: String(n), exact: true });
  const previous = pagination.getByRole("button", { name: "Previous" });
  const next = pagination.getByRole("button", { name: "Next" });
  const desktopRows = panel.locator(".desktop-traders tbody tr");
  const mobileRows = panel.locator(".mobile-trader");

  await expect(size(25)).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText(`1-25 of ${total.toLocaleString()}`);
  await expect(previous).toBeDisabled();
  await expect(desktopRows).toHaveCount(25);
  await expect(mobileRows).toHaveCount(25);

  // Size 50: URL, Gmail-style count, and the row area reserved for a full page.
  await size(50).click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  await expect(size(50)).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText(`1-50 of ${total.toLocaleString()}`);
  await expect(desktopRows).toHaveCount(50);
  await expect(mobileRows).toHaveCount(50);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  // Next moves one page of 50; the fixture's total lands on its final page here.
  await next.click();
  await expect(page).toHaveURL(/[?&]offset=50(?:&|$)/);
  const size50End = Math.min(100, total);
  await expect(count).toHaveText(
    `51-${size50End.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(previous).toBeEnabled();
  const morePastFifty = total > 100;
  if (morePastFifty) await expect(next).toBeEnabled();
  else await expect(next).toBeDisabled();

  // Reload restores the exact page and size from the URL.
  await page.reload();
  await expect(size(50)).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText(
    `51-${size50End.toLocaleString()} of ${total.toLocaleString()}`,
  );

  // Back, after navigating away, restores the same state too.
  const isDesktop = await panel.locator(".desktop-traders").isVisible();
  const firstWalletLink = (isDesktop ? desktopRows : mobileRows)
    .first()
    .locator(".address-chip-link");
  await firstWalletLink.click();
  await expect(page).toHaveURL(/\/wallet\//);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page).toHaveURL(/[?&]offset=50(?:&|$)/);
  await expect(size(50)).toHaveAttribute("aria-pressed", "true");

  // Size 100: URL, count, row area, and the single-page edges it produces here.
  await size(100).click();
  await expect(page).toHaveURL(/[?&]limit=100(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  await expect(size(100)).toHaveAttribute("aria-pressed", "true");
  const size100End = Math.min(100, total);
  await expect(count).toHaveText(
    `1-${size100End.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(desktopRows).toHaveCount(100);
  await expect(mobileRows).toHaveCount(100);
  await expect(previous).toBeDisabled();
  const morePastHundred = total > 100;
  if (morePastHundred) await expect(next).toBeEnabled();
  else await expect(next).toBeDisabled();

  await page.reload();
  await expect(size(100)).toHaveAttribute("aria-pressed", "true");
  await expect(count).toHaveText(
    `1-${size100End.toLocaleString()} of ${total.toLocaleString()}`,
  );

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the pagination bar fits the viewport",
  ).toBe(true);
});
