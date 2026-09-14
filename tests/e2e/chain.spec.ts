import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import {
  poolHref,
  walletHref,
  type PoolAudit,
  type Address,
  type ChainMarket,
} from "@pools/core";
const wallet = "0x1111111111111111111111111111111111111111";
const market = chain.markets[0] as ChainMarket;
function fixture(): PoolAudit {
  const executions = Array.from({ length: 11 }, (_, i) => ({
    trade: {
      id: String(i),
      poolId: market.id as Address,
      trader: wallet as Address,
      txHash: `0x${(i + 1).toString(16).padStart(64, "0")}` as Address,
      logIndex: 0,
      block: market.launchBlock + i + 1,
      timestamp: market.launchedAt + (i === 10 ? 100 : i),
      side: i === 10 ? ("sell" as const) : ("buy" as const),
      ethWei: i === 10 ? "1500000000000000000" : "100000000000000000",
      tokenRaw: i === 10 ? "100000000000000000000" : "10000000000000000000",
    },
    flags: [],
    matchedTransfer: String(i),
  }));
  return {
    poolId: market.id,
    market,
    toBlock: chain.toBlock,
    toTimestamp: chain.toTimestamp,
    generatedAt: chain.generatedAt,
    executions,
    wallets: [
      {
        address: wallet,
        swaps: 11,
        buys: 10,
        sells: 1,
        volumeWei: "2500000000000000000",
        realizedWei: "500000000000000000",
        inventoryRaw: "0",
        balanceRaw: "0",
        balanceMatches: true,
        eligible: true,
        flags: [],
        evidenceTx: market.launchTx,
      },
    ],
    unattributedSwaps: 0,
    transfersChecked: 11,
  };
}
test.beforeEach(async ({ page }) => {
  await page.route("**/api/markets/", (r) =>
    r.fulfill({ status: 503, json: { error: "disabled" } }),
  );
});
test("real screener keeps watchlists, filters, pool navigation and the legacy live link", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/live/");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Explore pools." }),
  ).toBeVisible();
  await expect(page.getByText("ON-CHAIN DATA", { exact: true })).toBeVisible();
  await expect(page.getByText("DEMO SNAPSHOT", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Filter pools" }).fill(market.token);
  await expect(
    page
      .getByRole("button", { name: "Add to watchlist" })
      .filter({ visible: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Add to watchlist" })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "Watchlist", exact: true }).click();
  await page.reload();
  await expect(
    page
      .getByRole("button", { name: "Remove from watchlist" })
      .filter({ visible: true }),
  ).toBeVisible();
  await page.goto(poolHref(market));
  await expect(
    page.getByRole("heading", { name: market.name + "." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Launch transaction" }),
  ).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${market.launchTx}`,
  );
  await page.getByRole("button", { name: "Holders", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Holder balances are not collected yet",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("refresh failure retains data and recovers, with pause stopping automatic requests", async ({
  page,
}) => {
  let calls = 0;
  const updated = structuredClone(chain);
  updated.generatedAt = new Date().toISOString();
  updated.toTimestamp = Math.floor(Date.now() / 1000);
  updated.toBlock += 100;
  updated.markets[0].name = "Updated real token";
  await page.clock.install();
  await page.route("**/api/markets/", async (r) => {
    calls++;
    await r.fulfill(
      calls === 1
        ? { status: 503, json: { error: "unavailable" } }
        : { json: updated },
    );
  });
  await page.goto("/");
  await expect(
    page.getByText("Updates delayed - showing last captured data", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(
    page.getByText("Automatic updates active", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Updated real token", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pause updates", exact: true })
    .click();
  const before = calls;
  await page.clock.fastForward(65000);
  expect(calls).toBe(before);
});
test("audited leaderboard links to real wallet metrics and scoped share cards, retaining audit on failure", async ({
  page,
}) => {
  let calls = 0;
  await page.route(`**/api/markets/${market.id}/accounting/**`, async (r) => {
    calls++;
    await r.fulfill(
      calls === 1
        ? { json: fixture() }
        : { status: 503, json: { error: "unavailable" } },
    );
  });
  await page.goto(`/traders/?pool=${market.id}&launch=${market.launchTx}`);
  await page
    .getByRole("button", { name: /^(Audit traders|Refresh audit)$/ })
    .click();
  await expect(
    page.getByRole("link", { name: "0x1111…1111", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByLabel("Minimum swaps")
    .filter({ visible: true })
    .selectOption("25");
  await expect(
    page.getByRole("heading", {
      name: "No qualifying traders in this pool and window",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Minimum swaps")
    .filter({ visible: true })
    .selectOption("10");
  await page
    .getByRole("button", { name: "Refresh audit", exact: true })
    .click();
  await expect(
    page.getByText(/The previous audit remains visible/),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "0x1111…1111", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "0x1111…1111." }),
  ).toBeVisible();
  await expect(
    page.getByText("+0.5 ETH", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Observed trade history" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Generate share card", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Download PNG" }),
  ).toHaveAttribute(
    "href",
    new RegExp(`/cards/${wallet}.png\\?pool=${market.id}`),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("creator routes, arbitrary wallet lookup and typed global search remain usable", async ({
  page,
}) => {
  await page.goto("/creators/");
  await expect(page.getByRole("heading", { name: "Creators." })).toBeVisible();
  await page
    .getByRole("link", {
      name:
        market.launchSender.slice(0, 6) + "…" + market.launchSender.slice(-4),
      exact: true,
    })
    .first()
    .click();
  await expect(page).toHaveURL(/\/creators\/0x/);
  await page.goto("/wallet/");
  await page.getByLabel("Wallet address", { exact: true }).fill(wallet);
  await page.getByRole("button", { name: "Open wallet profile" }).click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${wallet}/`));
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const input = page.getByRole("textbox", {
    name: "Search tokens, wallets, creators, or transaction hashes",
  });
  await input.fill(market.token);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("link", { name: new RegExp(market.symbol) }),
  ).toBeVisible();
  await input.fill("example.eth");
  await expect(page.getByText(/ENS name detected/)).toBeVisible();
  await input.fill(chain.trades[0].txHash);
  await expect(page.getByRole("dialog").getByRole("link")).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${chain.trades[0].txHash}`,
  );
  await page.keyboard.press("Escape");
  await page.goto("/methodology/");
  await expect(
    page.getByRole("heading", { name: "Behind the numbers." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("server-generated card uses captured RPC audit data and returns a 1200 by 630 PNG", async ({
  request,
}) => {
  const m = chain.markets.find(
    (m) => m.accounting?.executions?.length && m.accounting.wallets.length,
  )!;
  const address = m.accounting!.wallets[0].address;
  const response = await request.get(
    `/cards/${address}.png?pool=${m.id}&launch=${m.launchTx}&window=All`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const image = await response.body();
  expect(image.readUInt32BE(16)).toBe(1200);
  expect(image.readUInt32BE(20)).toBe(630);
  expect((await request.get("/cards/not-an-address.png")).status()).toBe(404);
  expect(
    (await request.get(`/cards/${address}.png?realized=999999`)).status(),
  ).toBe(400);
  expect((await request.get(walletHref(address, m))).status()).toBe(200);
});

test("direct pool links hydrate their candle charts without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const pool of chain.markets) {
    await page.goto(poolHref(pool));
    await page.getByRole("button", { name: "6h", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "6h", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(errors, `Hydration errors for ${pool.symbol}`).toEqual([]);
  }
});
