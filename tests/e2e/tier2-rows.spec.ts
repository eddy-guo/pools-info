import { test, expect, type Page } from "@playwright/test";

/** Prose the tier must never bring back to the product surface. */
const removedCopy = [
  "Swap-based estimate",
  "Mixed evidence",
  "Transfer-verified",
  "History incomplete",
  "swap-only model",
  "transaction initiators",
  "are not verified",
  "tier2",
  "tier3",
];

const tier2Wallet = "0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const tier2Pool = `0x${"ab".repeat(32)}`;
const tier2Launch = `0x${"cd".repeat(32)}`;

/** A wallet the read API ranks from tier-2 swap history alone. */
const tier2Row = {
  address: tier2Wallet,
  rank: 1,
  realizedWei: "1250000000000000000",
  unrealizedWei: null,
  netWei: "980000000000000000",
  volumeWei: "44000000000000000000",
  roi: 31.25,
  wins: 3,
  losses: 1,
  winRate: 75,
  tradeCount: 9,
  supportedTradeCount: 0,
  supportedPositionCount: 0,
  excludedPositionCount: 2,
  bestWei: "800000000000000000",
  avgHold: null,
  last: 1757000000,
  asOf: 1757000000,
  oldestAsOf: 1756000000,
  completeWindow: true,
  accountingTier: "tier2",
  attribution: "transaction_initiator_only",
  flags: [],
  tier2PositionCount: 6,
  tier3PositionCount: 0,
  realizedPositionCount: 4,
  rankingTradeCount: 7,
  verifiedUnrealizedWei: null,
  unrealizedScope: "unavailable",
};

/** A tier-2 position: identity intact, no verified inventory to report. */
const tier2Position = {
  accountingTier: "tier2",
  attribution: "transaction_initiator_only",
  poolId: tier2Pool,
  token: `0x${"9".repeat(40)}`,
  symbol: "T2POOL",
  decimals: null,
  launchTx: tier2Launch,
  asOf: 1757000000,
  throughBlock: 9100000,
  supported: false,
  flags: ["initiator_attribution"],
  realizedWei: "430000000000000000",
  unrealizedWei: null,
  netWei: "410000000000000000",
  volumeWei: "6200000000000000000",
  position: null,
  modeledPosition: { quantity: "5000000000000000000000", costWei: "70000" },
};

const tier2Trade = {
  trade: {
    poolId: tier2Pool,
    txHash: `0x${"11".repeat(32)}`,
    logIndex: 4,
    block: 9100000,
    timestamp: 1757000000,
    trader: tier2Wallet,
    side: "buy",
    ethWei: "250000000000000000",
    tokenAmount: "1000000000000000000000",
  },
  flags: ["initiator_attribution"],
  matchedTransfer: null,
  symbol: "T2POOL",
  poolId: tier2Pool,
};

async function settled(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}

/** The tier is a tag: one word, no title, and nothing else explains it. */
async function assertQuietTier(page: Page, tier: string, token: string) {
  const badge = page.locator(`.tier-badge[data-tier="${tier}"]`).first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(token);
  expect(await badge.getAttribute("title")).toBeNull();
  expect(await badge.getAttribute("aria-label")).toBeNull();
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--ac").trim(),
  );
  expect(await badge.evaluate((node) => getComputedStyle(node).color)).not.toBe(
    accent,
  );
  const text = await page.locator("main").innerText();
  for (const copy of removedCopy) expect(text, copy).not.toContain(copy);
}

test("a tier-2-only wallet ranks as an ordinary row marked only by its tier tag", async ({
  page,
  request,
}) => {
  const payload = await (
    await request.get("/api/product/leaderboard/?window=All")
  ).json();
  const items = payload.items.map((item: { rank: number }, index: number) =>
    index === 0
      ? tier2Row
      : { ...item, accountingTier: "tier3", attribution: "transfer_verified" },
  );
  await page.route("**/api/product/leaderboard/?**", (route) =>
    route.fulfill({ json: { ...payload, items } }),
  );
  await settled(page, "/traders/?window=All");
  await assertQuietTier(page, "tier2", "SWAP");

  const desktop = page.locator(".desktop-traders");
  if (await desktop.isVisible()) {
    const row = desktop.locator("tbody tr[data-row=resolved]").first();
    const cells = row.locator("td");
    await expect(cells.nth(0)).toHaveText("#1");
    await expect(cells.nth(1).locator("a.mono")).toHaveText("0xa1b2…5678");
    // The tier-2-only row carries the same combined figures a verified row does.
    await expect(cells.nth(2).locator(".number")).toHaveText("+1.25 ETH");
    await expect(cells.nth(2).locator(".number")).toHaveCSS(
      "color",
      "rgb(63, 214, 140)",
    );
    await expect(cells.nth(3).locator(".change")).toHaveText("+31.25%");
    await expect(cells.nth(4)).toHaveText("3 / 1");
    await expect(cells.nth(5)).toHaveText("7");
    await expect(cells.nth(6).locator(".number")).toHaveText("44 ETH");
    await expect(cells.nth(8).locator(".number")).toHaveText("+0.8 ETH");
    // The tag sits beside the address and leaves the reserved row geometry alone.
    await expect(cells.nth(1).locator(".tier-badge")).toBeVisible();
    for (const index of [0, 1, 2]) {
      const badge = desktop
        .locator("tbody tr[data-row=resolved]")
        .nth(index)
        .locator(".tier-badge");
      await expect(badge).toHaveCount(1);
    }
    expect(
      await row.evaluate((node) => node.getBoundingClientRect().height),
    ).toBe(74);
    return;
  }
  const card = page.locator(".mobile-trader").first();
  await expect(card.locator(".rank-number")).toHaveText("#1");
  await expect(card.locator(".mobile-trader-value .number")).toHaveText(
    "+1.25 ETH",
  );
  await expect(card.locator(".mobile-trader-key .change")).toHaveText(
    "+31.25%",
  );
  await expect(card.locator(".mobile-trader-heading .tier-badge")).toHaveText(
    "SWAP",
  );
  expect(
    await card.evaluate((node) => node.scrollHeight <= node.clientHeight),
    "the card content fits its reserved height",
  ).toBe(true);
});

test("a mixed wallet shows its unsupported position as a quiet row of the same shape", async ({
  page,
  request,
}) => {
  const address = "0x9909d019032fbaa169ecad03b38c17d8a2a9d1f8";
  const payload = await (
    await request.get(`/api/product/wallets/${address}/?window=All`)
  ).json();
  const verified = payload.positions[0];
  expect(verified?.supported, "the saved fixture has a verified position").toBe(
    true,
  );
  await page.route(`**/api/product/wallets/${address}/?**`, (route) =>
    route.fulfill({
      json: {
        ...payload,
        wallet: {
          ...payload.wallet,
          accountingTier: "mixed",
          attribution: "mixed",
          flags: ["initiator_attribution"],
          tier2PositionCount: 1,
          tier3PositionCount: payload.positions.length,
          unrealizedScope: "verified_positions_only",
          verifiedUnrealizedWei: payload.wallet.unrealizedWei,
        },
        positions: [verified, tier2Position, ...payload.positions.slice(1)],
        trades: [tier2Trade, ...payload.trades],
      },
    }),
  );
  await settled(page, `/wallet/${address}/?window=All`);
  await assertQuietTier(page, "mixed", "MIXED");

  const rows = page.locator(".wallet-list-region tbody tr[data-row=resolved]");
  const quiet = rows.nth(1);
  await expect(quiet).toHaveClass(/unsupported-row/);
  await expect(rows.nth(0)).not.toHaveClass(/unsupported-row/);
  // Identity intact, every unknown figure plainly unavailable, nothing invented.
  await expect(quiet.locator("td").nth(0).locator("a")).toHaveText("T2POOL");
  await expect(quiet.locator("td").nth(0).locator("a")).toHaveAttribute(
    "href",
    `/pool/${tier2Pool}/?launch=${tier2Launch}`,
  );
  for (const index of [1, 2, 4])
    await expect(quiet.locator("td").nth(index)).toHaveText("N/A");
  await expect(quiet.locator("td").nth(3).locator(".number")).toHaveText(
    "+0.43 ETH",
  );
  await expect(quiet.locator("td").nth(3).locator(".number")).toHaveCSS(
    "color",
    "rgb(63, 214, 140)",
  );
  // The quiet row keeps the reserved geometry of a verified row.
  const heights = await rows.evaluateAll((nodes) =>
    nodes.slice(0, 2).map((node) => node.getBoundingClientRect().height),
  );
  expect(heights[1]).toBe(heights[0]);
  expect(
    await quiet.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe(
    await rows
      .nth(0)
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  );

  // "N/A" marks a position the read API cannot value, so reserved rows stay blank.
  const reserved = page
    .locator('.wallet-list-region tbody tr[data-row="reserved"]')
    .first();
  await expect(reserved).toHaveText(/^\s*$/);

  await page.getByRole("tab", { name: "Trades" }).click();
  const trade = page.locator(".wallet-list-region tbody tr").first();
  await expect(trade.locator("td").nth(1).locator("a")).toHaveText("T2POOL");
  await expect(trade.locator("td").nth(1).locator("a")).toHaveAttribute(
    "href",
    `/pool/${tier2Pool}/?launch=${tier2Launch}`,
  );
  await expect(trade.locator("td").nth(3).locator(".number")).toHaveText(
    "0.25 ETH",
  );
  const tradesText = await page.locator("main").innerText();
  for (const copy of removedCopy) expect(tradesText, copy).not.toContain(copy);
});

test("a tier-2 read budget 503 reads as the existing unavailable state", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/product/leaderboard/?**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" },
      json: { error: "tier2_read_budget_exceeded" },
    });
  });
  await page.goto("/traders/?window=All");
  const alert = page.locator(".leaderboard-panel [role=alert]");
  await expect(alert).toHaveText("Saved data is temporarily unavailable.");
  const text = await page.locator("main").innerText();
  for (const copy of ["tier2_read_budget_exceeded", "budget", "503"])
    expect(text, copy).not.toContain(copy);
  // Retry-After is honoured by not retrying at all: the page waits for the user.
  await page.waitForTimeout(2000);
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Refresh saved rankings" }).click();
  await expect.poll(() => requests.length).toBe(2);
});
