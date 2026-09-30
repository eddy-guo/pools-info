import { expect, test, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";

async function openLegacyAudit(page: Page) {
  const market = chain.markets[0];
  await page.route("**/api/markets/", (r) =>
    r.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route(`**/api/markets/${market.id}/accounting/**`, (r) =>
    r.fulfill({
      json: {
        poolId: market.id,
        market,
        toBlock: chain.toBlock,
        toTimestamp: chain.toTimestamp,
        generatedAt: chain.generatedAt,
        executions: [],
        wallets: [],
        unattributedSwaps: 0,
        transfersChecked: 0,
      },
    }),
  );
  await page.goto(`/traders/?pool=${market.id}&launch=${market.launchTx}`);
  await page.getByRole("button", { name: "Audit traders" }).click();
}

const lime = "rgb(187, 244, 81)";

test("wallet lookup shows a lime keyboard focus ring without resizing", async ({
  page,
}) => {
  await page.goto("/wallet/");
  const input = page.getByRole("textbox", { name: "Wallet address" });
  const size = await input.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS("outline-style", "solid");
  await expect(input).toHaveCSS("outline-width", "2px");
  await expect(input).toHaveCSS("outline-color", lime);
  await expect(input).toHaveCSS("border-color", lime);
  expect(
    await input.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  ).toEqual(size);
});

test("Cmd-K search shows a lime focus border without resizing", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+K");
  const input = page.getByRole("dialog").getByRole("textbox");
  const head = page.locator(".search-dialog-head");
  await expect(input).toBeFocused();
  await input.evaluate((element) => (element as HTMLInputElement).blur());
  const size = await head.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  await input.focus();
  await expect(input).toBeFocused();
  await expect(head).toHaveCSS("border-bottom-color", lime);
  await expect(head).toHaveCSS(
    "box-shadow",
    `rgb(187, 244, 81) 0px -1px 0px 0px inset`,
  );
  expect(
    await head.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  ).toEqual(size);
});

test("legacy trader filter checkbox shows a lime keyboard focus ring without resizing", async ({
  page,
}) => {
  await openLegacyAudit(page);
  const checkbox = page.locator('.live-filters input[type="checkbox"]').first();
  await expect(checkbox).toBeVisible();
  const size = await checkbox.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  await checkbox.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(checkbox).toBeFocused();
  await expect(checkbox).toHaveCSS("outline-style", "solid");
  await expect(checkbox).toHaveCSS("outline-width", "2px");
  await expect(checkbox).toHaveCSS("outline-color", lime);
  expect(
    await checkbox.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  ).toEqual(size);
});
