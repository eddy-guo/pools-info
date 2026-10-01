import { test, expect, type Page } from "@playwright/test";
import { poolHref, type AnalyticsWalletResponse } from "@pools/core";
import { settledRoute, settleRoutes } from "../support/settled-route";

/** A fixture wallet with three supported positions: FOLIO, SEYMOUR and PEPE. */
const wallet = "0x55fcda0fb9e44920755fc019e6e1ea7f396c016d";
/** A fixture wallet whose only position is in the PEPE pool. */
const pepeOnly = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const axePath = require.resolve("axe-core/axe.min.js", {
  paths: [require.resolve("@playwright/test")],
});

test.afterEach(({ page }) => settleRoutes(page));

type Position = AnalyticsWalletResponse["positions"][number];
async function positions(page: Page, address = wallet) {
  const response = await page.request.get(
    `/api/product/wallets/${address}/?window=All`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as AnalyticsWalletResponse).positions;
}
const bySymbol = (rows: Position[], symbol: string) =>
  rows.find((p) => p.symbol === symbol)!;
/** The share action the layout on screen shows: the table's, or a phone row's. */
const shareButton = (page: Page, symbol: string) =>
  page
    .getByRole("button", { name: `Share ${symbol} position`, exact: true })
    .filter({ visible: true });
/** The wallet read with one position excluded, as the ledger flags it. */
async function excludeFolio(page: Page) {
  await settledRoute(
    page,
    `**/api/product/wallets/${wallet}/?**`,
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as AnalyticsWalletResponse;
      for (const p of json.positions)
        if (p.symbol === "FOLIO") {
          p.supported = false;
          p.flags = ["unattributed_swap_activity"];
        }
      await route.fulfill({ response, json });
    },
  );
}

test("a supported position row opens its own card; an excluded row has no action", async ({
  page,
}) => {
  const rows = await positions(page);
  const seymour = bySymbol(rows, "SEYMOUR");
  await excludeFolio(page);
  await page.goto(`/wallet/${wallet}/?window=All`);
  await expect(shareButton(page, "SEYMOUR")).toBeVisible();
  await expect(shareButton(page, "PEPE")).toBeVisible();
  // Never a disabled-but-visible action: the excluded row has none at all.
  await expect(
    page.getByRole("button", { name: "Share FOLIO position" }),
  ).toHaveCount(0);

  await shareButton(page, "SEYMOUR").click();
  const dialog = page.getByRole("dialog", { name: "Share PnL card" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Card" }).getByRole("button", {
      name: "Position",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  const picker = dialog.getByRole("combobox", { name: "Preview · Position" });
  await expect(picker).toHaveValue(seymour.poolId);
  const scoped = `/cards/${wallet}.png?pool=${seymour.poolId}&launch=${seymour.launchTx}`;
  await expect(dialog.getByRole("img")).toHaveAttribute("src", scoped);
  const download = dialog.getByRole("link", { name: "Download" });
  await expect(download).toHaveAttribute("href", scoped);
  await expect(download).toHaveAttribute(
    "download",
    `poolsinfo-${wallet}-seymour.png`,
  );
  // The picker lists only the positions with a card, largest realized first.
  await expect(picker.locator("option")).toHaveText([
    /^PEPE · /,
    /^SEYMOUR · /,
  ]);
  // A position card has one design and always shows ETH in and out: both
  // options are offered disabled, with their reasons.
  await expect(
    dialog.getByRole("group", { name: "Design" }).getByRole("button", {
      name: "Export",
    }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("switch", { name: /Show notional/ }),
  ).toBeDisabled();
  await expect(
    dialog.locator("label").filter({ hasText: "Show notional" }),
  ).toContainText("Not offered on a position card");
  // Options the position card honours stay on its URL.
  await dialog.getByRole("switch", { name: /Anonymous mode/ }).click();
  await expect(download).toHaveAttribute("href", `${scoped}&anon=1`);
  await expect(download).toHaveAttribute(
    "download",
    "poolsinfo-pnl-seymour.png",
  );

  // The Card switch moves to the portfolio card and back to the position.
  await dialog.getByRole("button", { name: "Portfolio", exact: true }).click();
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&anon=1`,
  );
  await expect(dialog.getByText("Preview · All realized")).toBeVisible();
  await dialog.getByRole("button", { name: "Position", exact: true }).click();
  await expect(picker).toHaveValue(seymour.poolId);

  // Sharing without a file share sheet links the wallet page that unfurls
  // to this very card.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    window.open = ((url: string) => {
      (window as unknown as { opened: string }).opened = url;
      return null;
    }) as typeof window.open;
  });
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { opened?: string }).opened),
    )
    .toContain(
      encodeURIComponent(
        `/wallet/${wallet}/?pool=${seymour.poolId}&launch=${seymour.launchTx}&anon=1`,
      ),
    );

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(shareButton(page, "SEYMOUR")).toBeFocused();
  // The heading's button still opens the portfolio card.
  await page.getByRole("button", { name: "Share PnL card" }).click();
  await expect(
    dialog.getByRole("button", { name: "Portfolio", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&anon=1`,
  );
  // Picking Position from there opens the largest realized position.
  const pepe = bySymbol(rows, "PEPE");
  // Each opening of a position card reads the wallet's positions afresh.
  const reread = page.waitForResponse((response) =>
    response.url().includes(`/api/product/wallets/${wallet}/?window=All`),
  );
  await dialog.getByRole("button", { name: "Position", exact: true }).click();
  await reread;
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?pool=${pepe.poolId}&launch=${pepe.launchTx}&anon=1`,
  );
  await picker.selectOption(seymour.poolId);
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?pool=${seymour.poolId}&launch=${seymour.launchTx}&anon=1`,
  );
});

test("the pool page offers the set wallet's position card and says when there is none", async ({
  page,
}) => {
  const rows = await positions(page);
  const folio = bySymbol(rows, "FOLIO");
  const pepe = bySymbol(rows, "PEPE");
  const folioPage = poolHref({ id: folio.poolId, launchTx: folio.launchTx });
  // Without a wallet set there is nothing to share.
  await page.goto(folioPage);
  await expect(page.locator(".pool-page h1")).not.toHaveText(
    /Loading saved pool/,
  );
  await expect(
    page.getByRole("button", { name: "Share my position" }),
  ).toHaveCount(0);

  await page.evaluate(
    (address) => localStorage.setItem("poolsinfo.my-wallet.v1", address),
    wallet,
  );
  await page.goto(folioPage);
  const button = page.getByRole("button", { name: "Share my position" });
  await expect(button).toBeEnabled();
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Share PnL card" });
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?pool=${folio.poolId}&launch=${folio.launchTx}`,
  );
  await expect(
    dialog.getByRole("combobox", { name: "Preview · Position" }),
  ).toHaveValue(folio.poolId);
  await page.keyboard.press("Escape");

  // A wallet with no supported position in this pool gets the modal's own
  // line, and no card is requested for it.
  const cards: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/cards/")) cards.push(request.url());
  });
  await page.evaluate(
    (address) => localStorage.setItem("poolsinfo.my-wallet.v1", address),
    pepeOnly,
  );
  await page.goto(folioPage);
  await page.getByRole("button", { name: "Share my position" }).click();
  await expect(
    dialog.getByText("No supported position in this pool for your wallet."),
  ).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Download" })).toBeDisabled();
  expect(cards).toEqual([]);
  // The rest of that wallet's positions are still one pick away.
  await expect(
    dialog
      .getByRole("combobox", { name: "Preview · Position" })
      .locator("option:not([disabled])"),
  ).toHaveText([/^PEPE · /]);
  expect(pepe.poolId).not.toBe(folio.poolId);
});

test("the card modal's presets are one radio group and its toggles are switches", async ({
  page,
}) => {
  // The card is served slowly so the Download control is caught while the
  // card it would name is still rendering.
  await page.route(`**/cards/${wallet}.png?**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#0B0B0E"/></svg>',
    });
  });
  await page.goto(`/wallet/${wallet}/?window=All`);
  await page.getByRole("button", { name: "Share PnL card" }).click();
  const dialog = page.getByRole("dialog", { name: "Share PnL card" });
  const preview = dialog.locator("[data-state]");
  // Rendering: Download is a disabled button, out of the tab order, not a
  // focusable link that would download a card that is not there yet.
  await expect(preview).toHaveAttribute("data-state", "loading");
  await expect(dialog.getByRole("button", { name: "Download" })).toBeDisabled();
  await expect(dialog.getByRole("link", { name: "Download" })).toHaveCount(0);
  await expect(preview).toHaveAttribute("data-state", "ready");
  await expect(dialog.getByRole("link", { name: "Download" })).toBeVisible();

  const group = dialog.getByRole("radiogroup", { name: "Colour preset" });
  const radio = (name: string) => group.getByRole("radio", { name });
  // One tab stop: the checked swatch.
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await expect(radio("Lime")).toHaveAttribute("tabindex", "0");
  await radio("Lime").focus();
  await page.keyboard.press("ArrowRight");
  await expect(radio("Mint")).toBeFocused();
  await expect(radio("Mint")).toHaveAttribute("aria-checked", "true");
  await expect(radio("Lime")).toHaveAttribute("aria-checked", "false");
  await expect(radio("Lime")).toHaveAttribute("tabindex", "-1");
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "src",
    `/cards/${wallet}.png?window=All&theme=mint`,
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(radio("Mono")).toBeFocused();
  await expect(radio("Mono")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Home");
  await expect(radio("Lime")).toBeFocused();
  await page.keyboard.press("End");
  await expect(radio("Mono")).toBeFocused();
  // Tab leaves the group rather than walking through every swatch.
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("switch", { name: /Anonymous mode/ }),
  ).toBeFocused();

  const anonymous = dialog.getByRole("switch", { name: /Anonymous mode/ });
  await expect(anonymous).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(anonymous).toBeChecked();
  await expect(
    dialog.getByRole("switch", { name: /Show notional/ }),
  ).not.toBeChecked();
});

for (const kind of ["portfolio", "position"] as const)
  test(`the open ${kind} card modal has no accessibility violations`, async ({
    page,
  }) => {
    await page.goto(`/wallet/${wallet}/?window=All`);
    if (kind === "position") await shareButton(page, "PEPE").click();
    else await page.getByRole("button", { name: "Share PnL card" }).click();
    const dialog = page.getByRole("dialog", { name: "Share PnL card" });
    await expect(dialog.locator("[data-state]")).toHaveAttribute(
      "data-state",
      "ready",
    );
    await dialog.evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished)),
    );
    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: Element,
              options: object,
            ) => Promise<{
              violations: { id: string; nodes: { target: string[] }[] }[];
            }>;
          };
        }
      ).axe;
      const result = await axe.run(document.querySelector("dialog[open]")!, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
      });
      return result.violations.map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
      );
    });
    expect(violations).toEqual([]);
  });
