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
  await expect(first).toHaveCSS("outline-color", "rgb(187, 244, 81)");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(busy).toHaveCount(0);
});

test("the search dialog matches the export's shape and colours, with no category chip row", async ({
  page,
}) => {
  await page.goto("/");
  const dialog = page.locator("dialog.search-dialog");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("border-top-left-radius", "18px");
  await expect(dialog).toHaveCSS("background-color", "rgb(13, 13, 16)");
  await expect(dialog).toHaveCSS("border-top-color", "rgb(38, 38, 46)");
  await expect(page.locator(".search-categories")).toHaveCount(0);
  const footer = dialog.locator(".search-dialog-footer");
  await expect(footer).toBeVisible();
  await expect(footer).toContainText(/navigate/i);
  await expect(footer).toContainText(/open/i);
  await expect(footer).toContainText(/close/i);
  const footerBox = (await footer.boundingBox())!;
  expect(footerBox.height).toBeGreaterThanOrEqual(30);
  expect(footerBox.height).toBeLessThanOrEqual(42);
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  if (viewport.width >= 768) {
    expect(box.width).toBeGreaterThanOrEqual(610);
    expect(box.width).toBeLessThanOrEqual(630);
    expect(box.y).toBeGreaterThanOrEqual(80);
    expect(box.y).toBeLessThanOrEqual(100);
  } else {
    expect(box.width).toBeGreaterThan(viewport.width - 50);
  }
  await dialog.getByRole("textbox").fill(chain.markets[0].symbol);
  const first = dialog.locator(".search-result").first();
  await expect(first).toBeVisible();
  const rowBox = (await first.boundingBox())!;
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  expect(rowBox.height).toBeLessThanOrEqual(53);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the search head shows the query-type hint and the skeleton row matches the real row height", async ({
  page,
}) => {
  let release: () => void = () => {};
  await page.route("**/api/product/search/?**", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        entries: [],
        total: 0,
        kind: "text",
        coverage: { scope: "indexed", pools: 0, fromBlock: 0, toBlock: 0 },
      },
    });
  });
  await page.goto("/");
  const dialog = page.locator("dialog.search-dialog");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  await dialog.getByRole("textbox").fill("qqzz-no-local-match-9012");
  const skeletonRow = dialog.locator('[data-skeleton="search"] > div').first();
  await expect(skeletonRow).toBeVisible();
  const skeletonBox = (await skeletonRow.boundingBox())!;
  expect(skeletonBox.height).toBeGreaterThanOrEqual(47);
  expect(skeletonBox.height).toBeLessThanOrEqual(55);
  await expect(dialog.locator(".search-kind-hint")).toHaveText("name");
  release();
});
