import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";

test("automatic refresh recovers from failure, preserves selection, and pauses requests", async ({
  page,
}) => {
  let calls = 0;
  const updated = structuredClone(chain);
  updated.generatedAt = new Date().toISOString();
  updated.toTimestamp = Math.floor(Date.now() / 1000);
  updated.toBlock += 100;
  updated.markets[0].name = "Updated on-chain token";
  await page.clock.install();
  await page.route("**/api/markets/", async (route) => {
    calls++;
    await route.fulfill(
      calls === 1
        ? { status: 503, json: { error: "source_unavailable" } }
        : { json: updated },
    );
  });
  await page.goto("/live/");
  await expect(
    page.getByText("Updates delayed - showing last captured data", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".chain-pool-row")).toHaveCount(
    chain.markets.length,
  );
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(
    page.getByText("Automatic updates active", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chain-detail h3")).toHaveText(
    "Updated on-chain token",
  );
  await page
    .getByRole("button", { name: "Pause updates", exact: true })
    .click();
  await expect(page.getByText("Updates paused", { exact: true })).toBeVisible();
  const before = calls;
  await page.clock.fastForward(65000);
  expect(calls).toBe(before);
});

test("trader audit shows exclusions and retains the last audit after an update fails", async ({
  page,
}) => {
  const market = chain.markets[0];
  let calls = 0;
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route(`**/api/markets/${market.id}/accounting/`, async (route) => {
    calls++;
    await route.fulfill(
      calls > 1
        ? { status: 503, json: { error: "audit_unavailable" } }
        : {
            json: {
              poolId: market.id,
              toBlock: chain.toBlock,
              toTimestamp: chain.toTimestamp,
              transfersChecked: 22,
              unattributedSwaps: 1,
              wallets: [
                {
                  address: "0x1111111111111111111111111111111111111111",
                  swaps: 11,
                  buys: 10,
                  sells: 1,
                  volumeWei: "2000000000000000000",
                  realizedWei: "300000000000000000",
                  inventoryRaw: "10",
                  balanceRaw: "10",
                  balanceMatches: true,
                  eligible: true,
                  flags: [],
                  evidenceTx: market.launchTx,
                },
                {
                  address: "0x2222222222222222222222222222222222222222",
                  swaps: 4,
                  buys: 3,
                  sells: 1,
                  volumeWei: "1000000000000000000",
                  realizedWei: null,
                  inventoryRaw: "10",
                  balanceRaw: "12",
                  balanceMatches: true,
                  eligible: false,
                  flags: ["unmatched_transfer"],
                  evidenceTx: market.launchTx,
                },
              ],
            },
          },
    );
  });
  await page.goto("/live/");
  await page.locator(".chain-audit .panel-heading button").click();
  await expect(page.locator(".chain-audit tbody tr")).toHaveCount(2);
  await expect(
    page.locator(".chain-audit").getByText("Excluded", { exact: true }),
  ).toBeVisible();
  await page.getByText("Why excluded", { exact: true }).click();
  await expect(
    page.getByText("Transfer with unknown cost or destination basis", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Only complete positions with 10+ swaps" })
    .check();
  await expect(page.locator(".chain-audit tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Refresh audit", exact: true })
    .click();
  await expect(
    page.getByText(/The previous audit remains visible/),
  ).toBeVisible();
  await expect(page.locator(".chain-audit tbody tr")).toHaveCount(1);
});
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
