import { test, expect, type Page } from "@playwright/test";

/*
 * The wallet's activity tabs follow the WAI-ARIA tabs pattern with manual
 * activation: the arrow keys and Home/End only move focus, so arrowing past
 * Trades never starts its billed explorer read, and Enter selects.
 */

const axePath = require.resolve("axe-core/axe.min.js", {
  paths: [require.resolve("@playwright/test")],
});
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

async function axeViolations(page: Page, selector: string) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async (selector) => {
    const axe = (
      window as Window & {
        axe: {
          run: (
            context: Element,
          ) => Promise<{ violations: { id: string; nodes: unknown[] }[] }>;
        };
      }
    ).axe;
    const result = await axe.run(document.querySelector(selector)!);
    return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
  }, selector);
}

async function expectSelected(page: Page, name: string) {
  const tablist = page.getByRole("tablist", { name: "Wallet activity" });
  const selected = tablist.getByRole("tab", { selected: true });
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAccessibleName(new RegExp(`^${name}`));
  // Only the selected tab is in the Tab sequence.
  await expect(tablist.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(selected).toHaveAttribute("tabindex", "0");
  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAccessibleName(new RegExp(`^${name}`));
  const panelId = await panel.getAttribute("id");
  for (const tab of await tablist.getByRole("tab").all())
    await expect(tab).toHaveAttribute("aria-controls", panelId!);
}

async function expectFocused(page: Page, name: string) {
  await expect(page.locator(":focus")).toHaveAttribute("role", "tab");
  await expect(page.locator(":focus")).toHaveAccessibleName(
    new RegExp(`^${name}`),
  );
}

test("the wallet's activity tabs are one tablist over a labelled panel", async ({
  page,
}) => {
  await page.goto(`/wallet/${wallet}/`);
  await expect(
    page.locator(".wallet-activity [data-row='resolved']").first(),
  ).toBeAttached();
  await expectSelected(page, "Positions");
  expect(await axeViolations(page, ".wallet-activity")).toEqual([]);

  await page.getByRole("tab", { name: /^Launches/ }).click();
  await expectSelected(page, "Launches");
  expect(await axeViolations(page, ".wallet-activity")).toEqual([]);
});

test("the arrow keys walk the wallet's tabs and Enter selects", async ({
  page,
}) => {
  const historyReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/history/")) historyReads.push(request.url());
  });
  await page.goto(`/wallet/${wallet}/`);
  await expectSelected(page, "Positions");
  await page.getByRole("tab", { name: /^Positions/ }).focus();

  await page.keyboard.press("ArrowRight");
  await expectFocused(page, "Trades");
  await page.keyboard.press("ArrowRight");
  await expectFocused(page, "Launches");
  await page.keyboard.press("ArrowRight");
  await expectFocused(page, "Positions");
  await page.keyboard.press("ArrowLeft");
  await expectFocused(page, "Launches");
  await page.keyboard.press("Home");
  await expectFocused(page, "Positions");
  await page.keyboard.press("End");
  await expectFocused(page, "Launches");

  // Moving focus selects nothing: no tab in the URL and no explorer read.
  await expectSelected(page, "Positions");
  expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
  expect(historyReads).toEqual([]);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]tab=launches/);
  await expectSelected(page, "Launches");
  await expectFocused(page, "Launches");

  // Tab leaves the tablist from the selected tab rather than stepping
  // through the others.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expectFocused(page, "Launches");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).not.toHaveAttribute("role", "tab");
});
