import { test, expect } from "@playwright/test";

const topWallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const activeWallet = "0x9909d019032fbaa169ecad03b38c17d8a2a9d1f8";
const unknownWallet = "0x1111111111111111111111111111111111111111";
/** Data-quality and preview copy that a real user should never see on a profile. */
const removedCopy = [
  "discovered pools",
  "with saved analytics",
  "Latest captured data",
  "Pool cutoffs vary",
  "PnL covers supported pool positions",
  "Coverage and methodology",
  "transfer-verified positions",
  "swap-based positions",
  "Unknown cost basis",
  "Profile coverage",
  "Public wallet",
  "no account required",
  "Chart points are sampled",
  "Transfer-verified",
  "History incomplete",
  "Swap-based estimate",
  "Grouped by launch transaction sender",
  "Edit profile",
  "PREVIEW",
  "Set up copy trading",
  "Before gas",
  "Profit / disposed cost",
  "Closed inventory cycles",
  "Refresh saved profile",
  "Ranking trades",
  "Observed volume",
  "Avg closed hold",
  "Best realized sale",
  "copy signals",
  "COPY SIGNALS",
  "Wallet signals",
  "median lag",
  "Backtested",
];
/** The export's stat labels: a name for each value, never a method note. */
const statLabels = [
  "Realized PnL",
  "Unrealized",
  "ROI",
  "Win rate",
  "Trades",
  "Volume",
  "Avg hold",
  "Best trade",
];

async function settled(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}
/** The behaviour panel's five rows: label, value and the bar's filled share. */
async function expectBehaviour(
  page: import("@playwright/test").Page,
  rows: [label: string, value: string, width: string][],
) {
  const region = page.locator(".wallet-behaviour-row");
  await expect(region.locator("> span:first-child")).toHaveText(
    rows.map((row) => row[0]),
  );
  await expect(region.locator("> .number")).toHaveText(
    rows.map((row) => row[1]),
  );
  expect(
    await region
      .locator(".wallet-behaviour-bar > i")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).style.width),
      ),
  ).toEqual(rows.map((row) => row[2]));
}

test("a ranked wallet shows profile content without coverage or preview copy", async ({
  page,
}, testInfo) => {
  await settled(page, `/wallet/${topWallet}/?window=All`);
  const main = page.locator("main");
  const text = await main.innerText();
  for (const copy of removedCopy) expect(text, copy).not.toContain(copy);
  await expect(main.locator("thead th", { hasText: "Coverage" })).toHaveCount(
    0,
  );
  await expect(main.locator("dialog.feature-dialog")).toHaveCount(0);

  // The right column as the export draws it: alerts, behaviour, most traded.
  const sidebar = page.locator(".market-sidebar");
  await expect(sidebar.locator("h2")).toHaveText([
    "Alerts",
    "Behaviour",
    "Most traded pools",
  ]);
  await expect(sidebar.locator("> *").first()).toHaveClass(/panel/);
  const alerts = sidebar.locator(".wallet-alerts button");
  await expect(alerts).toHaveText([
    /^Every trade/,
    /^First launch/,
    /^Large exit/,
    /^Leaderboard move/,
  ]);
  for (const toggle of await alerts.all()) {
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }
  await expect(
    sidebar.locator(".panel", { hasText: "Alerts" }).locator(".panel-footnote"),
  ).toHaveText("Alerts are not available yet.");
  await expectBehaviour(page, [
    ["Win rate", "100%", "100%"],
    ["Wins", "1", "100%"],
    ["Losses", "0", "0%"],
    ["Still held", "0 of 1", "0%"],
    ["Volume in top pool", "100%", "100%"],
  ]);
  await expect(sidebar.locator(".wallet-top-pool")).toHaveCount(1);
  await expect(sidebar.locator(".wallet-top-pool").first()).toHaveAttribute(
    "href",
    /^\/pool\//,
  );
  await expect(
    sidebar.locator(".wallet-top-pool").first().locator("> :first-child"),
    "each pool row opens with its identity tile",
  ).toHaveAttribute("data-pool-image", /^0x/);
  const comingSoon = sidebar.locator(".coming-soon-row");
  await expect(comingSoon).toHaveText(
    "Coming soonCopy trading · Profile editing",
  );
  await expect(comingSoon.locator("button, a")).toHaveCount(0);
  await expect(comingSoon).toHaveCSS("color", "rgb(154, 154, 164)");
  // The export's tab counts, from the rows the read sent.
  await expect(main.getByRole("tab")).toHaveText([
    /^Positions\s*1$/,
    /^Trades\s*11$/,
    /^Launches\s*0$/,
    "Transactions",
    "Token transfers",
  ]);

  const stats = main.locator(".live-eight-stats .stat");
  await expect(stats.locator("> span")).toHaveText(statLabels);
  await expect(stats.locator("small")).toHaveCount(0);
  // The window tabs sit in the chart panel head, as the export draws them,
  // rather than in a controls row of their own above the stat cards.
  await expect(main.locator(".live-controls")).toHaveCount(0);
  await expect(
    main
      .locator(".panel-heading", { hasText: "Cumulative realized PnL" })
      .getByRole("button", { pressed: true }),
  ).toHaveText("All");
  if (testInfo.project.name === "desktop") {
    const lines = await stats.locator("> strong > span").evaluateAll((nodes) =>
      nodes.map((node) => {
        const line = parseFloat(getComputedStyle(node).lineHeight);
        return Math.round(node.getBoundingClientRect().height / line);
      }),
    );
    expect(lines, "no stat value wraps").toEqual(statLabels.map(() => 1));
  }
  await page.getByRole("button", { name: "Share PnL card" }).click();
  const dialog = page.getByRole("dialog", { name: "Share PnL card" });
  await expect(dialog).toBeVisible();
  expect(await dialog.innerText()).not.toContain("1200 × 630");
  await page.getByRole("button", { name: "Close share card" }).click();

  const actions = page.locator(".page-heading .button");
  await expect(actions).toHaveText([
    "Explorer ↗",
    "Share PnL card",
    "Follow wallet",
    "This is my wallet",
    "Copy trade",
  ]);
  await expect(actions.last()).not.toHaveClass(/secondary/);
  await expect(
    page.locator(".page-heading .button:not(.secondary)"),
  ).toHaveCount(1);
  const boxes = await actions.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: rect.height,
      };
    }),
  );
  if (testInfo.project.name === "mobile") {
    for (const box of boxes) expect(box.h, "44px tap targets").toBe(44);
    expect(
      new Set(boxes.slice(0, 4).map((box) => box.w)).size,
      "equal widths",
    ).toBe(1);
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[2].y).toBe(boxes[3].y);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
    // The odd fifth action takes the whole row rather than leaving a hole.
    expect(boxes[4].y).toBeGreaterThan(boxes[2].y);
    expect(boxes[4].w).toBeGreaterThan(boxes[0].w * 2);
    for (const label of await actions.allInnerTexts())
      expect(label.split("\n").length).toBeLessThanOrEqual(2);
  } else {
    const chart = await page
      .locator(".panel", { has: page.locator(".wallet-chart-region") })
      .boundingBox();
    expect(chart!.y, "the chart panel sits in the first screen").toBeLessThan(
      560,
    );
  }
});

test("most traded pools lists at most five pools by observed volume", async ({
  page,
}) => {
  await settled(page, `/wallet/${activeWallet}/?window=All`);
  const rows = page.locator(".market-sidebar .wallet-top-pool");
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator("strong")).toHaveText("PEPE");
  const volumes = await rows
    .locator("small .number")
    .evaluateAll((nodes) =>
      nodes.map((node) => BigInt(node.getAttribute("title")!.split(" ")[0])),
    );
  for (let i = 1; i < volumes.length; i++)
    expect(volumes[i] <= volumes[i - 1]).toBe(true);
  // Every bar is a share of a real denominator: one win in three closed
  // cycles, five of eight positions still held, PEPE's share of the volume.
  await expectBehaviour(page, [
    ["Win rate", "33%", "33%"],
    ["Wins", "1", "33%"],
    ["Losses", "2", "67%"],
    ["Still held", "5 of 8", "63%"],
    ["Volume in top pool", "22%", "22%"],
  ]);
});

test("marking a wallet as mine reframes its page as the portfolio", async ({
  page,
}) => {
  await settled(page, `/wallet/${topWallet}/?window=All`);
  const crumb = page.locator("nav[aria-label=Breadcrumb] > span").last();
  const title = page.locator(".page-heading h1");
  const mine = page.getByRole("button", { name: "This is my wallet" });
  await expect(crumb).toHaveText("0x4745…bce1");
  await expect(title).toHaveText("0x4745…bce1");
  await expect(mine).toHaveAttribute("aria-pressed", "false");
  const width = (await mine.boundingBox())!.width;
  await mine.click();
  await expect(mine).toHaveAttribute("aria-pressed", "true");
  expect((await mine.boundingBox())!.width, "the label holds its width").toBe(
    width,
  );
  await expect(crumb).toHaveText("Portfolio");
  await expect(title).toHaveText("Portfolio");
  await expect(page.locator(".page-heading h1 + span")).toHaveText("RANK 1");
  // Saved in this browser: the framing survives a reload and stays on this
  // address alone.
  await settled(page, `/wallet/${topWallet}/?window=All`);
  await expect(title).toHaveText("Portfolio");
  await settled(page, `/wallet/${activeWallet}/?window=All`);
  await expect(title).toHaveText("0x9909…d1f8");
  await expect(mine).toHaveAttribute("aria-pressed", "false");
  await settled(page, `/wallet/${topWallet}/?window=All`);
  await expect(mine).toHaveAttribute("aria-pressed", "true");
  await mine.click();
  await expect(title).toHaveText("0x4745…bce1");
  await expect(mine).toHaveAttribute("aria-pressed", "false");
});

// The server paints the public framing and hydration swaps in the portfolio
// framing for the stored wallet: whole nodes, so nothing on screen moves.
test("a stored wallet's page paints as the portfolio with no layout shift", async ({
  page,
}) => {
  await page.addInitScript((address) => {
    localStorage.setItem("poolsinfo.my-wallet.v1", address);
    const state = { cls: 0 };
    Object.assign(window, { layoutMeasurement: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, topWallet);
  await settled(page, `/wallet/${topWallet}/?window=All`);
  await expect(page.locator(".page-heading h1")).toHaveText("Portfolio");
  await expect(
    page.locator("nav[aria-label=Breadcrumb] > span").last(),
  ).toHaveText("Portfolio");
  await expect(
    page.getByRole("button", { name: "This is my wallet" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { layoutMeasurement: { cls: number } })
          .layoutMeasurement.cls,
    ),
    "every non-input layout shift since navigation",
  ).toBe(0);
});

test("a wallet without supported history reads plainly", async ({ page }) => {
  await settled(page, `/wallet/${unknownWallet}/?window=All`);
  const main = page.locator("main");
  const text = await main.innerText();
  for (const copy of removedCopy) expect(text, copy).not.toContain(copy);
  await expect(page.locator(".page-heading h1 + span")).toHaveText("UNRANKED");
  await expect(
    main
      .locator(".stat")
      .filter({ has: page.getByText("Realized PnL", { exact: true }) })
      .locator(".unavailable"),
    "a stat card's unknown value is the quiet mark",
  ).toHaveText("\u2013");
  await expect(
    main.getByText("No realized PnL in this window.", { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "No positions in this window" }),
  ).toBeVisible();
  await expect(page.locator(".market-sidebar .wallet-top-pools")).toHaveText(
    "No pool activity in this window.",
  );
  await expect(page.locator(".market-sidebar h2").last()).toHaveText(
    "Most traded pools",
  );
  // A figure with no denominator leaves its value and bar empty.
  await expectBehaviour(page, [
    ["Win rate", "", "0%"],
    ["Wins", "0", "0%"],
    ["Losses", "0", "0%"],
    ["Still held", "", "0%"],
    ["Volume in top pool", "", "0%"],
  ]);
  await expect(page.locator(".wallet-behaviour .unavailable")).toHaveCount(0);
  await expect(page.locator(".market-sidebar")).not.toContainText("N/A");
});

test("copy trade opens the designed card as a read-only preview", async ({
  page,
}, testInfo) => {
  await settled(page, `/wallet/${topWallet}/?window=All`);
  const grid = page.locator(".page .workspace-grid");
  const before = await grid.boundingBox();
  const preview = page.getByRole("dialog", { name: "Copy trading" });
  await expect(preview).toBeHidden();
  await page.getByRole("button", { name: "Copy trade", exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Wallet signals" }),
  ).toHaveCount(0);
  // The card carries the export's controls, none of which can be used.
  const toggle = preview.getByRole("switch", { name: "Copy trading" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const sizes = preview
    .getByRole("group", { name: "Per trade" })
    .getByRole("button");
  await expect(sizes).toHaveText(["0.05", "0.10", "0.25", "1.00"]);
  for (const size of await sizes.all()) await expect(size).toBeDisabled();
  await expect(sizes.nth(1)).toHaveAttribute("aria-pressed", "true");
  const rules = preview.getByRole("checkbox");
  await expect(rules).toHaveCount(3);
  for (const rule of await rules.all()) await expect(rule).toBeDisabled();
  await expect(rules.nth(0)).toBeChecked();
  await expect(rules.nth(2)).not.toBeChecked();
  await expect(preview.getByText("Their last 30d, at your size")).toBeVisible();
  await expect(
    preview.locator("strong"),
    "no backtest figure is invented",
  ).toHaveText("");
  await expect(preview.getByRole("status")).toHaveText(
    "Copy trading is not available yet.",
  );
  const text = await preview.innerText();
  for (const copy of [...removedCopy, "pools.trade", "N/A"])
    expect(text, copy).not.toContain(copy);
  const box = (await preview.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(
    Math.abs(box.x + box.width / 2 - viewport.width / 2),
    "the card is centred",
  ).toBeLessThanOrEqual(1);
  expect(box.width).toBeLessThanOrEqual(416);
  await preview.screenshot({
    path: testInfo.outputPath("copy-trade-preview.png"),
  });
  // The dialog sits in the top layer, so the page behind it never moves.
  expect(await grid.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  expect(await grid.boundingBox()).toEqual(before);
  await page.getByRole("button", { name: "Copy trade", exact: true }).click();
  await expect(preview).toBeVisible();
  await preview
    .getByRole("button", { name: "Close copy trading preview" })
    .click();
  await expect(preview).toBeHidden();
  expect(
    await page.evaluate(() => localStorage.getItem("poolsinfo.following.v1")),
    "opening the preview follows nothing",
  ).toBeNull();
});
