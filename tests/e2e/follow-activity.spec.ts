import { test, expect } from "@playwright/test";
import type { FollowingActivityResponse } from "@pools/core";
const wallet = `0x${"1".repeat(40)}`;
const token = `0x${"2".repeat(40)}`;
const poolId = `0x${"3".repeat(64)}`;
const txHash = `0x${"4".repeat(64)}`;
const snapshot: FollowingActivityResponse = {
  scope: "saved_verified_positions",
  notice: "Partial saved coverage",
  hasMore: false,
  coverage: {
    requestedWallets: 1,
    returnedPools: 1,
    asOf: 1789400490,
    oldestAsOf: 1789400490,
    generatedAt: "2026-09-15T00:00:00.000Z",
    complete: false,
    registryExhaustive: false,
  },
  items: [
    {
      id: `${txHash}:1`,
      wallet,
      poolId,
      token,
      symbol: "TEST",
      decimals: 18,
      txHash,
      logIndex: 1,
      block: 100,
      timestamp: 1789400000,
      side: "buy",
      ethWei: "100000000000000001",
      tokenRaw: "1000000000000000000",
      priceWei: "100000000000000001",
      asOf: 1789400490,
      throughBlock: 200,
      supported: true,
    },
  ],
};

test("followed activity keeps dated trades on outage, pauses and replaces a removed publication", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await page.addInitScript(
    (address) =>
      localStorage.setItem("poolsinfo.following.v1", JSON.stringify([address])),
    wallet,
  );
  let requests = 0;
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rpc: string[] = [];
  page.on("request", (request) => {
    if (/alchemy|\/rpc(?:\/|$)/i.test(request.url())) rpc.push(request.url());
  });
  await page.route("**/api/product/following?*", async (route) => {
    requests++;
    expect(new URL(route.request().url()).searchParams.get("wallets")).toBe(
      wallet,
    );
    if (requests === 1) {
      await first;
      return route.fulfill({ json: snapshot });
    }
    if (requests === 2)
      return route.fulfill({ status: 503, json: { error: "offline" } });
    return route.fulfill({
      json: {
        ...snapshot,
        items: [],
        coverage: {
          ...snapshot.coverage,
          returnedPools: 0,
          asOf: null,
          oldestAsOf: null,
        },
      },
    });
  });
  try {
    await page.goto("/wallet/");
    const feed = page.getByRole("region", {
      name: "Following activity",
      exact: true,
    });
    await expect(
      feed.getByRole("status", { name: "Loading following activity" }),
    ).toBeVisible();
    await page.clock.fastForward(10000);
    expect(requests).toBe(1);
    release();
    await expect(feed.getByText("Bought", { exact: true })).toBeVisible();
    await expect(
      feed.getByRole("link", { name: "Open on Pools" }),
    ).toHaveAttribute("href", `https://pools.xyz/t/robinhood/${token}`);
    await expect(
      feed.getByRole("link", { name: "Transaction" }),
    ).toHaveAttribute(
      "href",
      `https://robinhoodchain.blockscout.com/tx/${txHash}`,
    );
    await expect(feed.getByText(/Latest saved cutoff/)).toContainText(
      "Partial pool coverage",
    );
    await feed.screenshot({
      path: testInfo.outputPath("following-activity.png"),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.clock.fastForward(30000);
    await expect(feed.getByRole("alert")).toHaveText(
      "Updates unavailable. Keeping the last saved activity.",
    );
    await expect(feed.getByText("Bought", { exact: true })).toBeVisible();
    await feed.getByRole("button", { name: "Pause updates" }).click();
    await page.clock.fastForward(90000);
    expect(requests).toBe(2);
    await feed.getByRole("button", { name: "Resume updates" }).click();
    await page.clock.fastForward(30000);
    await expect(feed.getByText(/No verified trades found/)).toBeVisible();
    await expect(feed.getByText("Bought", { exact: true })).toHaveCount(0);
    expect(requests).toBe(3);
    await page.getByRole("button", { name: `Unfollow ${wallet}` }).click();
    await expect(feed).toHaveCount(0);
    await page.clock.fastForward(60000);
    expect(requests).toBe(3);
    expect(rpc).toEqual([]);
  } finally {
    release();
  }
});

test("wallet copy signals show read-only executions without changing follows", async ({
  page,
}) => {
  await page.route("**/api/product/following?*", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto(`/wallet/${wallet}/`);
  await page
    .getByRole("button", { name: "View copy signals", exact: true })
    .click();
  const signals = page.getByRole("region", {
    name: "Wallet signals",
    exact: true,
  });
  await expect(signals.getByText("Bought", { exact: true })).toBeVisible();
  await expect(
    signals.getByText(/Trades are never executed here/),
  ).toBeVisible();
  await expect(
    signals.getByRole("link", { name: "Open on Pools" }),
  ).toHaveAttribute("href", `https://pools.xyz/t/robinhood/${token}`);
  expect(
    await page.evaluate(() => localStorage.getItem("poolsinfo.following.v1")),
  ).toBeNull();
  await page
    .getByRole("button", { name: "Hide copy signals", exact: true })
    .click();
  await expect(signals).toHaveCount(0);
});
