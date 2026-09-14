import { test, expect } from "@playwright/test";
import raw from "../../data/snapshots/demo.json";
const pool = raw.pools[0];
const wallet = raw.identities[0];

test("snapshot filter survives reload and clears into complete coverage", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Explore pools." }),
  ).toBeVisible();
  await expect(page.getByText("DEMO SNAPSHOT", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Filter pools" }).fill("Orbit");
  await expect(page).toHaveURL(/q=Orbit/);
  await expect(page.getByText("1-1 of 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Filter pools" })).toHaveValue(
    "Orbit",
  );
  await page.getByRole("button", { name: "Clear pool filter" }).click();
  await expect(page.getByText("1-10 of 12", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("11-12 of 12", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("watchlist persists per device and has a useful empty state", async ({
  page,
}) => {
  await page.goto("/?q=Orbit");
  await expect(page.getByRole("textbox", { name: "Filter pools" })).toHaveValue(
    "Orbit",
  );
  await expect(page.getByText("1-1 of 1", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Add to watchlist" })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: /Watchlist/ }).click();
  await expect(page.getByText("1-1 of 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("button", { name: "Remove from watchlist" })
      .filter({ visible: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove from watchlist" })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your watchlist starts here" }),
  ).toBeVisible();
});

test("pool profile links to a wallet, matching position, and downloadable PNG", async ({
  page,
  request,
}) => {
  await page.goto(`/pool/${pool.id}/`);
  await expect(
    page.getByRole("heading", { name: /Orbit ORBIT/ }),
  ).toBeVisible();
  await page.locator(`#trades a[href^="/wallet/"]`).first().click();
  await expect(
    page.getByRole("button", { name: "Share performance" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Share performance" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("img")).toBeVisible();
  const src = await dialog.getByRole("img").getAttribute("src");
  const response = await request.get(src!);
  expect(response.ok()).toBeTruthy();
  const png = await response.body();
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const download = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download PNG" }).click();
  expect((await download).suggestedFilename()).toContain("-demo-pnl.png");
  await dialog.getByRole("button", { name: "Close share card" }).click();
  await page.getByRole("link", { name: "Orbit ORBIT", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/pool/${pool.id}/`));
});

test("grouped search finds exact transaction and filters the trade table", async ({
  page,
}) => {
  const transaction = raw.trades[0];
  await page.goto("/");
  await page.getByRole("button", { name: /Search tokens/ }).click();
  const input = page.getByRole("textbox", {
    name: "Search tokens, wallets, or transaction hashes",
  });
  await input.fill(transaction.txHash);
  await expect(
    page
      .locator("dialog[open]")
      .getByRole("heading", { name: "Transactions", exact: true }),
  ).toBeVisible();
  await page.locator("dialog[open]").getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`tx=${transaction.txHash}`));
  await expect(page.locator("#trades tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.locator("#trades tbody tr")).toHaveCount(12);
});

test("unknown wallet is not presented as zero activity", async ({ page }) => {
  await page.goto("/wallet/");
  await page
    .getByRole("textbox", { name: "Wallet address", exact: true })
    .fill("0x0000000000000000000000000000000000000000");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Outside this snapshot" }),
  ).toBeVisible();
  await expect(
    page.getByText(/does not mean the wallet has no activity/),
  ).toBeVisible();
});

test("currency and time filters update without changing accounting labels", async ({
  page,
}) => {
  await page.goto("/traders/");
  const first = page.locator("tbody tr").first();
  const weekPnl = await first.locator("td").nth(2).textContent();
  await page.getByRole("button", { name: "24H", exact: true }).click();
  await expect(page).toHaveURL(/window=24h/);
  await expect(first.locator("td").nth(2)).not.toHaveText(weekPnl!);
  await page.getByRole("button", { name: /Display currency: ETH/ }).click();
  await expect(first.locator("td").nth(2)).toContainText("$");
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Display currency: USD/ }),
  ).toBeVisible();
});

test("creator launches navigate to pool and methodology explains demo limits", async ({
  page,
}) => {
  await page.goto("/creators/");
  await expect(
    page.getByRole("heading", { name: "Creator profiles." }),
  ).toBeVisible();
  await expect(page.locator(".creator-card")).toHaveCount(4);
  await page.locator(".creator-pool").first().click();
  await expect(
    page.getByRole("heading", { name: "Holder data isn’t in this snapshot" }),
  ).toBeVisible();
  await page
    .locator("footer")
    .getByRole("link", { name: "Methodology" })
    .click();
  await expect(
    page.getByRole("heading", { name: "01. This is a demo snapshot" }),
  ).toBeVisible();
});

test("core routes have no viewport overflow or runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const route of [
    "/",
    "/traders/",
    `/pool/${pool.id}/`,
    `/wallet/${wallet.address}/`,
    "/creators/",
    "/methodology/",
    "/wallet/",
  ]) {
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      route,
    ).toBeTruthy();
  }
  expect(errors).toEqual([]);
});

test("wallet chart follows the selected realization window", async ({
  page,
}) => {
  await page.goto(`/wallet/${wallet.address}/`);
  const week = await page.locator(".chart-readout strong").textContent();
  await page.getByRole("button", { name: "24H", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Cumulative realized PnL 24H" }),
  ).toBeVisible();
  await expect(page.locator(".chart-readout strong")).not.toHaveText(week!);
  await expect(page.locator(".chart-readout strong")).toHaveText(
    (await page.locator(".stat").first().locator("strong").textContent())!,
  );
});
