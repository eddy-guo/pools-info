import { test, expect, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

/* The header's freshness stamp (a11y pass C4, QA sweep items 1 and 30):
   `block N · indexed Ns ago` on every page from the page's own read cut,
   the block only where the read names one, in a slot reserved from first
   paint; the divider before it and the one before the ETH price hide with
   their neighbour, keeping their width, so the strip never trails a bar. */

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
/** A clock held still, so each stamp's lag is exact rather than a shape. */
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0) / 1000;
const BLOCK = 12_845_102;
const ethPrice = {
  usdPerEth: 4218.44,
  asOf: "2026-09-29T11:59:50.000Z",
  source: "coinbase" as const,
};
type Json = Record<string, unknown>;
type Patch = (endpoint: string, json: Json) => void;

/** The fixture deployment's own answers, each named read's cut replaced by
    a fixed one, and the price served; `delivery` rides in the body. */
async function serve(page: Page, patch: Patch, price: "served" | "failed") {
  await page.route("**/api/product/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/product/prices/eth-usd/")
      return price === "served"
        ? route.fulfill({ json: ethPrice })
        : route.fulfill({
            status: 503,
            headers: { "Retry-After": "30" },
            json: { error: "price_unavailable" },
          });
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const json = (await response.json()) as Json;
    patch(url.pathname.slice("/api/product/".length), json);
    return route.fulfill({ json });
  });
}
const coverageAt = (endpoint: string, asOf: number): Patch => {
  return (name, json) => {
    if (name === endpoint || name.startsWith(`${endpoint}/`))
      (json.coverage as Json).asOf = asOf;
  };
};
const cases = [
  {
    name: "screener",
    url: "/",
    // The fixture deployment serves no stats route, so the explore rows'
    // cut (a timestamp, no block) is what the screener has to stamp.
    patch: coverageAt("explore", NOW - 8),
    stamp: "indexed 8s ago",
  },
  {
    name: "pool",
    url: poolHref(chain.markets[0]),
    patch: ((name, json) => {
      if (!name.startsWith("pools/")) return;
      const snapshot = (json.analytics as Json).snapshot as Json;
      snapshot.toBlock = BLOCK;
      snapshot.toTimestamp = NOW - 8;
    }) as Patch,
    stamp: "block 12,845,102 · indexed 8s ago",
  },
  {
    name: "traders",
    url: "/traders/?window=All",
    patch: coverageAt("leaderboard", NOW - 65),
    stamp: "indexed 1m ago",
  },
  {
    name: "creators",
    url: "/creators/",
    patch: coverageAt("creators", NOW - 3 * 3600 - 5),
    stamp: "indexed 3h ago",
  },
  {
    name: "creator",
    url: `/creators/${chain.markets[0].launchSender}/`,
    patch: coverageAt("explore", NOW - 2 * 86400),
    stamp: "indexed 2d ago",
  },
  {
    name: "wallet",
    url: `/wallet/${wallet}/?window=All`,
    patch: coverageAt(`wallets/${wallet}`, NOW - 59),
    stamp: "indexed 59s ago",
  },
];

for (const entry of cases)
  test(`${entry.name}: the strip stamps the page's own read cut`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(NOW * 1000));
    await serve(page, entry.patch, "served");
    await page.goto(entry.url);
    const stamp = page.locator(".subnav-freshness");
    /* The stamp waits on the page's own read, which a server's first
       request of the run can take past the default 5 s to answer; the slot
       stays correctly blank meanwhile. */
    await expect(stamp).toHaveText(entry.stamp, { timeout: 15_000 });
    // The exact cut in UTC rides on the lag's own <time>.
    await expect(stamp.locator("time")).toHaveAttribute(
      "title",
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/,
    );
    await expect(stamp).toHaveCSS("font-variant-numeric", "tabular-nums");
    await expect(page.locator(".subnav-freshness-divider")).toHaveCSS(
      "visibility",
      "visible",
    );
    await expect(page.locator(".subnav-eth-price")).toHaveText("ETH $4,218.44");
    await expect(page.locator(".subnav-price-divider")).toHaveCSS(
      "visibility",
      "visible",
    );
    await expect(page.locator(".network-subnav")).not.toContainText(
      /Live|as of|Updated/,
    );
  });

test("a page with no read of its own stamps nothing, and neither divider trails", async ({
  page,
}) => {
  await serve(page, () => {}, "failed");
  await page.goto("/wallet/");
  await expect(page.locator(".network-context")).toHaveText(
    "v4 · Robinhood Chain",
  );
  const stamp = page.locator(".subnav-freshness");
  await expect(stamp).toHaveText("");
  await expect(stamp.locator("time")).toHaveCount(0);
  await expect(page.locator(".subnav-freshness-divider")).toHaveCSS(
    "visibility",
    "hidden",
  );
  await expect(page.locator(".subnav-eth-price")).toHaveText("");
  await expect(page.locator(".subnav-price-divider")).toHaveCSS(
    "visibility",
    "hidden",
  );
  /* Both slots keep their reserved width while hidden: the stamp's box is
     its widest form's, the price's the rate's, so a later answer fills a
     box that was already there. */
  const widths = await page
    .locator(".network-subnav > *")
    .evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
    );
  expect(widths[2], "the stamp's reserved slot").toBeGreaterThan(245);
  expect(widths[4], "the price's reserved slot").toBeGreaterThan(90);
});

test("a client navigation swaps the stamp to the new page's cut", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW * 1000));
  const patches = [
    coverageAt("leaderboard", NOW - 65),
    coverageAt("creators", NOW - 3 * 3600 - 5),
  ];
  await serve(
    page,
    (name, json) => {
      for (const patch of patches) patch(name, json);
    },
    "served",
  );
  await page.goto("/traders/");
  const stamp = page.locator(".subnav-freshness");
  await expect(stamp).toHaveText("indexed 1m ago");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Creators" })
    .click();
  await expect(page).toHaveURL(/\/creators\/$/);
  await expect(stamp).toHaveText("indexed 3h ago");
});

test("the stamp's lag follows the clock, each reading a new node in the same slot", async ({
  page,
}) => {
  /* Held at NOW until the test moves it, so however long the read takes
     the first reading is exact; runFor then ticks the page's own timers. */
  await page.clock.install({ time: new Date((NOW - 1) * 1000) });
  await page.clock.pauseAt(new Date(NOW * 1000));
  await serve(page, coverageAt("explore", NOW - 8), "served");
  await page.goto("/");
  const stamp = page.locator(".subnav-freshness");
  await expect(stamp).toHaveText("indexed 8s ago");
  const box = await stamp.boundingBox();
  await page.clock.runFor(52_000);
  await expect(stamp).toHaveText("indexed 1m ago");
  expect(await stamp.boundingBox()).toEqual(box);
});

/* First-paint geometry against both answers the price read can give: the
   strip, its chain label, the stamp's slot and the price's slot must sit
   where they were painted, with no layout shift, whether the price lands
   or never does (the fixture deployment's own case). */
for (const price of ["served", "failed"] as const)
  test(`the strip keeps its first-paint geometry as the stamp lands and the price is ${price}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      const state = { cls: 0, shifts: [] as unknown[] };
      Object.assign(window, { stripMeasurement: state });
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const shift = raw as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
            sources?: {
              node?: Node;
              previousRect?: DOMRectReadOnly;
              currentRect?: DOMRectReadOnly;
            }[];
          };
          if (shift.hadRecentInput) continue;
          state.cls += shift.value;
          state.shifts.push({
            value: shift.value,
            sources: shift.sources?.map((source) => ({
              node:
                source.node instanceof Element
                  ? `${source.node.tagName}.${[...source.node.classList].join(".")}`
                  : source.node?.nodeName,
              previous: source.previousRect?.toJSON(),
              current: source.currentRect?.toJSON(),
            })),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/product/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/product/prices/eth-usd/") {
        await gate;
        return price === "served"
          ? route.fulfill({ json: ethPrice })
          : route.fulfill({
              status: 503,
              headers: { "Retry-After": "30" },
              json: { error: "price_unavailable" },
            });
      }
      const response = await route.fetch();
      await gate;
      return route.fulfill({ response });
    });
    const geometry = () =>
      page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const rect = (selector: string) => {
          const { x, y, width, height } = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          header: rect(".site-header"),
          strip: rect(".network-subnav"),
          context: rect(".network-context"),
          stamp: rect(".subnav-freshness"),
          price: rect(".subnav-eth-price"),
          /* Only where the content starts: its height is the page's own
             rows streaming in, nothing the strip decides. */
          mainTop: rect("#main").y,
        };
      });
    try {
      await page.goto("/", { waitUntil: "commit" });
      await expect(page.locator(".network-subnav")).toBeVisible();
      const before = await geometry();
      await page.screenshot({
        path: testInfo.outputPath(`strip-${price}-pending.png`),
      });
      release();
      const stamp = page.locator(".subnav-freshness");
      await expect(stamp).toHaveText(/^indexed \d+[smhd] ago$/);
      await expect(page.locator(".subnav-eth-price")).toHaveText(
        price === "served" ? "ETH $4,218.44" : "",
      );
      await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
      const after = await geometry();
      await page.screenshot({
        path: testInfo.outputPath(`strip-${price}-resolved.png`),
      });
      expect(
        after,
        "every box in the strip holds its first-paint place",
      ).toEqual(before);
      const measurement = await page.evaluate(
        () =>
          (
            window as unknown as {
              stripMeasurement: { cls: number; shifts: unknown[] };
            }
          ).stripMeasurement,
      );
      expect(measurement.cls, JSON.stringify(measurement.shifts)).toBeLessThan(
        0.001,
      );
    } finally {
      release();
    }
  });

test("at phone widths the stamp takes its own line inside the 44px strip, down to 320px", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await serve(page, coverageAt("explore", NOW - 8), "served");
  const measure = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const strip = document.querySelector<HTMLElement>(".network-subnav")!;
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const children = [...strip.children].map((node) => {
        const r = node.getBoundingClientRect();
        return { cls: node.className, right: r.right, top: r.top };
      });
      return {
        header: rect(".site-header").height,
        strip: strip.getBoundingClientRect().height,
        overflow: strip.scrollWidth > strip.clientWidth + 1,
        pastEdge: children
          .filter((c) => c.right > innerWidth + 1)
          .map((c) => c.cls),
        contextTop: rect(".network-context").top,
        priceTop: rect(".subnav-eth-price").top,
        stampTop: rect(".subnav-freshness").top,
      };
    });
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/");
  await expect(page.locator(".subnav-freshness")).toHaveText("indexed 8s ago");
  await expect(page.locator(".subnav-eth-price")).toHaveText("ETH $4,218.44");
  const wide = await measure();
  expect(wide.overflow, "the strip fits 390px").toBe(false);
  expect(wide.pastEdge).toEqual([]);
  expect(wide.strip, "the strip keeps its 44px").toBe(44);
  expect(wide.priceTop, "the price shares the chain's line").toBe(
    wide.contextTop,
  );
  expect(wide.stampTop, "the stamp sits on its own line").toBeGreaterThan(
    wide.contextTop,
  );
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await measure();
  expect(narrow.overflow, "the strip fits 320px").toBe(false);
  expect(narrow.pastEdge).toEqual([]);
  expect(narrow.header).toBe(wide.header);
  expect(narrow.strip).toBe(44);
  expect(narrow.priceTop).toBe(narrow.contextTop);
  expect(narrow.stampTop).toBeGreaterThan(narrow.contextTop);
});
