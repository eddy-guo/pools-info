import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";

test("search stays idle while closed and ArrowDown shows an accent focus ring", async ({
  page,
}) => {
  await page.goto("/");
  const dialog = page.locator("dialog.search-dialog"),
    busy = page.locator('[aria-busy="true"]');
  await expect(dialog).toBeHidden();
  await expect(busy).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  await dialog.getByRole("textbox").fill(chain.markets[0].symbol);
  const first = dialog.locator(".search-result").first();
  await expect(first).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(first).toBeFocused();
  await expect(first).toHaveCSS("outline-style", "solid");
  await expect(first).toHaveCSS("outline-color", "rgb(252, 114, 255)");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(busy).toHaveCount(0);
});
