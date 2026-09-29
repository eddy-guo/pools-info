import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { formatMoney, poolHref } from "@pools/core";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const routes = [
  "/",
  poolHref(chain.markets[0]),
  "/traders/",
  "/creators/",
  `/creators/${chain.markets[0].launchSender.toLowerCase()}/`,
  "/wallet/",
  `/wallet/${wallet}/`,
  "/you/",
];

for (const route of routes) {
  test(`${route} keeps the shell to the network context, search and a quiet wallet placeholder`, async ({
    page,
    isMobile,
  }) => {
    await page.goto(route);
    const strip = page.locator(".network-subnav");
    await expect(strip).toBeVisible();
    await expect(page.locator(".network-context")).toHaveText(
      "v4 · Robinhood Chain",
    );
    await expect(page.locator(".subnav-live")).toHaveCount(0);
    await expect(strip).not.toContainText(/Live|Delayed|Paused|Offline/);
    /* The freshness stamp is the page's own read cut and nothing else: the
       block where the read names one, the lag from the read's timestamp,
       and blank on the lookup page, which has no read to stamp, and on the
       You page with nothing saved, which reads nothing (you.spec.ts holds
       its stamp once something is saved). */
    const stamp = page.locator(".subnav-freshness");
    await expect(stamp).toHaveCount(1);
    if (route === "/wallet/" || route === "/you/")
      await expect(stamp).toHaveText("");
    else
      await expect(stamp).toHaveText(
        /^(block \d{1,3}(,\d{3})* · )?indexed \d+[smhd] ago$/,
      );
    await expect(page.getByRole("link", { name: "Methodology" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("link", { name: "API" })).toHaveCount(0);
    await expect(page.locator('a[href="/methodology/"]')).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link")).toHaveText([
      "Pools",
      "Traders",
      "Creators",
    ]);
    await expect(page.locator(".header-actions .search-trigger")).toBeVisible();
    // The slot a connect button would take is the entry into the You page:
    // one link in both wallet states, its name carrying the saved counts.
    const connect = page.locator(".header-actions .connect-button");
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute("href", "/you/");
    await expect(connect).toHaveAccessibleName("You: nothing saved yet");
    if (route === "/you/")
      await expect(connect).toHaveAttribute("aria-current", "page");
    else await expect(connect).not.toHaveAttribute("aria-current");
    const search = await page
      .locator(".header-actions .search-trigger")
      .boundingBox();
    const box = await connect.boundingBox();
    expect(box!.x, "the placeholder sits right of search").toBeGreaterThan(
      search!.x + search!.width,
    );
    if (isMobile) {
      // Under 768 px the control is an icon-only 44 px square: its name
      // carries the label and no chip text is drawn.
      expect((await connect.innerText()).trim()).toBe("");
      expect(box!.width).toBe(44);
      expect(box!.height).toBe(44);
      const toggle = await page
        .locator(".header-actions .unit-toggle")
        .boundingBox();
      expect(
        box!.x,
        "the control clears the unit toggle",
      ).toBeGreaterThanOrEqual(toggle!.x + toggle!.width);
    } else {
      await expect(connect).toContainText("You");
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
    // Nothing saved yet: the entry carries no count, and no menu or dialog
    // hangs off the header; the page it opens is where a wallet is marked.
    await expect(connect.locator(".connect-count")).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    // The product footer was removed. Only the chart library's required
    // attribution survives it: its licence wants its NOTICE line and a link
    // to tradingview.com on a page users see, so the on-chart logo is off
    // (candles.tsx) and this plain line stands in on every route at every
    // width - text only, no mark - with nothing else left in the footer.
    const footer = page.locator(".footer");
    await expect(footer).not.toContainText("Independent analytics");
    await expect(footer).not.toContainText("Not affiliated with Uniswap");
    await expect(footer).not.toContainText("Robinhood Chain · Values in ETH");
    const credit = footer.locator(".footer-credit");
    await expect(credit).toBeVisible();
    await expect(credit).toHaveText(
      "TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/",
    );
    await expect(credit.getByRole("link")).toHaveAttribute(
      "href",
      "https://www.tradingview.com/",
    );
    await expect(credit.locator("img, svg")).toHaveCount(0);
    await expect(footer.locator("> *")).toHaveCount(1);
    // The footer directly follows the page's content: no blank region is
    // reserved where the removed disclaimer/chain-context lines used to be.
    // (.site-shell's own min-height:100vh can still leave space *below* the
    // footer on a short page; that is unrelated and untouched here.)
    const gap = await page.evaluate(() => {
      const mainBottom = document
        .querySelector("main")!
        .getBoundingClientRect().bottom;
      const footerTop = document
        .querySelector(".footer")!
        .getBoundingClientRect().top;
      return footerTop - mainBottom;
    });
    expect(gap, "no gap between the content and the footer").toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

/* No list scrolls sideways at any width. The page never measured wider than
   the viewport; the tables did, inside their own scroll boxes (the creators
   board was 1000px in a 360px box on a phone, the trader leaderboard 1095px in
   729px at 768), so every scrollable box is held to its own width too. The
   Just launched rail is a designed card carousel, the one box that may. Every
   width is pure CSS here, so one load is measured across all five. */
for (const route of routes) {
  test(`${route} fits every width without a sideways scroll`, async ({
    page,
    isMobile,
  }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const widths = isMobile
      ? [page.viewportSize()!.width]
      : [390, 768, 1024, 1280, 1440];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(async () => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const root = document.scrollingElement!;
        const boxes = [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((node) => {
            if (node.closest(".launch-rail")) return false;
            const { overflowX } = getComputedStyle(node);
            return (
              (overflowX === "auto" || overflowX === "scroll") &&
              node.scrollWidth > node.clientWidth + 1
            );
          })
          .map(
            (node) =>
              `${node.className}: ${node.scrollWidth}px in ${node.clientWidth}px`,
          );
        return { page: root.scrollWidth - root.clientWidth, boxes };
      });
      expect(overflow.page, `the page at ${width}px`).toBeLessThanOrEqual(1);
      expect(overflow.boxes, `scroll boxes at ${width}px`).toEqual([]);
    }
  });
}

/* At 320px the header's actions once ran left over the wordmark's "info.",
   which no overflow check sees since nothing scrolls. Each item must sit
   inside the viewport and the header, overlap no other item, and be the
   topmost node at its own edges, in both wallet states, while the header
   keeps the height it has at 390. */
test("the header's items fit a 320px screen without overlapping or clipping", async ({
  page,
}) => {
  const items = [
    ".brand-orbits",
    ".brand > span",
    ".header-actions .search-trigger",
    ".header-actions .unit-toggle",
    ".wallet-profile-entry",
    ".primary-nav a",
  ];
  const measure = () =>
    page.evaluate(async (selectors) => {
      await document.fonts.ready;
      const header = document
        .querySelector(".site-header")!
        .getBoundingClientRect();
      const nodes = selectors.flatMap((selector) => [
        ...document.querySelectorAll<Element>(selector),
      ]);
      const rects = nodes.map((node) => node.getBoundingClientRect());
      const problems: string[] = [];
      const name = (i: number) =>
        `${nodes[i].tagName.toLowerCase()}.${[...nodes[i].classList].join(".")} "${nodes[i].textContent?.trim()}"`;
      rects.forEach((rect, i) => {
        if (
          rect.left < 0 ||
          rect.right > innerWidth ||
          rect.top < header.top ||
          rect.bottom > header.bottom
        )
          problems.push(`${name(i)} leaves the header`);
        if (nodes[i].scrollWidth > nodes[i].clientWidth + 1)
          problems.push(`${name(i)} clips its own content`);
        const y = rect.top + rect.height / 2;
        for (const x of [rect.left + 1, rect.right - 1]) {
          const top = document.elementFromPoint(x, y);
          if (!top || !(nodes[i].contains(top) || top.contains(nodes[i])))
            problems.push(`${name(i)} is covered at x=${x}`);
        }
        rects.forEach((other, j) => {
          if (
            j > i &&
            rect.left < other.right &&
            other.left < rect.right &&
            rect.top < other.bottom &&
            other.top < rect.bottom
          )
            problems.push(`${name(i)} overlaps ${name(j)}`);
        });
      });
      return { problems, height: header.height };
    }, items);

  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/");
  const wide = await measure();
  expect(wide.problems).toEqual([]);

  for (const stored of [false, true]) {
    if (stored)
      await page.evaluate((address) => {
        localStorage.setItem("poolsinfo.my-wallet.v1", address);
      }, wallet);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    if (stored) await expect(page.locator(".wallet-chip")).toBeVisible();
    const narrow = await measure();
    expect(narrow.problems, `wallet stored: ${stored}`).toEqual([]);
    expect(narrow.height).toBe(wide.height);
  }
});

test("the H1 row carries a Trader leaderboard call to action at the right", async ({
  page,
}) => {
  await page.goto("/");
  const cta = page.locator(".page-heading .leaderboard-cta");
  await expect(cta).toHaveText("Trader leaderboard");
  await expect(cta.locator("svg")).toHaveCount(1);
  await expect(cta).toHaveAttribute("href", "/traders/");
  const heading = await page.locator(".page-heading h1").boundingBox();
  const button = await cta.boundingBox();
  expect(button!.x, "the button sits right of the H1").toBeGreaterThan(
    heading!.x + heading!.width,
  );
  await cta.click();
  await expect(page).toHaveURL(/\/traders\/$/);
});

test("the retired live-trades surface has no controls, polling, or web proxy", async ({
  page,
}) => {
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/live-trades/") requests++;
  });
  await page.clock.install();
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.clock.fastForward(16000);
  await expect(page.getByRole("heading", { name: "Live trades" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /Pause feed|Resume feed/ }),
  ).toHaveCount(0);
  await expect(page.locator(".subnav-live, .trade-stream")).toHaveCount(0);
  expect(requests, "the page never polls the retired feed").toBe(0);
  expect((await page.request.get("/api/live-trades/")).status()).toBe(404);
});

test.describe("Wallet profile entry", () => {
  const control = (page: import("@playwright/test").Page) =>
    page.locator(".header-actions .connect-button");

  test("the set-wallet dialog validates the address and the chip updates without reload", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/you/");
    const trigger = control(page);
    await page.getByRole("button", { name: "Set my wallet" }).click();
    const dialog = page.getByRole("dialog", { name: "Set my wallet" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByLabel("Your wallet address");
    await input.fill("not-an-address");
    await dialog.getByRole("button", { name: "Use this wallet" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Enter a valid 0x address.",
    );
    await expect(dialog).toBeVisible();
    const before = await trigger.boundingBox();
    await input.fill(wallet);
    await dialog.getByRole("button", { name: "Use this wallet" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toHaveAccessibleName("You: nothing saved yet");
    if (!isMobile) await expect(trigger).toContainText("0x4745…bce1");
    const after = await trigger.boundingBox();
    expect(
      after!.width,
      "the reserved box does not move when the wallet is set",
    ).toBe(before!.width);
    expect(
      await page.evaluate(() => localStorage.getItem("poolsinfo.my-wallet.v1")),
    ).toBe(wallet);
  });

  test("the connected chip links to the You page, which shows the wallet's YOU row and forgets it", async ({
    page,
  }) => {
    await page.addInitScript((address) => {
      localStorage.setItem("poolsinfo.my-wallet.v1", address);
    }, wallet);
    await page.goto("/");
    const trigger = control(page);
    await expect(trigger).toHaveAttribute("href", "/you/");
    await expect(trigger).toHaveAccessibleName("You: nothing saved yet");
    await trigger.click();
    await expect(page).toHaveURL(/\/you\/$/);
    const identity = page.locator(".you-identity");
    await expect(identity).toContainText("0x4745…bce1");
    await expect(identity).toContainText(/YOU/);
    await expect(
      identity.getByRole("link", { name: /Portfolio/ }),
    ).toHaveAttribute("href", `/wallet/${wallet}/?window=7d`);
    await identity.getByRole("button", { name: "Forget this wallet" }).click();
    await expect(identity).not.toContainText("0x4745…bce1");
    await expect(
      identity.getByRole("button", { name: "Set my wallet" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("poolsinfo.my-wallet.v1")),
    ).toBeNull();
    await expect(trigger).toContainText("You");
  });

  test("the mobile chip collapses to the identity tile only", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "desktop keeps the full chip");
    await page.addInitScript((address) => {
      localStorage.setItem("poolsinfo.my-wallet.v1", address);
    }, wallet);
    await page.goto("/");
    const trigger = control(page);
    const box = await trigger.boundingBox();
    expect(box!.width).toBe(44);
    expect(box!.height).toBe(44);
    expect((await trigger.innerText()).trim()).toBe("");
    await expect(trigger.locator(".avatar")).toBeVisible();
    await expect(trigger).toHaveAttribute("href", "/you/");
  });

  test("a stored wallet paints the connected chip on the screener with zero layout shift", async ({
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
    }, wallet);
    await page.goto("/");
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
      timeout: 20000,
    });
    await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
    await expect(control(page)).toHaveClass(/wallet-chip/);
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
});

const ethPriceFixture = {
  usdPerEth: 4218.44,
  asOf: "2026-09-17T00:00:00.000Z",
  source: "coinbase" as const,
};
const toggle = (page: import("@playwright/test").Page) =>
  page.locator(".header-actions .unit-toggle");

test.describe("ETH/USD unit toggle", () => {
  test("defaults to ETH, shows the strip's rate once the read resolves, switches figures and persists across reload", async ({
    page,
  }) => {
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: ethPriceFixture }),
    );
    await page.goto("/");
    const ethButton = toggle(page).getByRole("button", { name: "ETH" });
    const usdButton = toggle(page).getByRole("button", { name: "USD" });
    await expect(ethButton).toHaveAttribute("aria-pressed", "true");
    await expect(usdButton).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".subnav-eth-price")).toHaveText("ETH $4,218.44");
    await usdButton.click();
    await expect(usdButton).toHaveAttribute("aria-pressed", "true");
    await expect(ethButton).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(
      toggle(page).getByRole("button", { name: "USD" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("renders the exact USD value of a known wei figure on the screener", async ({
    page,
    isMobile,
  }) => {
    test.skip(!!isMobile, "the desktop table carries the figure this asserts");
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: ethPriceFixture }),
    );
    await page.goto("/");
    const row = page
      .locator(".explore-page .desktop-pools [data-row='resolved']")
      .first();
    await expect(row).toBeAttached();
    const cell = row.locator("td").nth(4).locator(".number");
    const wei = (await cell.getAttribute("title"))!.replace(" wei", "");
    await toggle(page).getByRole("button", { name: "USD" }).click();
    await expect(cell).toHaveText(
      formatMoney(wei, "USD", ethPriceFixture.usdPerEth),
    );
  });

  test("leaves ETH figures unchanged and marks USD unavailable when the price read fails", async ({
    page,
    isMobile,
  }) => {
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({
        status: 503,
        headers: { "Retry-After": "30" },
        json: { error: "price_unavailable" },
      }),
    );
    await page.goto("/");
    const usdButton = toggle(page).getByRole("button", { name: "USD" });
    await expect(usdButton).toHaveAccessibleName(/unavailable/i);
    const row = isMobile
      ? page
          .locator(".explore-page .mobile-pools [data-row='resolved']")
          .first()
      : page
          .locator(".explore-page .desktop-pools [data-row='resolved']")
          .first();
    await expect(row).toBeAttached();
    const cell = row.locator(".number").first();
    const before = await cell.innerText();
    await usdButton.click();
    await expect(usdButton).toHaveAttribute("aria-pressed", "true");
    await expect(cell).toHaveText(before);
    await expect(page.locator(".subnav-eth-price")).toHaveText("");
    await expect(page.locator(".network-subnav")).not.toContainText("$");
  });

  test("keeps four significant digits on a sub-cent USD price instead of rounding it to a cent", async ({
    page,
    isMobile,
  }) => {
    // The data side's figures audit of 29 Sep 2026, item D1: at that read's
    // ETH/USD rate of 2700.705, Hookr.fun's 5073335767828 wei is $0.0137 and
    // Prologue's price is $0.00804, and both read "$0.01" at two decimals.
    const prices = ["5073335767828", "2977000000000"];
    await page.addInitScript(() =>
      localStorage.setItem("poolsinfo.unit.v1", "USD"),
    );
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({ json: { ...ethPriceFixture, usdPerEth: 2700.705 } }),
    );
    await page.route("**/api/product/explore/**", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        items: { stats: { priceWei: string | null } }[];
      };
      let priced = 0;
      for (const item of body.items)
        if (priced < prices.length && item.stats.priceWei !== null)
          item.stats.priceWei = prices[priced++];
      await route.fulfill({ response, json: body });
    });
    await page.goto("/?sort=volume&window=All");
    const rows = page.locator(
      `.explore-page ${isMobile ? ".mobile-pools" : ".desktop-pools"} [data-row='resolved']`,
    );
    await expect(rows.nth(0).locator(".price")).toHaveText("$0.0137");
    await expect(rows.nth(1).locator(".price")).toHaveText("$0.00804");
  });
});

test("the retired methodology route lands on the screener", async ({
  page,
  request,
}) => {
  const response = await request.get("/methodology/", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe("/");
  await page.goto("/methodology/");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByRole("heading", { name: "Pools." })).toBeVisible();
});
