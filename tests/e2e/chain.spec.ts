import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
test("on-chain markets have isolated real-data provenance, working selection and evidence", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/live/");
  await expect(
    page.getByRole("heading", { name: "On-chain markets." }),
  ).toBeVisible();
  await expect(page.getByText("ON-CHAIN DATA", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Display currency/ }),
  ).toHaveCount(0);
  const pool = chain.markets[1];
  await page
    .getByRole("textbox", { name: "Filter on-chain pools" })
    .fill(pool.token);
  await expect(page.locator(".chain-pool-row")).toHaveCount(1);
  await page.locator(".chain-pool-row").click();
  await expect(page.locator(".chain-detail h3")).toHaveText(pool.name);
  await expect(
    page.getByRole("link", { name: "Launch transaction" }),
  ).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${pool.launchTx}`,
  );
  await expect(
    page.getByRole("heading", { name: `${pool.symbol} swaps` }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Pools", exact: true }).click();
  await expect(page.getByText("DEMO SNAPSHOT", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
