import { test, expect, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref, type ChainMarket } from "@pools/core";

/**
 * Loading paints skeletons, never words; a read that fails reaches the page
 * as the shared unavailable sentence, never the browser's own wording, and
 * in a place that moves nothing; and the proxy's per-visitor refusal
 * (`503 data_unavailable`, `reason: "request_limit"`) on the pool routes is
 * waited out on its own Retry-After rather than shown as an outage.
 */
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const market = chain.markets[0] as ChainMarket;

async function trackShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0, sources: [] as string[] };
    Object.assign(window, { stateShifts: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources: { node?: Node | null }[];
        };
        if (shift.hadRecentInput) continue;
        state.cls += shift.value;
        for (const source of shift.sources)
          state.sources.push(
            source.node instanceof Element
              ? `${source.node.tagName}.${source.node.className}`
              : String(source.node?.nodeName),
          );
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}
type Shifts = { cls: number; sources: string[] };
const shifts = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { stateShifts: Shifts }).stateShifts,
  );
/** Zero what hydration and the first read scored, so what follows is the
    failure's own score. */
const resetShifts = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { stateShifts: Shifts }).stateShifts;
    state.cls = 0;
    state.sources = [];
  });

test("a pending wallet paints skeleton bars, not words or dashes", async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/product/wallets/${wallet}/?**`, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(`/wallet/${wallet}/`);
    const chart = page.locator(".wallet-chart-region .chart");
    await expect(chart).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".wallet-stats .stat")).toHaveCount(5);
    const painted = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".chart-dates span, .chart-readout time, .chart-axis span, .wallet-stats .stat > strong *",
        ),
      ]
        .filter(
          (node) =>
            node.childElementCount === 0 &&
            node.textContent!.trim() !== "" &&
            getComputedStyle(node).color !== "rgba(0, 0, 0, 0)",
        )
        .map((node) => node.textContent),
    );
    expect(painted, "no text is painted while the read is pending").toEqual([]);
    await expect(
      page.locator('.chart-dates [data-pending="true"]'),
    ).toHaveCount(4);
    await expect(
      page.locator('.chart-readout time[data-pending="true"]'),
    ).toHaveCount(1);
  } finally {
    release();
  }
  await expect(
    page.locator('.chart-readout time[data-pending="true"]'),
  ).toHaveCount(0);
});

const reQueries = [
  {
    name: "traders",
    url: "/traders/?window=7d",
    read: "**/api/product/leaderboard/**",
    to: "30d",
    dimmed: ".leaderboard-panel .live-podium",
    resolved: ".leaderboard-panel .live-podium",
  },
  {
    name: "wallet",
    url: `/wallet/${wallet}/`,
    read: `**/api/product/wallets/${wallet}/?**`,
    to: "7d",
    dimmed: ".wallet-stats .stat",
    resolved: ".wallet-stats",
  },
];
for (const c of reQueries)
  test(`${c.name}: a failed window change keeps the figures under the shared sentence and moves nothing`, async ({
    page,
  }) => {
    await trackShifts(page);
    let mode: "pass" | "fail" = "pass";
    await page.route(c.read, async (route) => {
      if (mode === "pass") return route.continue();
      /* Past the half second Chrome leaves unscored after the click, as a
         dropped connection or a timed-out read lands. */
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.abort("internetdisconnected");
    });
    await page.goto(c.url);
    await expect(
      page.locator(`${c.resolved} [data-pending="true"]`),
    ).toHaveCount(0, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await resetShifts(page);

    mode = "fail";
    await page
      .getByRole("button", { name: c.to, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const alert = page.locator(".stale-unavailable [role=alert]");
    await expect(alert).toHaveText(/Live data is unavailable\./, {
      timeout: 10000,
    });
    await expect(page.getByText("Failed to fetch")).toHaveCount(0);
    await expect(page.locator(c.dimmed).first()).toHaveCSS("opacity", "0.55");
    const failed = await shifts(page);
    expect(failed.cls, failed.sources.join(", ")).toBeLessThan(0.001);

    mode = "pass";
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.locator(c.dimmed).first()).toHaveCSS("opacity", "1");
    const recovered = await shifts(page);
    expect(recovered.cls, recovered.sources.join(", ")).toBeLessThan(0.001);
  });

test("traders: a failed Show more says so in its own foot", async ({
  page,
}) => {
  let mode: "pass" | "fail" = "pass";
  await page.route("**/api/product/leaderboard/**", async (route) => {
    if (mode === "fail") return route.abort("internetdisconnected");
    /* The fixture ranks 52 wallets; name a longer board so a Show more is
       offered past the first page. */
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, total: 100 } });
  });
  await page.goto("/traders/?window=7d");
  const foot = page.locator(".leaderboard-panel .pagination");
  await expect(foot.locator(".pagination-count")).toHaveText(
    "Showing 25 of 100",
  );
  mode = "fail";
  await foot.getByRole("button", { name: "Show 25 more" }).click();
  await expect(foot.locator(".pagination-count")).toHaveText(
    "Live data is unavailable.",
  );
  await expect(foot.locator("[role=alert]")).toHaveCount(1);
  await expect(page.locator(".stale-unavailable")).toHaveCount(0);
  await expect(page.getByText("Failed to fetch")).toHaveCount(0);
});

test("pool page: a request_limit refusal is waited out and the market lands", async ({
  page,
}) => {
  const updated = structuredClone(chain);
  updated.markets[0].priceWei = "2000000000000000000";
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  const asked: number[] = [];
  await page.route(`**/api/markets/${market.id}/?*`, async (route) => {
    asked.push(Date.now());
    if (asked.length === 1)
      return route.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        json: { error: "data_unavailable", reason: "request_limit" },
      });
    await route.fulfill({ json: updated });
  });
  await page.goto(poolHref(market));
  await expect(page.locator(".live-price-heading .price")).toHaveText("2 ETH", {
    timeout: 15000,
  });
  expect(asked).toHaveLength(2);
  expect(
    asked[1] - asked[0],
    "the second read waited the refusal's own Retry-After",
  ).toBeGreaterThanOrEqual(900);
  await expect(
    page.locator("[role=alert]").filter({ hasText: /unavailable/i }),
  ).toHaveCount(0);
});

test("pool page: a refusal that outlasts the minute is not waited out and shows no outage", async ({
  page,
}) => {
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  let asked = 0;
  await page.route(`**/api/markets/${market.id}/?*`, (route) => {
    asked++;
    return route.fulfill({
      status: 503,
      headers: { "Retry-After": "120" },
      json: { error: "data_unavailable", reason: "request_limit" },
    });
  });
  await page.goto(poolHref(market));
  await expect(
    page.getByRole("heading", { name: market.name, exact: true }),
    "the pool keeps the identity its own read named",
  ).toBeVisible();
  await expect.poll(() => asked).toBe(1);
  await page.waitForTimeout(1500);
  expect(asked, "a wait past the ceiling is not attempted").toBe(1);
  await expect(
    page.locator("main [role=alert]").filter({ hasText: /unavailable/i }),
  ).toHaveCount(0);
});
