import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import captures from "../../data/pools/index.json";
import { poolHref } from "@pools/core";
const topWallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

test("Explore retains saved rows during refresh", async ({ page, request }) => {
  const payload = await (
    await request.get(
      "/api/product/explore?window=24h&view=all&offset=0&limit=25&q=&sort=launch&direction=desc",
    )
  ).json();
  let release: () => void = () => {},
    calls = 0;
  await page.route("**/api/product/explore?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") !== "25")
      return route.continue();
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: payload });
  });
  await page.goto("/");
  await expect(page.locator(".product-coverage[aria-busy=true]")).toBeVisible();
  await expect.poll(() => calls).toBe(1);
  release();
  const first = page
    .locator(".desktop-pools, .mobile-pools")
    .getByText(payload.items[0].name, { exact: true })
    .filter({ visible: true });
  await expect(first).toBeVisible();
  await page
    .locator("main")
    .getByRole("button", { name: "Refresh saved data", exact: true })
    .click();
  await expect.poll(() => calls).toBe(2);
  await expect(first).toBeVisible();
  await expect(page.locator(".product-coverage[aria-busy=true]")).toHaveCount(
    0,
  );
  release();
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "Refresh saved data", exact: true }),
  ).toBeEnabled();
});

test("wallet and leaderboard show structured loading instead of empty analytics", async ({
  page,
  request,
}, testInfo) => {
  for (const entry of [
    {
      url: `/wallet/${topWallet}/`,
      api: `wallets/${topWallet}`,
      label: "Loading wallet analytics",
      loaded: "Positions across covered pools",
    },
    {
      url: "/traders/?window=All",
      api: "leaderboard",
      label: "Loading trader rankings",
      loaded: null,
    },
  ]) {
    const payload = await (
      await request.get(`/api/product/${entry.api}?window=All`)
    ).json();
    let release: () => void = () => {},
      started = false;
    await page.route(`**/api/product/${entry.api}?**`, async (route) => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: payload });
    });
    await page.goto(entry.url);
    const skeleton = page.locator(".product-coverage[aria-busy=true]");
    await expect(skeleton).toBeVisible();
    await expect(
      page
        .getByText("No supported realized history in this window.", {
          exact: true,
        })
        .filter({ visible: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(
        `${entry.api.startsWith("wallet") ? "wallet" : "leaderboard"}-loading.png`,
      ),
      fullPage: false,
    });
    await expect.poll(() => started).toBe(true);
    release();
    await expect(skeleton).toHaveCount(0);
    if (entry.loaded)
      await expect(
        page.getByRole("heading", { name: entry.loaded }),
      ).toBeVisible();
    else
      await expect(
        page
          .locator(`a[href="/wallet/${topWallet}/?window=All"]`)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    await page.unroute(`**/api/product/${entry.api}?**`);
  }
});

test("on-demand pools reserve a chart layout while saved data loads", async ({
  page,
}, testInfo) => {
  const saved = Object.values(captures.snapshots).find(
    (snapshot) => !chain.markets.some((m) => m.id === snapshot.markets[0].id),
  )!;
  const pool = saved.markets[0];
  const releases: Array<() => void> = [];
  for (const pattern of [
    `**/api/product/pools/${pool.id}`,
    `**/api/markets/${pool.id}/?*`,
  ])
    await page.route(pattern, async (route) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      await route.continue();
    });
  await page.goto(poolHref(pool));
  const skeleton = page.locator(".nullable-pool-page[aria-busy=true]");
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator(".interactive-chart")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("pool-loading.png"),
    fullPage: false,
  });
  await expect.poll(() => releases.length).toBe(2);
  for (const release of releases) release();
  await expect(
    page.getByRole("heading", { name: pool.name, exact: true }),
  ).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});

test("search keeps local matches while the saved index is pending and skeletons empty pending results", async ({
  page,
}) => {
  let release: () => void = () => {},
    started = false;
  await page.route("**/api/product/search?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (!query) return route.continue();
    started = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status: 503, json: { error: "Unavailable" } });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search Pools Info" }),
    input = dialog.getByRole("textbox");
  await input.fill("zzzzzzzzzz");
  await expect(
    dialog.getByRole("status", { name: "Searching tokens and wallets" }),
  ).toBeVisible();
  await expect(dialog.getByText("No matches in current coverage")).toHaveCount(
    0,
  );
  await expect.poll(() => started).toBe(true);
  release();
  await expect(
    dialog.getByText("No matches in current coverage"),
  ).toBeVisible();
  started = false;
  await input.fill(chain.markets[0].symbol);
  await expect(
    dialog
      .getByRole("link", { name: new RegExp(chain.markets[0].symbol) })
      .first(),
  ).toBeVisible();
  await expect.poll(() => started).toBe(true);
  await expect(
    dialog.getByRole("status", { name: "Searching tokens and wallets" }),
  ).toHaveCount(0);
  release();
  await expect(dialog.getByText(/Saved search is unavailable/)).toBeVisible();
  await page.route("**/api/ens/?**", (route) =>
    route.fulfill({ json: { name: "invalid.eth", address: "invalid" } }),
  );
  await input.fill("invalid.eth");
  await expect(dialog.getByRole("alert")).toHaveText(
    "Search is unavailable. Try again shortly.",
  );
  await expect(dialog.locator("[data-skeleton]")).toHaveCount(0);
  await expect(dialog.locator(".search-result")).toHaveCount(0);
});
