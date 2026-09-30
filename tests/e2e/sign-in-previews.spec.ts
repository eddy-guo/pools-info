import { test, expect, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { walletHref, type ChainMarket } from "@pools/core";

/* The captain's rule: no placeholder for a feature that does not exist. The
   sign-in-shaped previews (connect a wallet, edit a profile, see your rank,
   copy-trading and alerts panels) and the legacy per-pool traders view are
   gone; the Copy trade button and its modal stay public by the captain's
   explicit word. */
const removedCopy = [
  "Your public profile",
  "Connect your wallet",
  "Connect wallet",
  "Edit profile",
  "PRODUCT PREVIEW",
  "MetaMask",
  "WalletConnect",
  "Coming soon",
  "audited pool coverage",
  "Connect to see your rank",
  "View my rank",
  "Personal ranking is coming later",
  "Audit scope",
  "Audit before ranking",
  "Follow the wallets. Understand the performance.",
  "Look up your wallet",
  "Find your wallet",
  "Set up copy trading",
];

const market = chain.markets[0] as ChainMarket;
const topWallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

async function expectNoRemovedCopy(page: Page) {
  const text = await page.locator("main").innerText();
  for (const copy of removedCopy) expect(text, copy).not.toContain(copy);
}

/** Cumulative layout shift from navigation start, observed before any paint. */
async function observeShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { previewShifts: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

async function settledShift(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
  return page.evaluate(
    () =>
      (window as unknown as { previewShifts: { cls: number } }).previewShifts
        .cls,
  );
}

test("the wallet lookup page keeps its form and nothing sign-in shaped", async ({
  page,
}) => {
  await page.goto("/wallet/");
  await expect(
    page.getByRole("heading", { name: "Look up a wallet." }),
  ).toBeVisible();
  await expectNoRemovedCopy(page);
  await expect(page.locator("main dialog")).toHaveCount(0);
  await expect(page.locator("main .page-heading p")).toHaveCount(0);
  await page.getByLabel("Wallet address", { exact: true }).fill(topWallet);
  await page.getByRole("button", { name: "Open wallet profile" }).click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${topWallet}/`));
});

test("the legacy per-pool traders URL lands on the ordinary leaderboard", async ({
  page,
}) => {
  await page.goto(`/traders/?pool=${market.id}&launch=${market.launchTx}`);
  await expect(
    page.locator(".ranked-traders .leaderboard-panel"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Trader leaderboard." }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Audit pool" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^(Audit traders|Refresh audit)$/ }),
  ).toHaveCount(0);
  await expectNoRemovedCopy(page);
});

test("the per-pool wallet view keeps Copy trade and drops its preview panels", async ({
  page,
}, testInfo) => {
  await page.goto(walletHref(topWallet, market));
  await expect(
    page.getByRole("combobox", { name: "Audit pool" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alerts" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Copy trading" })).toHaveCount(
    0,
  );
  const text = await page.locator("main").innerText();
  for (const copy of ["Edit profile", "PREVIEW", "Set up copy trading"])
    expect(text, copy).not.toContain(copy);

  const actions = page.locator(".page-heading .button");
  await expect(actions).toHaveText([
    "Explorer ↗",
    "Share PnL card",
    "Copy trade",
  ]);
  await expect(
    page.locator(".page-heading .button:not(.secondary)"),
  ).toHaveText(["Copy trade"]);
  if (testInfo.project.name === "mobile") {
    // Two equal actions, then the odd last one across the whole row: no hole.
    const [explorer, share, copy] = await actions.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON()),
    );
    expect(share.y).toBe(explorer.y);
    expect(share.width).toBe(explorer.width);
    expect(copy.y).toBeGreaterThan(explorer.y);
    expect(copy.x).toBe(explorer.x);
    expect(copy.x + copy.width).toBe(share.x + share.width);
  }

  await page.getByRole("button", { name: "Copy trade", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Copy trading" });
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});

for (const width of [1440, 390]) {
  for (const [name, url] of [
    ["wallet lookup", "/wallet/"],
    ["traders", "/traders/"],
    [
      "legacy per-pool traders",
      `/traders/?pool=${market.id}&launch=${market.launchTx}`,
    ],
  ]) {
    test(`${name} loads at CLS 0 at ${width}px`, async ({ page, isMobile }) => {
      test.skip(isMobile, "one project measures both exact viewport widths");
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 1000,
      });
      await observeShifts(page);
      await page.goto(url);
      await expect(page.locator("footer").first()).toBeAttached();
      expect(await settledShift(page)).toBeLessThan(0.001);
    });
  }
}
