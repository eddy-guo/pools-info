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
