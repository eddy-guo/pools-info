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
