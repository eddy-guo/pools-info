import { test, expect } from "@playwright/test";

const wallet = "0x1111111111111111111111111111111111111111";

test("wallet follows persist locally and can be removed from the wallet directory", async ({
  page,
}, testInfo) => {
  await page.goto(`/wallet/${wallet}/`);
  const follow = page.getByRole("button", {
    name: "Follow wallet",
    exact: true,
  });
  await expect(follow).toBeEnabled();
  await follow.click();
  await expect(
    page.getByRole("button", { name: "Following", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Following", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .locator(".page-heading")
    .filter({ visible: true })
    .screenshot({ path: testInfo.outputPath("wallet-follow-action.png") });
  await page.goto("/wallet/");
  const directory = page.getByRole("region", { name: "Followed wallets" });
  await expect(directory.getByRole("link")).toHaveAttribute(
    "href",
    `/wallet/${wallet}/`,
  );
  await directory.screenshot({
    path: testInfo.outputPath("followed-wallets.png"),
  });
  await directory.getByRole("button", { name: `Unfollow ${wallet}` }).click();
  await expect(directory).toHaveCount(0);
  await page.goto(`/wallet/${wallet}/`);
  await expect(
    page.getByRole("button", { name: "Follow wallet", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("following updates across browser tabs without a reload", async ({
  page,
  context,
}) => {
  await page.goto(`/wallet/${wallet}/`);
  const directoryPage = await context.newPage();
  await directoryPage.goto("/wallet/");
  await page
    .getByRole("button", { name: "Follow wallet", exact: true })
    .click();
  const directory = directoryPage.getByRole("region", {
    name: "Followed wallets",
  });
  await expect(directory.getByRole("link")).toHaveAttribute(
    "href",
    `/wallet/${wallet}/`,
  );
  await directory.getByRole("button", { name: `Unfollow ${wallet}` }).click();
  await expect(
    page.getByRole("button", { name: "Follow wallet", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await directoryPage.close();
});

test("the Following tab has no one to show until a trader is followed", async ({
  page,
}) => {
  await page.goto("/traders/?view=following");
  await expect(
    page.getByRole("button", { name: "Following", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "You are not following anyone yet" }),
  ).toBeVisible();
});

test("following a trader from a leaderboard row surfaces it on the Following tab, and unfollowing there removes it", async ({
  page,
  request,
}, testInfo) => {
  const payload = await (
    await request.get("/api/product/leaderboard/?window=7d")
  ).json();
  const address: string = payload.items[0].address;

  await page.goto("/traders/");
  const follow = page.getByRole("button", { name: `Follow ${address}` });
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await follow.hover();
  await follow.click();
  const unfollow = page.getByRole("button", {
    name: `Unfollow ${address}`,
  });
  await expect(unfollow).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Following", exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=following(?:&|$)/);
  const link = page
    .locator(`a[href="/wallet/${address}/?window=7d"]`)
    .filter({ visible: true });
  await expect(link).toBeVisible();
  await page
    .locator(".leaderboard-panel")
    .screenshot({ path: testInfo.outputPath("traders-following-tab.png") });

  await page.getByRole("button", { name: `Unfollow ${address}` }).click();
  await expect(link).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "You are not following anyone yet" }),
  ).toBeVisible();
});

test("the Following tab survives reload and restores after Back", async ({
  page,
}) => {
  await page.goto(`/wallet/${wallet}/`);
  await page
    .getByRole("button", { name: "Follow wallet", exact: true })
    .click();
  await page.goto("/traders/");
  await page.getByRole("button", { name: "Following", exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=following(?:&|$)/);
  const link = page
    .locator(`a[href="/wallet/${wallet}/?window=7d"]`)
    .filter({ visible: true });
  await expect(link).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Following", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(link).toBeVisible();

  await link.click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${wallet}/`));
  await page.goBack();
  await expect(page).toHaveURL(/[?&]view=following(?:&|$)/);
  await expect(
    page.getByRole("button", { name: "Following", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
