import { test, expect, type Page } from "@playwright/test";

// Copy the captain removed from the leaderboard header; it must not come back.
const removedCopy = [
  "Follow the wallets. Understand the performance.",
  "Look up your wallet",
  "Connect to see your rank",
  "Wallet profiles are public. Personal ranking is coming later.",
  "View my rank",
  "with saved analytics",
  "Latest captured data",
  "Coverage and methodology",
  "Ranked before pagination",
  "Minimum swaps",
];

test("the trader leaderboard header holds only the title and its ranking controls", async ({
  page,
}) => {
  await page.goto("/traders/");
  const main = page.locator("main");
  const panel = main.locator(".leaderboard-panel");
  await expect(panel).toBeVisible();
  for (const copy of removedCopy)
    await expect(main.getByText(copy), copy).toHaveCount(0);
  await expect(main.getByLabel("Minimum swaps")).toHaveCount(0);
  await expect(main.locator(".personal-rank")).toHaveCount(0);
  const viewport = page.viewportSize()!;
  const box = (await panel.boundingBox())!;
  expect(box.y, "the leaderboard begins within the first screen").toBeLessThan(
    viewport.height,
  );
  expect(new URL(page.url()).searchParams.has("minTrades")).toBe(false);

  const metric = main.getByRole("button", { name: "Net ETH", exact: true });
  await metric.click();
  await expect(metric).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]metric=net(?:&|$)/);

  const window = main.getByRole("button", { name: "30d", exact: true });
  await window.click();
  await expect(window).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/[?&]window=30d(?:&|$)/);
  await expect(page).toHaveURL(/[?&]metric=net(?:&|$)/);
  expect(new URL(page.url()).searchParams.has("minTrades")).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the header controls fit the viewport",
  ).toBe(true);
});

// The podium always holds ranks 1-3, so the flat list's own row count runs
// three behind the "shown" total the pagination count and URL track.
const LIST_OFFSET = 3;

// Focus follows each appended page and scrolls the test deep into the list.
// Normalize before a reload so browser scroll-restoration timing cannot bring
// the statically prerendered pagination foot into the measured viewport.
async function reloadFromTop(page: Page) {
  await page.evaluate(() => {
    scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.reload();
}

test("the trader leaderboard grows with a Show more button and a running Gmail-style count", async ({
  page,
  request,
}) => {
  test.slow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 8 });

  const total: number = (
    await (
      await request.get("/api/product/leaderboard/?window=All&limit=100")
    ).json()
  ).total;
  expect(
    total,
    "the saved fixture ranks enough wallets to grow past one click",
  ).toBeGreaterThan(50);

  await page.addInitScript(() => {
    // Test navigation and locator actionability, not animated scrolling. This
    // also makes every new document start at the requested position promptly
    // under the deliberate 8x CPU throttle below.
    const disableSmoothScroll = () => {
      document.documentElement.style.scrollBehavior = "auto";
    };
    if (document.documentElement) disableSmoothScroll();
    else
      document.addEventListener("DOMContentLoaded", disableSmoothScroll, {
        once: true,
      });
    const state = { cls: 0 };
    Object.assign(window, { clickMeasurement: state });
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

  await page.goto("/traders/?window=All");
  const layoutShifts: Record<string, number> = {};
  const recordLayoutShifts = async (phase: string) => {
    layoutShifts[phase] = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const state = (
        window as unknown as { clickMeasurement: { cls: number } }
      ).clickMeasurement;
      const value = state.cls;
      state.cls = 0;
      return value;
    });
  };
  const panel = page.locator("main .leaderboard-panel");
  const pagination = panel.locator(".pagination");
  const count = pagination.locator(".pagination-count");
  const more = pagination.getByRole("button", { name: /^Show \d+ more$/ });
  const desktopRows = panel.locator(".desktop-traders tbody tr");
  const mobileRows = panel.locator(".mobile-trader");
  const isDesktop = await panel.locator(".desktop-traders").isVisible();
  const rows = isDesktop ? desktopRows : mobileRows;

  await expect(count).toHaveText(`Showing 25 of ${total.toLocaleString()}`);
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  await expect(desktopRows).toHaveCount(25 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(25 - LIST_OFFSET);
  await expect(more).toBeVisible();

  // First click: the next 25, the URL, the running count, the reserved row
  // area, and focus landing on the first row that was not there before.
  await more.click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page).not.toHaveURL(/[?&]offset=/);
  const shown50 = Math.min(50, total);
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(desktopRows).toHaveCount(shown50 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(shown50 - LIST_OFFSET);
  await expect(
    rows.nth(25 - LIST_OFFSET).locator(".address-chip-link"),
  ).toBeFocused();
  await recordLayoutShifts("initial load and first growth");

  // Reload restores the exact shown count from the URL, in one request.
  await reloadFromTop(page);
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await expect(desktopRows).toHaveCount(shown50 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(shown50 - LIST_OFFSET);
  await recordLayoutShifts("50-row reload");

  // Back, after navigating away, restores the same state too.
  await rows.first().locator(".address-chip-link").click();
  await expect(page).toHaveURL(/\/wallet\//);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(count).toHaveText(
    `Showing ${shown50.toLocaleString()} of ${total.toLocaleString()}`,
  );
  await recordLayoutShifts("history restore");

  // Click through to the fixture's real ceiling: the button disappears once
  // nothing more remains, never past it, and every step keeps the layout
  // shift the button's appearing and disappearing would otherwise cause at 0.
  let shown = shown50;
  while (shown < Math.min(total, 100) && (await more.count())) {
    const next = Math.min(shown + 25, total, 100);
    await more.click();
    await expect(page).toHaveURL(new RegExp(`[?&]limit=${next}(?:&|$)`));
    await expect(count).toHaveText(
      `Showing ${next.toLocaleString()} of ${total.toLocaleString()}`,
    );
    await expect(desktopRows).toHaveCount(next - LIST_OFFSET);
    await expect(mobileRows).toHaveCount(next - LIST_OFFSET);
    await expect(
      rows.nth(shown - LIST_OFFSET).locator(".address-chip-link"),
    ).toBeFocused();
    shown = next;
  }
  if (total <= 100) await expect(more).toHaveCount(0);
  else await expect(more).toBeVisible();
  await recordLayoutShifts("growth to the ceiling");

  // Reload restores the exhausted state too: the same count, no button back.
  await reloadFromTop(page);
  await expect(count).toHaveText(
    `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`,
  );
  if (total <= 100) await expect(more).toHaveCount(0);
  else await expect(more).toBeVisible();
  await expect(desktopRows).toHaveCount(shown - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(shown - LIST_OFFSET);
  await recordLayoutShifts("ceiling reload");

  // A metric change is a fresh list: it resets the shown count to 25.
  const metric = page
    .locator("main")
    .getByRole("button", { name: "Net ETH", exact: true });
  await metric.click();
  await expect(page).not.toHaveURL(/[?&]limit=/);
  await expect(count).toHaveText(`Showing 25 of ${total.toLocaleString()}`);
  await expect(desktopRows).toHaveCount(25 - LIST_OFFSET);
  await expect(mobileRows).toHaveCount(25 - LIST_OFFSET);
  await recordLayoutShifts("metric reset");
  expect(
    layoutShifts,
    "every non-input layout shift across the whole flow",
  ).toEqual({
    "initial load and first growth": 0,
    "50-row reload": 0,
    "history restore": 0,
    "growth to the ceiling": 0,
    "ceiling reload": 0,
    "metric reset": 0,
  });

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "the show-more bar fits the viewport",
  ).toBe(true);
});

// The count line reads the same top-100 ceiling the button stops at, never
// the API's raw total (sweep s6 defect 12: "Showing 100 of 1,405" with no
// button and no way to reach the rest).
test("the trader leaderboard never requests past its 100-row cap, even when more exist", async ({
  page,
}) => {
  const seenCeilings: number[] = [];
  await page.route("**/api/product/leaderboard/**", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 0);
    seenCeilings.push(offset + limit);
    await route.fulfill({ response, json: { ...json, total: 1405 } });
  });

  await page.goto("/traders/?window=All");
  const panel = page.locator("main .leaderboard-panel");
  const pagination = panel.locator(".pagination");
  const count = pagination.locator(".pagination-count");
  const more = pagination.getByRole("button", { name: /^Show \d+ more$/ });

  await expect(count).toHaveText("Showing 25 of 100");
  await expect(count).not.toContainText("1,405");
  for (const target of [50, 75, 100]) {
    await more.click();
    await expect(page).toHaveURL(new RegExp(`[?&]limit=${target}(?:&|$)`));
    await expect(count).toHaveText(`Showing ${target.toLocaleString()} of 100`);
  }
  await expect(more).toHaveCount(0);
  await expect(
    count,
    "the count and the button agree on where the list ends",
  ).toHaveText("Showing 100 of 100");
  expect(
    Math.max(...seenCeilings),
    "no request ever asks for a row past the 100th",
  ).toBeLessThanOrEqual(100);
});

// The export's "YOU · RANK N" row above the podium: a quiet prompt until this
// browser marks a wallet as its own, then the wallet read's real rank. Both
// states hold the same height, so the panel below never moves.
const topWallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

async function settled(page: import("@playwright/test").Page) {
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
}

test("without a wallet the leaderboard's you row is the quiet prompt", async ({
  page,
}) => {
  await page.goto("/traders/?window=All");
  await settled(page);
  const row = page.locator(".my-rank");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("href", "/wallet/");
  await expect(row.locator(".my-rank-chip")).toHaveText("YOU");
  await expect(row.locator(".my-rank-summary")).toHaveText(
    "Set your wallet in the header to see your rank here",
  );
  await expect(row.locator(".my-rank-link")).toHaveText("Find your wallet →");
  await expect(row, "no rank is invented").not.toContainText(/RANK|\d/);
  await expect(row.locator(".my-rank-empty")).toHaveCount(1);
  await expect(row.locator(".avatar")).toHaveCount(0);
});

test("with a wallet marked as mine the you row reads its real rank", async ({
  page,
}, testInfo) => {
  await page.goto("/traders/?window=All");
  await settled(page);
  const row = page.locator(".my-rank");
  const panel = page.locator(".leaderboard-panel");
  const prompt = (await row.boundingBox())!;
  const panelTop = (await panel.boundingBox())!.y;
  await page.evaluate((address) => {
    localStorage.setItem("poolsinfo.my-wallet.v1", address);
    window.dispatchEvent(new Event("poolsinfo-my-wallet-changed"));
  }, topWallet);
  await settled(page);
  await expect(row).toHaveAttribute("href", `/wallet/${topWallet}/?window=All`);
  await expect(row.locator(".my-rank-address")).toHaveText("0x4745…bce1");
  await expect(row.locator(".my-rank-chip")).toHaveText("YOU · RANK 1");
  await expect(row.locator(".my-rank-summary")).toHaveText(
    "realized +0.0114711 ETH across 11 trades",
  );
  await expect(row.locator(".my-rank-summary .positive")).toHaveCSS(
    "color",
    "rgb(63, 214, 140)",
  );
  await expect(row.locator(".my-rank-link")).toHaveText("Your wallet →");
  expect(
    (await row.boundingBox())!.height,
    "the ranked row holds the prompt's height",
  ).toBe(prompt.height);
  expect(
    (await panel.boundingBox())!.y,
    "the leaderboard keeps its position",
  ).toBe(panelTop);
  expect(prompt.height).toBe(testInfo.project.name === "mobile" ? 84 : 54);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${topWallet}/`));
  await expect(page.locator(".page-heading h1")).toHaveText("Portfolio");
});

// The server paints the prompt and hydration swaps in the stored wallet, then
// its read resolves: neither step may move anything on screen.
test("a stored wallet's you row resolves with no layout shift", async ({
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
  await page.goto("/traders/?window=7d");
  await settled(page);
  const row = page.locator(".my-rank");
  await expect(row.locator(".my-rank-chip")).toHaveText("YOU · RANK 1");
  await expect(row).toHaveAttribute("href", `/wallet/${topWallet}/?window=7d`);
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

// The board's two widest figures once the real leaderboard switched on: a
// nine-digit ROI ("+457346536.31%", a zero-cost-basis wallet), which ran out
// of its 104px column and across the W/L bar beside it, and a three-digit
// win/loss pair ("307W · 263L"), which ran past its column into the trades
// count. The ROI now abbreviates past four integer digits with the exact
// figure kept in its title, and the W/L column holds the pair with its bar.
const extremeRoi = 457346536.31;
const extremeRecord = { wins: 307, losses: 263 };
// The narrowest viewport whose board still renders the table: the 896px the
// remaining columns need, inside the page's clamp(14px, 2.4vw, 32px) gutters
// and the panel's own borders.
const narrowestDesktop = 944;

for (const width of [1440, 1280, 1024, narrowestDesktop]) {
  test(`a nine-digit ROI and a three-digit W/L pair stay inside their columns at ${width}px`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "the phone rows have no columns to overrun");
    await page.route("**/api/product/leaderboard/**", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      // Ranks 1-3 sit in the podium, so the flat list's first two rows are
      // the fixture's fourth and fifth wallets; the podium's first card
      // takes the ROI too.
      const items = (json.items as Record<string, unknown>[]).map(
        (item, index) =>
          index === 0 || index === LIST_OFFSET
            ? { ...item, roi: extremeRoi }
            : index === LIST_OFFSET + 1
              ? { ...item, ...extremeRecord }
              : item,
      );
      await route.fulfill({ response, json: { ...json, items } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/traders/?window=All");
    const rows = page.locator(".desktop-traders tbody tr[data-row=resolved]");
    await expect(rows.first()).toBeVisible();

    const roi = rows.nth(0).locator("td").nth(3).locator(".change");
    await expect(roi).toHaveText("+457.3M%");
    await expect(roi).toHaveAttribute("title", "+457346536.31%");
    await expect(roi).toHaveCSS("color", "rgb(63, 214, 140)");
    await expect(
      page.locator(".trader-podium-card").first().locator(".change"),
    ).toHaveText("+457.3M%");
    const record = rows.nth(1).locator("td").nth(4).locator(".wl-text");
    await expect(record).toHaveText("307W · 263L");

    const geometry = await rows.nth(0).evaluate((node) => {
      const first = node as HTMLElement;
      const second = first.nextElementSibling as HTMLElement;
      const textRect = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      };
      const contentRight = (cell: HTMLElement) =>
        cell.getBoundingClientRect().right -
        parseFloat(getComputedStyle(cell).paddingRight);
      const overflowing = (row: HTMLElement) =>
        [...row.children]
          .slice(0, 10)
          .filter((cell) => cell.scrollWidth > cell.clientWidth)
          .map(
            (cell) =>
              `${cell.textContent} by ${cell.scrollWidth - cell.clientWidth}px`,
          );
      const roiCell = first.children[3] as HTMLElement;
      const recordCell = second.children[4] as HTMLElement;
      return {
        roiTextPastContent:
          textRect(roiCell.querySelector(".change")!).right -
          contentRight(roiCell),
        roiTextToBar:
          first.children[4].querySelector(".wl-bar")!.getBoundingClientRect()
            .left - textRect(roiCell.querySelector(".change")!).right,
        recordPastContent:
          recordCell.querySelector(".wl-record")!.getBoundingClientRect()
            .right - contentRight(recordCell),
        overflowing: [...overflowing(first), ...overflowing(second)],
        page: document.documentElement.scrollWidth,
      };
    });
    // A right-aligned run that fits ends on the content edge itself, so the
    // bound allows sub-pixel float noise and nothing more.
    expect(
      geometry.roiTextPastContent,
      "the ROI text ends inside its cell's content box",
    ).toBeLessThanOrEqual(0.01);
    expect(
      geometry.roiTextToBar,
      "the ROI text stays clear of the W/L bar",
    ).toBeGreaterThan(0);
    expect(
      geometry.recordPastContent,
      "the win/loss bar and pair end inside their cell's content box",
    ).toBeLessThanOrEqual(0);
    expect(
      geometry.overflowing,
      "no cell of either row scrolls past its width",
    ).toEqual([]);
    expect(geometry.page, "the page is the viewport's width").toBe(width);
  });
}

// A five-digit trade count, as the real board's busiest wallets carry: every
// place the board prints one takes the thousands separator the pool page's
// own trade count uses, 30,160 rather than 30160.
test("the board prints its trade counts with thousands separators", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "the phone cards print no trade count");
  const busy = { rankingTradeCount: 30160, supportedTradeCount: 30160 };
  await page.route("**/api/product/leaderboard/**", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const items = (json.items as Record<string, unknown>[]).map(
      (item, index) =>
        index === 0 || index === LIST_OFFSET ? { ...item, ...busy } : item,
    );
    await route.fulfill({ response, json: { ...json, items } });
  });
  await page.route(`**/api/product/wallets/${topWallet}**`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({
      response,
      json: { ...json, wallet: { ...json.wallet, ...busy } },
    });
  });
  await page.addInitScript((address) => {
    localStorage.setItem("poolsinfo.my-wallet.v1", address);
  }, topWallet);
  await page.goto("/traders/?window=All");
  await settled(page);
  await expect(
    page
      .locator(".trader-podium-card")
      .first()
      .locator(".trader-podium-card-record"),
  ).toContainText("30,160 trades");
  await expect(
    page
      .locator(".desktop-traders tbody tr[data-row=resolved]")
      .first()
      .locator("td")
      .nth(5),
  ).toHaveText("30,160");
  await expect(page.locator(".my-rank .my-rank-summary")).toHaveText(
    "realized +0.0114711 ETH across 30,160 trades",
  );
});
